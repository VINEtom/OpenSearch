import { randomUUID } from 'node:crypto';
import { DOCUMENT_CATEGORIES, RECORD_TYPES, SOURCES, TYPE_SOURCES, type MatchField, type PatientAgeFilter, type PatientCatalogCondition, type PatientSearchFilters, type RecordDocument, type RecordType, type SearchParams, type SearchResponse, type SearchType, type SimulationSearchFilters, type Source } from '../shared/types.js';
import { AppError } from './errors.js';
import { BATCH_PATTERN, resolveBatch } from './index-state.js';
import { diagnosisValueSet, nasopharynxValueSet } from './diagnosis-terminology.js';
import { birthDateRange } from './patient-query.js';
import { predictDiagnosisFilters, predictPatientConditions, rerankHits } from './search-models.js';
import { patientSearchCatalog, patientSearchFieldById, patientSexLabels } from '../shared/patient-search-catalog.js';
import { config } from './config.js';
import { documentNumericLabels, fieldOwners } from './document-field-query.js';
import { readableText } from './sources/text.js';
import { predictDocumentCondition } from './document-bert-query.js';
import { osRequest } from './opensearch.js';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const allowedParams = new Set(['q', 'scope', 'patientId', 'source', 'type', 'page', 'batchId']);
const documentCategories = new Set<string>(DOCUMENT_CATEGORIES);
export type NormalizedSearch = Required<Pick<SearchParams, 'q' | 'scope' | 'source' | 'page'>> & { type: SearchType } & Pick<SearchParams, 'patientId' | 'batchId'>;

export function validateSearchParams(input: Record<string, unknown>): NormalizedSearch {
  for (const key of Object.keys(input)) if (!allowedParams.has(key)) throw new AppError('INVALID_QUERY', '查询包含不支持的参数。');
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && typeof value !== 'string' && !(key === 'page' && typeof value === 'number')) throw new AppError('INVALID_QUERY', '查询参数格式不正确。');
  }
  const q = typeof input.q === 'string' ? input.q.trim() : '';
  if (!q || q.length > 200) throw new AppError('INVALID_QUERY', '请输入 1～200 个字符的搜索内容。');
  const scope = input.scope ?? 'all';
  const source = input.source ?? 'all';
  const type = input.type ?? 'all';
  if (scope !== 'all' && scope !== 'patient') throw new AppError('INVALID_QUERY', '患者范围不正确。');
  if (source !== 'all' && !SOURCES.includes(source as Source)) throw new AppError('INVALID_QUERY', '数据来源不正确。');
  const category = documentCategories.has(String(type));
  if (type !== 'all' && !category && !RECORD_TYPES.includes(type as RecordType)) throw new AppError('INVALID_QUERY', '对象类型不正确。');
  const typeSource = category ? 'emr' : type === 'all' ? null : TYPE_SOURCES[type as RecordType];
  if (source !== 'all' && typeSource && typeSource !== source) throw new AppError('INVALID_QUERY', '该来源不包含所选对象类型。');
  const patientId = scope === 'patient' ? String(input.patientId || '').toLowerCase() : undefined;
  if (scope === 'patient' && !UUID_PATTERN.test(patientId!)) throw new AppError('INVALID_QUERY', '请先选择当前患者。');
  const page = input.page === undefined ? 1 : Number(input.page);
  if (!Number.isInteger(page) || page < 1 || page > 500) throw new AppError('INVALID_QUERY', '页码不正确；请在前 10000 条结果内查看，或缩小范围。');
  const batchId = input.batchId as string | undefined;
  if (batchId !== undefined && !BATCH_PATTERN.test(batchId)) throw new AppError('BATCH_UNAVAILABLE', '原查询批次已不可用，请重新查询。', 409);
  return { q, scope, source: source as Source | 'all', type: type as SearchType, page, ...(patientId ? { patientId } : {}), ...(batchId ? { batchId } : {}) };
}

