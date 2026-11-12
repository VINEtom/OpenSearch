/** Replay a local snapshot through the publisher without modifying ois-records. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../server/config.js';
import { osRequest } from '../server/opensearch.js';
import { publishRecords } from '../server/sync.js';
import type { RecordDocument } from '../shared/types.js';
import { catalogs, runScoped, type Filter } from './audit-document-single-conditions.js';
import { queryFor } from './audit-document-opensearch.js';

const sourceDir = resolve(process.argv[2] ?? '.runtime');
const records: RecordDocument[] = (await readFile(join(sourceDir, 'captured-search.ndjson'), 'utf8'))
  .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const preview = process.argv.includes('--typed-preview');
const numericFields = new Map(Object.entries(catalogs).map(([type, fields]) => [
  type, new Set(fields.filter(field => field.number).map(field => field.label)),
]));
const publishable = preview ? records.map(record => {
  const fields = numericFields.get(record.documentType ?? '');
  if (!fields || !record.recordFields) return record;
  return { ...record, recordFields: record.recordFields.map(field => {
    const number = Number(field.value);
    return fields.has(field.label) && field.value.trim() && Number.isFinite(number)
      ? { ...field, numericValue: number } : field;
  }) };
}) : records;
const cases: { q: string; kind: string }[] = [];
const byType = new Map<string, RecordDocument[]>();
for (const [type, fields] of Object.entries(catalogs)) {
  const docs = records.filter(record => record.documentType === type);
  byType.set(type, docs);
  const counts = new Map<string, number>();
  for (const doc of docs) for (const field of doc.recordFields ?? []) {
    const key = JSON.stringify([field.label, field.value]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byFrequency = [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => JSON.parse(key) as [string, string]);
  const best = byFrequency.find(([label, value]) => fields.some(field => field.label === label && field.boolean)
    && ['是', '否'].includes(value)) ?? byFrequency.find(([label, value]) =>
      fields.some(field => field.label === label && !field.text) && !/[,;、且]/u.test(value));
  if (best) cases.push({ q: `找${best[0]}为${best[1]}的${type}`, kind: 'exact' });
  const text = byFrequency.find(([label, value]) => fields.some(field => field.label === label && field.text)
    && ['屏气', '复查', '定位', '扫描'].some(term => value.includes(term)));
  if (text) {
    const word = ['屏气', '复查', '定位', '扫描'].find(term => text[1].includes(term));
    cases.push({ q: `找${text[0]}包含${word}的${type}`, kind: 'text' });
  }
}
for (const type of ['定位申请单', '复位申请单', '计划申请单', '后装申请单', '全身放疗申请单']) {
  cases.push({ q: `找是否门控为否的${type}`, kind: 'shared-field' });
}
for (const op of ['小于', '不超过', '大于', '至少']) cases.push({ q: `找CT层厚${op}3的定位申请单`, kind: 'boundary' });
cases.push(
  { q: '找总次数至少3的计划申请单', kind: 'boundary' },
  { q: '找总次数至少1的后装申请单', kind: 'boundary' },
  { q: '找激光打点不超过0的复位申请单', kind: 'boundary' },
  { q: '找治疗类型为第三、四段/再次改计划/第三、四靶点的计划申请单', kind: 'enum' },
  { q: '找备注包含复查的治疗单', kind: 'empty-source' },
  { q: '成像方式为CT且CT层厚小于3的定位申请单', kind: 'combination' },
);

function matches(field: { label: string; value: string }, condition: Filter['conditions'][number], numeric: boolean) {
  if (field.label !== condition.label) return false;
  if (condition.operator === 'contains') return field.value.includes(condition.value);
  if (!numeric) return field.value === condition.value;
  if (!field.value.trim() || !Number.isFinite(Number(field.value))) return false;
  const left = Number(field.value), right = Number(condition.value);
  switch (condition.operator) {
    case 'lt': return left < right;
    case 'lte': return left <= right;
    case 'gt': return left > right;
    case 'gte': return left >= right;
    default: return left === right;
  }
}
function expectedHits(filter: Filter) {
  return (byType.get(filter.type) ?? []).flatMap(record => {
    const groups = filter.conditions.map(condition => {
      const numeric = catalogs[filter.type].some(field => field.label === condition.label && field.number);
      return (record.recordFields ?? []).filter(field => matches(field, condition, numeric))
        .map(field => [field.label, field.value].join('=')).sort();
    });
    return groups.every(group => group.length) ? [[record.id, groups] as const] : [];
  });
}
type Hit = { _id: string; sort: unknown[]; inner_hits?: Record<string, { hits: { hits: { _source: { label: string; value: string } }[] } }> };
const activeBefore = await osRequest('/_alias/ois-records');
config.indexAlias = 'audit-snapshot-' + randomUUID();
config.runtimeDir = await mkdtemp(join(sourceDir, 'audit-snapshot-'));
let index: string | undefined;
const results = [];
try {
  const status = await publishRecords(publishable);
  index = config.indexAlias + '-' + status.batchId;
  assert.equal(status.total, records.length);
  for (const { q, kind } of cases) {
    const filter = runScoped(q);
    assert.ok(filter && filter !== 'review', q);
    const expected = new Map(expectedHits(filter));
    const query = queryFor(filter);
    for (const clause of query.bool.filter) {
      if ('nested' in clause && clause.nested?.inner_hits) Object.assign(clause.nested.inner_hits, { size: 100 });
    }
    const seen = new Set<string>();
    let extra = 0, wrongValue = 0, after: unknown[] | undefined;
    while (true) {
      const response = await osRequest<{ hits: { hits: Hit[] } }>(`/${index}/_search`, 'POST', {
        query, size: 250, _source: false, sort: [{ id: 'asc' }], ...(after ? { search_after: after } : {}),
      });
      const hits = response.hits.hits;
      for (const hit of hits) {
        assert.ok(!seen.has(hit._id));
        seen.add(hit._id);
        const expectedValues = expected.get(hit._id);
        if (!expectedValues) { extra++; continue; }
        const actual = filter.conditions.map((_, i) =>
          (hit.inner_hits?.[`field-${i}`]?.hits.hits ?? []).map(x => [x._source.label, x._source.value].join('=')).sort());
        if (JSON.stringify(actual) !== JSON.stringify(expectedValues)) wrongValue++;
      }
      if (hits.length < 250) break;
      after = hits.at(-1)!.sort;
    }
    const missing = [...expected.keys()].filter(id => !seen.has(id)).length;
    results.push({ type: filter.type, q, kind, expected: expected.size, actual: seen.size, missing, extra, wrongValue });
  }
  for (const [q, expected] of [['技术为VMAT', 'review'], ['是否门控为否', 'review'], ['VMAT', undefined]] as const) {
    assert.equal(runScoped(q), expected);
  }
} finally {
  if (index) await osRequest('/' + index, 'DELETE');
  await rm(config.runtimeDir, { recursive: true, force: true });
  assert.deepEqual(await osRequest('/_alias/ois-records'), activeBefore);
}
const summary = Object.fromEntries([...byType].map(([type, docs]) => [type, {
  records: docs.length, withFields: docs.filter(doc => doc.recordFields?.length).length,
  populatedFields: new Set(docs.flatMap(doc => (doc.recordFields ?? []).map(field => field.label))).size,
}]));
await writeFile(join(sourceDir, 'document-single-condition-baseline', preview ? 'snapshot-typed-preview.json' : 'snapshot-report.json'),
  JSON.stringify({ records: records.length, preview, summary, results }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ records: records.length, summary, results }));
