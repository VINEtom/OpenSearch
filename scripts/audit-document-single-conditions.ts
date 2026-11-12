/** Exercise the current document-condition parser against catalog-derived fictional cases. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FieldSpec } from '../server/sources/record-fields.js';
import { catalogs, fieldOwners, type Filter } from '../server/document-field-query.js';
import { runScoped } from '../tests/support/legacy/document-field-query.js';
export { catalogs, type Filter } from '../server/document-field-query.js';
export { runScoped };
import { parseSimulationClue, parseSimulationFieldQuery, parseSimulationQuery } from '../tests/support/legacy/simulation-query.js';

type Condition = Filter['conditions'][number];
type Case = { type: string; kind: string; query: string; expected?: Filter };
type Verdict = 'correctAllow' | 'wrongAllow' | 'falseBlock' | 'correctSkip';

function sample(field: FieldSpec): string {
  if (field.label === '成像方式') return 'CT';
  if (field.label === '技术') return 'VMAT';
  if (field.label === '扫描部位' || field.label.endsWith('部位')) return '头部';
  if (field.label === '治疗类型' && field.enum?.['3']) return field.enum['3'];
  if (field.enum) return Object.values(field.enum)[0];
  if (field.boolean) return '是';
  if (field.number) return '3';
  if (field.text) return '保持静止';
  if (field.label.endsWith('时间')) return '2030-01-02';
  return field.lookup === 'doctor' ? '林示例' : '模拟甲组';
}

function runCurrent(query: string): Filter | 'review' | undefined {
  const legacy = parseSimulationClue(query)?.filters ?? parseSimulationQuery(query);
  const parsed = legacy ?? parseSimulationFieldQuery(query);
  if (parsed === 'invalid') return 'review';
  if (!parsed) return undefined;
  const conditions: Condition[] = (parsed.fields ?? []).map(({ label, operator, value }) => ({ label, operator, value }));
  if (parsed.imagingModality) conditions.push({ label: '成像方式', operator: 'eq', value: parsed.imagingModality });
  if (parsed.localizationSite) conditions.push({ label: '扫描部位', operator: 'eq', value: parsed.localizationSite });
  return { type: '定位申请单', conditions };
}

const cases: Case[] = [];
for (const [type, fields] of Object.entries(catalogs)) {
  assert.equal(new Set(fields.map(field => field.label)).size, fields.length, type);
  for (const field of fields) {
    const value = sample(field);
    const expected: Filter = { type, conditions: [{ label: field.label, operator: 'eq', value }] };
    cases.push({ type, kind: 'exact', query: `找${field.label}为${value}的${type}`, expected });
    if (field.number) {
      for (const [phrase, operator] of [['小于', 'lt'], ['不超过', 'lte'], ['大于', 'gt'], ['至少', 'gte']] as const) {
        cases.push({ type, kind: 'number', query: `找${field.label}${phrase}3的${type}`,
          expected: { type, conditions: [{ label: field.label, operator, value: '3' }] } });
      }
    }
    if (field.text) {
      cases.push({ type, kind: 'fieldText', query: `找${field.label}包含屏气的${type}`,
        expected: { type, conditions: [{ label: field.label, operator: 'contains', value: '屏气' }] } });
    }
  }
  const first = fields.find(field => field.label === '技术') ?? fields[0];
  const value = sample(first);
  cases.push({ type, kind: 'keyword', query: `${type} ${value}` });
  cases.push({ type, kind: 'keyword', query: `找提到${value}的${type}` });
  cases.push({ type, kind: 'keyword', query: `${type} ${first.label}` });
}
for (const [label, owners] of fieldOwners) {
  if (owners.length < 2) continue;
  const field = catalogs[owners[0]].find(spec => spec.label === label)!;
  cases.push({ type: '未指定类型', kind: 'ambiguousType', query: `${label}为${sample(field)}` });
}
for (const query of ['屏气', 'VMAT', '头部 CT', '计划系统', '薄层扫描', '固定说明']) {
  cases.push({ type: '未指定类型', kind: 'keyword', query });
}
for (const [type, fields] of Object.entries(catalogs)) {
  const shared = fields.find(field => field.label === '技术');
  if (shared && type !== '定位申请单') {
    for (const query of [`${type}里技术为VMAT`, `只看${type}，技术为VMAT`]) {
      cases.push({ type, kind: 'sameName', query, expected: { type, conditions: [{ label: '技术', operator: 'eq', value: 'VMAT' }] } });
    }
  }
}
const regression: Case[] = [
  { type: '定位申请单', kind: 'combination', query: '成像方式为CT且CT层厚小于3', expected: { type: '定位申请单',
    conditions: [{ label: '成像方式', operator: 'eq', value: 'CT' }, { label: 'CT层厚', operator: 'lt', value: '3' }] } },
  { type: '定位申请单', kind: 'combination', query: '成像方式为CT且定位部位为头部', expected: { type: '定位申请单',
    conditions: [{ label: '成像方式', operator: 'eq', value: 'CT' }, { label: '扫描部位', operator: 'eq', value: '头部' }] } },
  { type: '计划申请单', kind: 'combination', query: '找技术为VMAT且总次数至少3的计划申请单', expected: { type: '计划申请单',
    conditions: [{ label: '技术', operator: 'eq', value: 'VMAT' }, { label: '总次数', operator: 'gte', value: '3' }] } },
];

function signature(filter: Filter): string {
  return JSON.stringify([filter.type, filter.conditions.map(({ label, operator, value }) => JSON.stringify([label, operator, value])).sort()]);
}
function evaluate(row: Case, parse = runCurrent) {
  const actual = parse(row.query);
  const applied = actual && actual !== 'review' ? actual : undefined;
  const verdict: Verdict = applied
    ? row.expected && signature(row.expected) === signature(applied) ? 'correctAllow' : 'wrongAllow'
    : row.expected ? 'falseBlock' : 'correctSkip';
  return { ...row, actual: actual ?? 'keyword', verdict,
    crossType: Boolean(row.expected && applied && row.expected.type !== applied.type),
    sharedField: Boolean(row.expected?.conditions.some(condition => (fieldOwners.get(condition.label)?.length ?? 0) > 1)) };
}

function summarize(rows: ReturnType<typeof evaluate>[]) {
  const counts = { correctAllow: 0, wrongAllow: 0, falseBlock: 0, correctSkip: 0, crossType: 0 };
  for (const row of rows) {
    counts[row.verdict]++;
    counts.crossType += Number(row.crossType);
  }
  return { total: rows.length, ...counts };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const output = process.argv[2] ?? '.runtime/document-single-condition-baseline';
  mkdirSync(output, { recursive: true });
  const frozen = JSON.stringify({ cases, regression }, null, 2) + '\n';
  writeFileSync(join(output, 'cases.json'), frozen);
  const scoped = process.argv.includes('--scoped');
  const parse = scoped ? runScoped : runCurrent;
  if (scoped) {
    assert.equal(parse('找CT层厚小于3的计划申请单'), 'review');
    assert.equal(parse('技术为VMAT'), 'review');
    assert.equal(parse('VMAT'), undefined);
    const treatmentType = '第三、四段/再次改计划/第三、四靶点';
    assert.deepEqual(parse(`治疗类型为${treatmentType}、技术为VMAT的计划申请单`), {
      type: '计划申请单',
      conditions: [{ label: '治疗类型', operator: 'eq', value: treatmentType },
        { label: '技术', operator: 'eq', value: 'VMAT' }],
    });
  }
  const rows = cases.map(row => evaluate(row, parse));
  const combined = regression.map(row => evaluate(row, parse));
  const explicitCombinations = scoped ? regression.map(row => evaluate(
    row.query.endsWith(row.type) ? row : { ...row, query: row.query + '的' + row.type }, parse,
  )) : [];
  const summary = Object.fromEntries([...Object.keys(catalogs), '未指定类型'].map(type => [
    type, summarize(rows.filter(row => row.type === type)),
  ]));
  const byKind = Object.fromEntries([...new Set(rows.map(row => row.kind))].map(kind => [
    kind, summarize(rows.filter(row => row.kind === kind)),
  ]));
  const report = { caseSha256: createHash('sha256').update(frozen).digest('hex'), summary, byKind,
    total: summarize(rows), sharedField: summarize(rows.filter(row => row.sharedField)),
    combination: summarize(combined), rows, combinationRows: combined, explicitCombinations };
  writeFileSync(join(output, scoped ? 'report-scoped.json' : 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ summary, byKind, total: report.total, sharedField: report.sharedField,
    combination: report.combination }, null, 2));
}