const textFields = {
  title: { boost: 4, highlight: { number_of_fragments: 0 } },
  patientName: { boost: 4, highlight: { number_of_fragments: 0 } },
  documentType: { boost: 2, highlight: { number_of_fragments: 0 } },
  bodyText: { boost: 1, highlight: { fragment_size: 200, number_of_fragments: 1, boundary_scanner: 'sentence' } },
  patientProfile: { boost: 2, highlight: { fragment_size: 120, number_of_fragments: 1 } },
};

function literalSubstringPattern(value: string) {
  return '*' + value.replace(/[\\*?]/gu, '\\$&') + '*';
}

function keywordSexCode(query: string) {
  const value = query.toLowerCase();
  return Object.keys(patientSexLabels).find(code => code === value || patientSexLabels[code] === value);
}

export function buildSearchQuery(params: NormalizedSearch, openMarker: string, closeMarker: string, patientFilters?: PatientSearchFilters, simulationFilters?: SimulationSearchFilters, clue?: string, sex?: string, catalogConditions?: PatientCatalogCondition[], ageFilter?: PatientAgeFilter, diagnosisTitle?: string) {
  const fields = Object.entries(textFields);
  const singleHan = /^\p{Script=Han}$/u.test(params.q);
  const queryFields = fields.map(([field, options]) => `${field}^${options.boost}`);
  const highlightFields = fields.map(([field, options]) => [field, options.highlight]);
  if (singleHan) {
    for (const [field, options] of fields) {
      queryFields.push(`${field}.han^${options.boost}`);
      highlightFields.push([`${field}.han`, options.highlight]);
    }
  }
  const filters: unknown[] = [];
  if (params.scope === 'patient') filters.push({ term: { patientId: params.patientId } });
  if (params.source !== 'all') filters.push({ term: { source: params.source } });
  const resultWindow = {
    from: (params.page - 1) * 20,
    size: 20,
    track_total_hits: true,
    _source: { excludes: ['diagnosisFilters', 'simulationSourceFields'] },
    ...(params.type === 'all' ? {} : { post_filter: documentCategories.has(params.type) ? { term: { 'documentType.keyword': params.type } } : { term: { recordType: params.type } } }),
    aggs: {
      types: { terms: { field: 'recordType', size: RECORD_TYPES.length } },
      documentTypes: { terms: { field: 'documentType.keyword', size: 30 } },
    },
  };
  if (diagnosisTitle) {
    return {
      ...resultWindow,
      query: { bool: { filter: [
        ...filters,
        { term: { recordType: 'diagnosis' } },
        { term: { 'title.keyword': diagnosisTitle } },
      ] } },
      sort: [{ updatedAt: 'desc' }, { id: 'asc' }],
    };
  }
  if (simulationFilters) {
    return {
      ...resultWindow,
      query: { bool: { filter: [
        ...filters,
        ...(!simulationFilters.documentType ? [{ term: { recordType: 'document' } }] : []),
        { term: { 'documentType.keyword': simulationFilters.documentType ?? '定位申请单' } },
        ...(simulationFilters.imagingModality ? [{ term: { imagingModality: simulationFilters.imagingModality } }] : []),
        ...(simulationFilters.localizationSite ? [{ term: { localizationSites: simulationFilters.localizationSite } }] : []),
        ...(simulationFilters.fields ?? []).map(({ label, operator, value, numeric }, index) => {
          const pattern = operator === 'contains' ? literalSubstringPattern(value) : undefined;
          const predicate = pattern !== undefined ? { bool: {
            minimum_should_match: 1,
            should: [
              { wildcard: { 'recordFields.value.literal': { value: pattern } } },
              { wildcard: { 'recordFields.value': { value: pattern } } },
              { bool: {
                must_not: [{ exists: { field: 'recordFields.value.literal' } }, { exists: { field: 'recordFields.value' } }],
                filter: [{ match_phrase: { 'recordFields.value.text': value } }],
              } },
            ],
          } }
            : operator !== 'eq' ? { range: { 'recordFields.numericValue': { [operator]: Number(value) } } }
            : numeric ? { term: { 'recordFields.numericValue': Number(value) } }
            : { term: { 'recordFields.value': value } };
          return { nested: { path: 'recordFields', query: { bool: { filter: [{ term: { 'recordFields.label': label } }, predicate] } },
            inner_hits: { name: `simulationField${index}`, size: 3 } } };
        }),
      ], ...(clue ? { should: [{ match: { bodyText: clue } }] } : {}) } },
      sort: [...(clue ? [{ _score: 'desc' }] : []), { updatedAt: 'desc' }, { id: 'asc' }],
    };
  }
  if (ageFilter || catalogConditions?.length || sex) {
    const conditions = (catalogConditions ?? []).map(condition => {
      const field = patientSearchFieldById.get(condition.id);
      if (!field) throw new AppError('INVALID_QUERY', '患者筛选字段无效。');
      if (field.indexField) return { term: { [field.indexField]: condition.value } };
      return { nested: { path: 'patientFields', ignore_unmapped: true, query: { bool: { filter: [
        { term: { 'patientFields.label': field.label } },
        { term: { 'patientFields.value': condition.value } },
      ] } } } };
    });
    return {
      ...resultWindow,
      query: { bool: { filter: [
        ...filters,
        { term: { recordType: 'patient' } },
        ...(ageFilter ? [{ range: { birthDate: birthDateRange(ageFilter) } }] : []),
        ...(sex ? [{ term: { sex } }] : []),
        ...conditions,
      ] } },
      sort: [{ radiotherapyNo: 'asc' }, { id: 'asc' }],
    };
  }
  if (patientFilters) {
    const { diagnosis, diagnosedFrom, diagnosedThrough, minimumFractions } = patientFilters;
    const valueSet = diagnosisValueSet(diagnosis);
    const exactName = patientFilters.indexedDiagnosisTitles?.length
      ? { terms: { 'diagnosisFilters.name': patientFilters.indexedDiagnosisTitles } }
      : { term: { 'diagnosisFilters.name': diagnosis } };
    const coding = valueSet ? { bool: {
      should: [
        ...valueSet.compose.include.map(group => ({ bool: { filter: [
          { term: { 'diagnosisFilters.codingSystem': group.system } },
          { terms: { 'diagnosisFilters.code': group.concept.map(concept => concept.code) } },
        ] } })),
        ...(valueSet === nasopharynxValueSet ? [{ bool: { filter: [
          { term: { 'diagnosisFilters.codingSystem': 'DEMO-ONCOLOGY' } },
          { term: { 'diagnosisFilters.code': 'DEMO-NPC' } },
        ] } }] : []),
      ],
      minimum_should_match: 1,
    } } : exactName;
    return {
      ...resultWindow,
      query: { bool: { filter: [
        ...filters,
        { term: { recordType: 'patient' } },
        { nested: { path: 'diagnosisFilters', score_mode: 'none', query: { bool: { filter: [
          coding,
          { range: { 'diagnosisFilters.diagnosedOn': { gte: diagnosedFrom, lte: diagnosedThrough } } },
          ...(minimumFractions === undefined ? [] : [{ range: { 'diagnosisFilters.maxPrescribedFractions': { gte: minimumFractions } } }]),
        ] } } } },
      ] } },
      sort: [{ radiotherapyNo: 'asc' }, { id: 'asc' }],
    };
  }
  const keywordSex = keywordSexCode(params.q);
  return {
    ...resultWindow,
    track_scores: true,
    query: { bool: {
      filter: filters,
      should: [
        ...(keywordSex ? [{ bool: { filter: [{ term: { recordType: 'patient' } }],
          must: [{ term: { sex: { value: keywordSex, boost: 10 } } }] } }] : []),
        ...['radiotherapyNo', 'recordNo', 'code'].map(field => ({ term: { [field]: { value: params.q, boost: 10 } } })),
        { nested: { path: 'patientFields', score_mode: 'max', query: { term: { 'patientFields.value': { value: params.q, boost: 10 } } } } },
        { nested: { path: 'recordFields', score_mode: 'max', query: { term: { 'recordFields.value': { value: params.q, boost: 10 } } } } },
        { multi_match: { query: params.q, fields: queryFields, type: 'best_fields', operator: 'and' } },
      ],
      minimum_should_match: 1,
    } },
    sort: [
      { _script: { type: 'number', order: 'desc', script: {
        lang: 'painless', params: { q: params.q },
        source: "for (def f : ['radiotherapyNo', 'recordNo', 'code']) { if (doc[f].size() != 0 && doc[f].value.equals(params.q)) return 1; } return 0;",
      } } },
      { _score: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' },
    ],
    highlight: {
      pre_tags: [openMarker], post_tags: [closeMarker], require_field_match: true,
      fields: Object.fromEntries(highlightFields),
    },
  };
}

export function parseMarkedHighlight(value: string, openMarker: string, closeMarker: string): Pick<MatchField, 'text' | 'ranges'> {
  let text = '';
  let cursor = 0;
  const ranges: [number, number][] = [];
  while (cursor < value.length) {
    const start = value.indexOf(openMarker, cursor);
    if (start < 0) { text += value.slice(cursor); break; }
    const end = value.indexOf(closeMarker, start + openMarker.length);
    if (end < 0) { text += value.slice(cursor); break; }
    text += value.slice(cursor, start);
    const from = text.length;
    text += value.slice(start + openMarker.length, end);
    if (text.length > from) ranges.push([from, text.length]);
    cursor = end + closeMarker.length;
  }
  return { text, ranges };
}

const titleLabels: Record<RecordType, string> = { patient: '姓名', diagnosis: '诊断名称', plan_request: '申请单标题', treatment_plan: '计划名称', document: '单据标题' };
const bodyLabels: Record<RecordType, string> = { patient: '资料', diagnosis: '诊断说明', plan_request: '申请内容', treatment_plan: '计划备注', document: '正文' };
const snippetLimit = 120;
const snippetBefore = 28;

/** Keep a short window around the first match when the source text is a long passage. */
export function clipMatch(text: string, ranges: [number, number][]): { text: string; ranges: [number, number][] } {
  if (text.length <= snippetLimit) return { text, ranges };
  let start = Math.max(0, ranges[0][0] - snippetBefore);
  let end = Math.min(text.length, Math.max(start + snippetLimit, ranges[0][1]));
  if (start > 0) {
    const boundary = text.indexOf(' ', start);
    if (boundary !== -1 && boundary < ranges[0][0]) start = boundary + 1;
  }
  if (end < text.length) {
    const boundary = text.lastIndexOf(' ', end);
    if (boundary > ranges[0][1]) end = boundary;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text.slice(start, end);
  const shift = prefix.length - start;
  const next = ranges
    .filter(([from, to]) => from < end && to > start)
    .map(([from, to]) => [Math.max(prefix.length, from + shift), Math.min(prefix.length + body.length, to + shift)] as [number, number])
    .filter(([from, to]) => to > from);
  return { text: prefix + body + suffix, ranges: next };
}

/** Clean a highlighter fragment, then keep the same short window used for stored fields. */
export function presentMarkedFragment(fragment: string, openMarker: string, closeMarker: string): { text: string; ranges: [number, number][] } | undefined {
  const parsed = parseMarkedHighlight(readableText(fragment), openMarker, closeMarker);
  if (!parsed.ranges.length) return undefined;
  return clipMatch(parsed.text, parsed.ranges);
}

export function matchedPatientFields(query: string, fields: { label: string; value: string }[] = []): MatchField[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: MatchField[] = [];
  for (const field of fields) {
    const text = readableText(field.value);
    const lower = text.toLocaleLowerCase();
    const ranges: [number, number][] = [];
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
    if (ranges.length) matches.push({ field: 'patientFields', label: field.label, ...clipMatch(text, ranges) });
  }
  return matches;
}

export function matchedPatientConditions(record: RecordDocument, conditions: PatientCatalogCondition[]): MatchField[] {
  const matches: MatchField[] = [];
  for (const condition of conditions) {
    const entry = patientSearchFieldById.get(condition.id);
    if (!entry) continue;
    const field = entry.indexField?.split('.')[0] ?? 'patientFields';
    const value = field === 'patientFields'
      ? record.patientFields?.find(item => item.label === entry.label && item.value === condition.value)?.value
      : record[field as keyof RecordDocument];
    if (value !== condition.value) continue;
    const text = field === 'sex' ? patientSexLabels[value] ?? value : value;
    matches.push({ field, label: entry.label, text, ranges: [[0, text.length]] });
  }
  return matches;
}

export function fieldLabel(field: string, type: RecordType): string {
  if (field === 'title') return titleLabels[type];
  if (field === 'bodyText') return bodyLabels[type];
  return ({ patientName: '患者姓名', radiotherapyNo: '放疗号', recordNo: '记录编号', code: '诊断编码', documentType: '单据类型' } as Record<string, string>)[field] || field;
}

interface EngineResponse {
  timed_out?: boolean;
  _shards: { failed: number };
  hits: { total: { value: number; relation: string }; hits: { _source: RecordDocument; highlight?: Record<string, string[]>; inner_hits?: { [name: string]: { hits: { hits: { _source?: { label?: string; value?: string } }[] } } | undefined; patientFields?: { hits: { hits: { _source?: { label?: string; value?: string } }[] } }; recordFields?: { hits: { hits: { _source?: { label?: string; value?: string } }[] } } } }[] };
  aggregations: { types: { buckets: { key: RecordType; doc_count: number }[] }; documentTypes?: { buckets: { key: string; doc_count: number }[] } };
}

export function assertCompleteResponse(response: Pick<EngineResponse, 'timed_out' | '_shards' | 'hits'>): void {
  if (response.timed_out || !response._shards || response._shards.failed !== 0 || response.hits?.total?.relation !== 'eq') {
    throw new AppError('SEARCH_UNAVAILABLE', '本次搜索未完整完成，请重试。', 503);
  }
}

async function hasKeywordEvidence(index: string, params: NormalizedSearch) {
  const value = params.q;
  const pattern = literalSubstringPattern(value);
  const query = { bool: {
    filter: [
      ...(params.scope === 'patient' ? [{ term: { patientId: params.patientId } }] : []),
      ...(params.source !== 'all' ? [{ term: { source: params.source } }] : []),
    ],
    should: [
      ...['radiotherapyNo', 'recordNo', 'code', 'patientName.keyword', 'title.keyword', 'documentType.keyword']
        .map(field => ({ term: { [field]: value } })),
      ...['patientFields', 'recordFields'].map(path => ({
        nested: { path, query: { wildcard: { [path + '.value']: { value: pattern } } } },
      })),
      ...['bodyText', 'patientProfile'].map(field => ({ match_phrase: { [field]: value } })),
    ],
    minimum_should_match: 1,
  } };
  const response = await osRequest<{ count: number; _shards: { failed: number } }>(
    `/${encodeURIComponent(index)}/_count`, 'POST', { query });
  if (response._shards.failed) throw new AppError('SEARCH_UNAVAILABLE', '搜索暂时不可用，请重试。', 503);
  return response.count > 0;
}

async function completeIndexedValue(index: string, query: string, fragment: string, label: string,
  owner: { field: 'documentType.keyword' | 'recordType'; value: string }, path: 'recordFields' | 'patientFields', contains = false) {
  const chars = Array.from(query);
  const variants = new Set<string>();
  const normalizedFragment = fragment.normalize('NFKC');
  for (let start = 0; start < chars.length; start++) {
    for (let end = start + 1; end <= chars.length; end++) {
      const value = chars.slice(start, end).join('').trim();
      if (value && value.normalize('NFKC').includes(normalizedFragment)) variants.add(value);
    }
  }
  if (!variants.size) return undefined;
  const response = await osRequest<{ aggregations: { fields: { matching: { values: { buckets: { key: string }[]; sum_other_doc_count: number } } } } }>(
    `/${encodeURIComponent(index)}/_search?allow_partial_search_results=false`, 'POST', {
      size: 0,
      query: { term: { [owner.field]: owner.value } },
      aggs: { fields: { nested: { path }, aggs: { matching: { filter: { bool: { filter: [
        { term: { [path + '.label']: label } },
        contains ? { wildcard: { [path + '.value']: { value: literalSubstringPattern(fragment) } } }
          : { terms: { [path + '.value']: [...variants] } },
      ] } }, aggs: { values: { terms: { field: path + '.value', size: contains ? 4096 : variants.size } } } } } } },
    });
  const matches = response.aggregations.fields.matching.values;
  if (matches.sum_other_doc_count) return undefined;
  const indexed = matches.buckets.map(bucket => bucket.key);
  const values = contains
    ? [...variants].filter(value => indexed.some(original => original.includes(value)))
    : indexed;
  const maximal = values.filter(value => !values.some(other => other !== value && other.includes(value)));
  return maximal.length === 1 ? maximal[0] : undefined;
}

export async function searchRecords(input: SearchParams): Promise<SearchResponse> {
  const params = validateSearchParams(input as unknown as Record<string, unknown>);
  const started = performance.now();
  try {
    const batch = await resolveBatch(params.batchId);
    let keywordEvidence: Promise<boolean> | undefined;
    const keywordMatch = () => keywordEvidence ??= hasKeywordEvidence(batch.index, params);
    let scoped = config.documentBertDir && params.source !== 'pms' && params.source !== 'rvs'
      ? await predictDocumentCondition(params.q, (type, label, fragment) =>
        completeIndexedValue(batch.index, params.q, fragment, label,
          { field: 'documentType.keyword', value: type }, 'recordFields', true)) : undefined;
    if (scoped && await keywordMatch()) scoped = undefined;
    if (scoped === 'unavailable') throw new AppError('DOCUMENT_MODEL_UNAVAILABLE', '单据筛选暂不可用，请稍后重试。', 503);
    if (scoped === 'review') throw new AppError('INVALID_QUERY', '请明确单据类型，并填写一个字段筛选条件。');
    const simulationFilters: SimulationSearchFilters | undefined = scoped ? {
      documentType: scoped.type,
      fields: await Promise.all(scoped.conditions.map(async condition => {
        const numeric = documentNumericLabels.get(scoped.type)?.has(condition.label)
          && (condition.operator !== 'eq' || Number.isFinite(Number(condition.value)));
        const value = (condition.operator === 'eq' || condition.operator === 'contains') && !numeric && batch.meta.supportsDocumentFieldConditions
          ? await completeIndexedValue(batch.index, params.q, condition.value, condition.label,
            { field: 'documentType.keyword', value: scoped.type }, 'recordFields', condition.operator === 'contains') ?? condition.value : condition.value;
        return { ...condition, value, numeric };
      })),
    } : undefined;
    if (simulationFilters && !batch.meta.supportsDocumentFieldConditions) {
      return {
        ...params, simulationFilters, simulationFiltersNeedSync: true, pageSize: 20, total: 0,
        typeCounts: Object.fromEntries(RECORD_TYPES.map(type => [type, 0])) as Record<RecordType, number>,
        categoryCounts: {}, batchId: batch.meta.batchId, syncedAt: batch.meta.syncedAt, hits: [],
        elapsedMs: Math.round(performance.now() - started),
      };
    }
    const canUseCatalog = params.source !== 'emr' && params.source !== 'rvs';
    let diagnosis = !simulationFilters && canUseCatalog ? await predictDiagnosisFilters(params.q, batch.index) : undefined;
    if (diagnosis && diagnosis !== 'keyword' && await keywordMatch()) diagnosis = 'keyword';
    const diagnosisTitle = diagnosis && typeof diagnosis === 'object' && 'diagnosisTitle' in diagnosis ? diagnosis.diagnosisTitle : undefined;
    const patientFilters = diagnosis && typeof diagnosis === 'object' && 'diagnosedFrom' in diagnosis ? diagnosis : undefined;
    let catalogConditions = !simulationFilters && (!diagnosis || diagnosis === 'review') && canUseCatalog
      ? await predictPatientConditions(params.q, (label, fragment) =>
        completeIndexedValue(batch.index, params.q, fragment, label,
          { field: 'recordType', value: 'patient' }, 'patientFields')) : undefined;
    if (catalogConditions && await keywordMatch()) catalogConditions = undefined;
    if (Array.isArray(catalogConditions)
      && !patientSearchCatalog.some(field => params.q.includes(field.label))
      && [...fieldOwners.keys()].some(label => params.q.includes(label))) {
      catalogConditions = 'review';
    }
    if (diagnosis === 'review') {
      const condition = Array.isArray(catalogConditions) && catalogConditions.length === 1 ? catalogConditions[0] : undefined;
      const named = patientSearchCatalog.filter(entry => params.q.includes(entry.label));
      const field = condition && (named.length === 1 ? named[0] : patientSearchFieldById.get(condition.id));
      let value: string | undefined;
      if (field && condition && params.q.includes(field.label)) {
        if (field.indexField) {
          const response = await osRequest<{ count: number; _shards: { failed: number } }>(
            `/${encodeURIComponent(batch.index)}/_count`, 'POST', { query: { bool: { filter: [
              { term: { recordType: 'patient' } }, { term: { [field.indexField]: condition.value } },
            ] } } });
          if (!response._shards.failed && response.count > 0) value = condition.value;
        } else {
          value = await completeIndexedValue(batch.index, params.q, condition.value, field.label,
            { field: 'recordType', value: 'patient' }, 'patientFields');
        }
      }
      if (value === undefined || !condition) {
        throw new AppError('INVALID_QUERY', '请输入完整诊断名称，或明确的确诊病种和日期范围。');
      }
      catalogConditions = [{ id: field!.id, value }];
    }
    if (catalogConditions === 'review' || (catalogConditions && catalogConditions.length !== 1)) {
      throw new AppError('PATIENT_QUERY_NEEDS_DETAIL', '请填写一个明确的患者筛选条件，或直接输入关键词。');
    }
    if (catalogConditions && diagnosis !== 'review') {
      const [condition] = catalogConditions;
      const mentionedFields = patientSearchCatalog.filter(field => params.q.includes(field.label));
      const namedFields = mentionedFields.filter(field => !mentionedFields.some(other =>
        other.id !== field.id && other.label.includes(field.label)));
      const field = namedFields.length === 1 ? namedFields[0] : patientSearchFieldById.get(condition.id);
      if (field && !field.indexField) {
        const value = await completeIndexedValue(batch.index, params.q, condition.value, field.label,
          { field: 'recordType', value: 'patient' }, 'patientFields');
        if (value !== undefined) catalogConditions = [{ id: field.id, value }];
      } else if (field?.indexField === 'patientName.keyword' && field.id !== condition.id) {
        const response = await osRequest<{ count: number }>(
          `/${encodeURIComponent(batch.index)}/_count`, 'POST', { query: { bool: { filter: [
            { term: { recordType: 'patient' } }, { term: { [field.indexField]: condition.value } },
          ] } } });
        if (response.count > 0) catalogConditions = [{ ...condition, id: field.id }];
      }
    }
    const marker = randomUUID();
    const openMarker = `\uE000${marker}\uE001`;
    const closeMarker = `\uE002${marker}\uE003`;
    const response = await osRequest<EngineResponse>(`/${encodeURIComponent(batch.index)}/_search?allow_partial_search_results=false`, 'POST', buildSearchQuery(params, openMarker, closeMarker, patientFilters, simulationFilters, undefined, undefined, catalogConditions, undefined, diagnosisTitle));
    assertCompleteResponse(response);
    const typeCounts = Object.fromEntries(RECORD_TYPES.map(type => [type, 0])) as Record<RecordType, number>;
    for (const bucket of response.aggregations.types.buckets) typeCounts[bucket.key] = bucket.doc_count;
    const categoryCounts: Record<string, number> = { patient: typeCounts.patient, diagnosis: typeCounts.diagnosis };
    for (const bucket of response.aggregations.documentTypes?.buckets ?? []) categoryCounts[bucket.key] = bucket.doc_count;
    const hits = response.hits.hits.map(hit => {
      const record = hit._source;
      const matchedFields = catalogConditions ? matchedPatientConditions(record, catalogConditions) : [];
      if (diagnosisTitle && record.title === diagnosisTitle) {
        matchedFields.push({ field: 'title', label: titleLabels.diagnosis, text: record.title, ranges: [[0, record.title.length]] });
      }
      for (const field of ['radiotherapyNo', 'recordNo', 'code'] as const) {
        const value = record[field];
        if (value === params.q) matchedFields.push({ field, label: fieldLabel(field, record.recordType), text: value, ranges: [[0, value.length]] });
      }
      const isKeyword = !diagnosisTitle && !patientFilters && !catalogConditions && !simulationFilters;
      if (isKeyword && record.recordType === 'patient' && record.sex && record.sex === keywordSexCode(params.q)) {
        const text = patientSexLabels[record.sex] ?? record.sex;
        matchedFields.push({ field: 'sex', label: '性别', text, ranges: [[0, text.length]] });
      }
      if (isKeyword) {
        for (const field of ['patientFields', 'recordFields'] as const) {
          const exact = record[field]?.filter(entry => entry.value === params.q);
          for (const match of matchedPatientFields(params.q, exact)) matchedFields.push({ ...match, field });
        }
      }
      for (const field of Object.keys(textFields)) {
        const fragment = hit.highlight?.[`${field}.han`]?.[0] ?? hit.highlight?.[field]?.[0];
        if (!fragment) continue;
        if (field === 'patientProfile') {
          for (const match of matchedPatientFields(params.q, record.patientFields)) {
            if (!matchedFields.some(existing => existing.label === match.label && existing.text === match.text)) matchedFields.push(match);
          }
          continue;
        }
        if (field === 'bodyText' && record.recordFields?.length) {
          const matches = matchedPatientFields(params.q, record.recordFields);
          if (matches.length) {
            for (const match of matches) {
              if (!matchedFields.some(existing => existing.label === match.label && existing.text === match.text)) matchedFields.push({ ...match, field: 'recordFields' });
            }
            continue;
          }
        }
        const presented = presentMarkedFragment(fragment, openMarker, closeMarker);
        if (presented) matchedFields.push({ field, label: fieldLabel(field, record.recordType), ...presented });
      }
      if (simulationFilters?.fields) {
        for (const [index, condition] of simulationFilters.fields.entries()) {
          for (const inner of hit.inner_hits?.[`simulationField${index}`]?.hits.hits ?? []) {
            const value = inner._source?.value;
            if (!value || matchedFields.some(match => match.label === condition.label && match.text === value)) continue;
            const match = condition.operator === 'contains' ? matchedPatientFields(condition.value, [{ label: condition.label, value }])[0] : undefined;
            matchedFields.push(match ? { ...match, field: 'recordFields' }
              : { field: 'recordFields', label: condition.label, text: value, ranges: condition.operator === 'contains' ? [] : [[0, value.length]] });
          }
        }
        const legacyMatches = [
          ['成像方式', record.imagingModality, simulationFilters.imagingModality],
          ['定位部位', record.localizationSites?.find(site => site === simulationFilters.localizationSite), simulationFilters.localizationSite],
        ];
        for (const [label, value, expected] of legacyMatches) {
          if (value && value === expected) matchedFields.push({ field: 'recordFields', label: label!, text: value, ranges: [[0, value.length]] });
        }
      }
      return { ...record, matchedFields };
    });
    const textForRanking = !diagnosisTitle && !patientFilters && !simulationFilters && !catalogConditions && params.q.length >= 10
      && !hits.some(hit => hit.matchedFields.some(field => ['radiotherapyNo', 'recordNo', 'code'].includes(field.field)));
    const rankedHits = textForRanking ? await rerankHits(params.q, hits) : hits;
    return { ...params, ...(patientFilters ? { patientFilters } : {}), ...(catalogConditions ? { patientCatalogConditions: catalogConditions } : {}),
      ...(simulationFilters ? { simulationFilters } : {}), pageSize: 20, total: response.hits.total.value,
      typeCounts, categoryCounts, batchId: batch.meta.batchId, syncedAt: batch.meta.syncedAt, hits: rankedHits,
      elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SEARCH_UNAVAILABLE', '搜索服务暂时不可用，请检查本地服务后重试。', 503);
  }
}
