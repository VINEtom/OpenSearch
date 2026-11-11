import { randomUUID } from 'node:crypto';
import { DOCUMENT_CATEGORIES, RECORD_TYPES, SOURCES, TYPE_SOURCES, type MatchField, type PatientAgeFilter, type PatientCatalogCondition, type PatientSearchFilters, type RecordDocument, type RecordType, type SearchParams, type SearchResponse, type SearchType, type SimulationSearchFilters, type Source } from '../shared/types.js';
import { AppError } from './errors.js';
import { BATCH_PATTERN, resolveBatch } from './index-state.js';
import { diagnosisValueSet } from './diagnosis-terminology.js';
import { birthDateRange, parsePatientQuery, parseSexQuery, splitAgeQuery } from './patient-query.js';
import { confirmWithBert, predictPatientConditions, rerankHits } from './search-models.js';
import { parseSimulationClue, parseSimulationQuery } from './simulation-query.js';
import { patientSearchFieldById, patientSexLabels } from '../shared/patient-search-catalog.js';
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

export function buildSearchQuery(params: NormalizedSearch, openMarker: string, closeMarker: string, patientFilters?: PatientSearchFilters, simulationFilters?: SimulationSearchFilters, clue?: string, sex?: string, catalogConditions?: PatientCatalogCondition[], ageFilter?: PatientAgeFilter) {
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
  if (simulationFilters) {
    return {
      ...resultWindow,
      query: { bool: { filter: [
        ...filters,
        { term: { recordType: 'document' } },
        { term: { 'documentType.keyword': '定位申请单' } },
        ...(simulationFilters.imagingModality ? [{ term: { imagingModality: simulationFilters.imagingModality } }] : []),
        ...(simulationFilters.localizationSite ? [{ term: { localizationSites: simulationFilters.localizationSite } }] : []),
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
    const exactName = { term: { 'diagnosisFilters.name': diagnosis } };
    const coding = valueSet ? { bool: {
      should: [
        ...valueSet.compose.include.map(group => ({ bool: { filter: [
          { term: { 'diagnosisFilters.codingSystem': group.system } },
          { terms: { 'diagnosisFilters.code': group.concept.map(concept => concept.code) } },
        ] } })),
        { bool: { filter: [
          { term: { 'diagnosisFilters.codingSystem': 'DEMO-ONCOLOGY' } },
          { term: { 'diagnosisFilters.code': 'DEMO-NPC' } },
        ] } },
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
  return {
    ...resultWindow,
    track_scores: true,
    query: { bool: {
      filter: filters,
      should: [
        ...['radiotherapyNo', 'recordNo', 'code'].map(field => ({ term: { [field]: { value: params.q, boost: 10 } } })),
        { nested: { path: 'patientFields', score_mode: 'max', query: { term: { 'patientFields.value': { value: params.q, boost: 10 } } }, inner_hits: { name: 'patientFields', size: 5, _source: ['label', 'value'] } } },
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
export function matchedPatientFields(query: string, fields: { label: string; value: string }[] = []): MatchField[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: MatchField[] = [];
  for (const field of fields) {
    const lower = field.value.toLocaleLowerCase();
    const ranges: [number, number][] = [];
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
    if (ranges.length) matches.push({ field: 'patientFields', label: field.label, text: field.value, ranges });
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
  hits: { total: { value: number; relation: string }; hits: { _source: RecordDocument; highlight?: Record<string, string[]>; inner_hits?: { patientFields?: { hits: { hits: { _source?: { label?: string; value?: string } }[] } } } }[] };
  aggregations: { types: { buckets: { key: RecordType; doc_count: number }[] }; documentTypes?: { buckets: { key: string; doc_count: number }[] } };
}

export function assertCompleteResponse(response: Pick<EngineResponse, 'timed_out' | '_shards' | 'hits'>): void {
  if (response.timed_out || !response._shards || response._shards.failed !== 0 || response.hits?.total?.relation !== 'eq') {
    throw new AppError('SEARCH_UNAVAILABLE', '本次搜索未完整完成，请重试。', 503);
  }
}

export async function searchRecords(input: SearchParams): Promise<SearchResponse> {
  const params = validateSearchParams(input as unknown as Record<string, unknown>);
  const started = performance.now();
  try {
    const batch = await resolveBatch(params.batchId);
    const mixed = parseSimulationClue(params.q);
    const simulationFilters = mixed?.filters ?? parseSimulationQuery(params.q);
    if (simulationFilters && !batch.meta.supportsSimulationFilters) {
      return {
        ...params, simulationFilters, simulationFiltersNeedSync: true, pageSize: 20, total: 0,
        typeCounts: Object.fromEntries(RECORD_TYPES.map(type => [type, 0])) as Record<RecordType, number>,
        categoryCounts: {}, batchId: batch.meta.batchId, syncedAt: batch.meta.syncedAt, hits: [],
        elapsedMs: Math.round(performance.now() - started),
      };
    }
    const ageQuery = splitAgeQuery(params.q);
    const needsDetail = () => new AppError('PATIENT_QUERY_NEEDS_DETAIL', '暂未识别出完整的筛选条件。可以改写查询，或直接输入姓名等关键词搜索。');
    if (ageQuery === 'review') throw needsDetail();
    const ageFilter = ageQuery?.ageFilter;
    let sexFilter = simulationFilters || ageQuery ? undefined : parseSexQuery(params.q);
    const patientFilters = simulationFilters || sexFilter || ageQuery ? undefined : parsePatientQuery(params.q);
    if (patientFilters && !batch.meta.supportsDiagnosisCoding) {
      throw new AppError('PATIENT_FILTER_SYNC_REQUIRED', '请先同步搜索数据，再按确诊日期查询。', 409);
    }
    if (patientFilters && diagnosisValueSet(patientFilters.diagnosis)) {
      patientFilters.codingSystems = ['ICD-10', 'ICD-11'];
    }
    const canUseCatalog = (params.type === 'all' || params.type === 'patient') && params.source !== 'emr' && params.source !== 'rvs';
    let catalogConditions: PatientCatalogCondition[] | undefined;
    if (ageQuery) {
      const conditions: PatientCatalogCondition[] = [];
      for (const clause of ageQuery.remaining) {
        const sex = parseSexQuery(clause);
        if (sex) {
          if (sexFilter) throw needsDetail();
          sexFilter = sex;
          continue;
        }
        const predicted = canUseCatalog ? await predictPatientConditions(clause) : undefined;
        if (!predicted || predicted === 'review') throw needsDetail();
        conditions.push(...predicted);
      }
      const ids = new Set(conditions.map(condition => condition.id));
      if (ids.size !== conditions.length || (sexFilter && conditions.some(condition => patientSearchFieldById.get(condition.id)?.indexField === 'sex'))) {
        throw needsDetail();
      }
      if (conditions.length) catalogConditions = conditions;
    } else if (!simulationFilters && !sexFilter && !patientFilters && canUseCatalog) {
      const predicted = await predictPatientConditions(params.q);
      if (predicted === 'review') throw needsDetail();
      catalogConditions = predicted;
    }
    const marker = randomUUID();
    const openMarker = `\uE000${marker}\uE001`;
    const closeMarker = `\uE002${marker}\uE003`;
    const response = await osRequest<EngineResponse>(`/${encodeURIComponent(batch.index)}/_search?allow_partial_search_results=false`, 'POST', buildSearchQuery(params, openMarker, closeMarker, patientFilters, simulationFilters, mixed?.clue, sexFilter?.sex, catalogConditions, ageFilter));
    assertCompleteResponse(response);
    const typeCounts = Object.fromEntries(RECORD_TYPES.map(type => [type, 0])) as Record<RecordType, number>;
    for (const bucket of response.aggregations.types.buckets) typeCounts[bucket.key] = bucket.doc_count;
    const categoryCounts: Record<string, number> = { patient: typeCounts.patient, diagnosis: typeCounts.diagnosis };
    for (const bucket of response.aggregations.documentTypes?.buckets ?? []) categoryCounts[bucket.key] = bucket.doc_count;
    const hits = response.hits.hits.map(hit => {
      const record = hit._source;
      const matchedFields = catalogConditions ? matchedPatientConditions(record, catalogConditions) : [];
      for (const field of ['radiotherapyNo', 'recordNo', 'code'] as const) {
        const value = record[field];
        if (value === params.q) matchedFields.push({ field, label: fieldLabel(field, record.recordType), text: value, ranges: [[0, value.length]] });
      }
      for (const inner of hit.inner_hits?.patientFields?.hits.hits ?? []) {
        const label = inner._source?.label;
        const value = inner._source?.value;
        if (label && value) matchedFields.push({ field: 'patientFields', label, text: value, ranges: [[0, value.length]] });
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
        const parsed = parseMarkedHighlight(fragment, openMarker, closeMarker);
        if (parsed.ranges.length) matchedFields.push({ field, label: fieldLabel(field, record.recordType), ...parsed });
      }
      if (ageFilter && record.birthDate) {
        const birthdayPending = record.birthDate.slice(5) > ageFilter.asOf.slice(5);
        const years = Number(ageFilter.asOf.slice(0, 4)) - Number(record.birthDate.slice(0, 4)) - Number(birthdayPending);
        const text = `${years} 周岁`;
        matchedFields.unshift({ field: 'age', label: '年龄', text, ranges: [[0, text.length]] });
      }
      if (sexFilter) matchedFields.unshift({ field: 'sex', label: '性别', text: sexFilter.label, ranges: [[0, sexFilter.label.length]] });
      return { ...record, matchedFields };
    });
    const textForRanking = mixed?.clue ?? (!ageFilter && !simulationFilters && !patientFilters && !catalogConditions && params.q.length >= 10
      && !hits.some(hit => hit.matchedFields.some(field => ['radiotherapyNo', 'recordNo', 'code'].includes(field.field))) ? params.q : undefined);
    const [simulationBertConfirmed, rankedHits] = await Promise.all([
      mixed && hits.length ? confirmWithBert(mixed.fieldQuery, mixed.filters) : undefined,
      textForRanking ? rerankHits(textForRanking, hits) : hits,
    ]);
    return { ...params, ...(ageFilter ? { ageFilter } : {}), ...(catalogConditions ? { patientCatalogConditions: catalogConditions } : {}), ...(simulationBertConfirmed ? { simulationBertConfirmed } : {}), ...(sexFilter ? { sexFilter } : {}), ...(patientFilters ? { patientFilters } : {}), ...(simulationFilters ? { simulationFilters } : {}), pageSize: 20, total: response.hits.total.value, typeCounts, categoryCounts, batchId: batch.meta.batchId, syncedAt: batch.meta.syncedAt, hits: rankedHits, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SEARCH_UNAVAILABLE', '搜索服务暂时不可用，请检查本地服务后重试。', 503);
  }
}
