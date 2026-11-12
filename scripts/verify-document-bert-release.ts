/** Verify the same release candidate with edge fixtures, a snapshot, and a missing model. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Condition = { label: string; operator: string; value: string };
type Expected = { query: string; type: string; condition: Condition; ids: string[]; values: string[] };

const [edge, snapshot, unavailable, edgeFile, snapshotFile] = process.argv.slice(2);
assert.ok(edge && snapshot && unavailable && edgeFile && snapshotFile,
  'Usage: verify-document-bert-release.ts EDGE_URL SNAPSHOT_URL UNAVAILABLE_URL EDGE_FIXTURES SNAPSHOT_EXPECTED');

const edgeData = JSON.parse(readFileSync(edgeFile, 'utf8')) as {
  status: { batchId: string }; fixtures: { title: string; id: string }[];
};
const snapshotData = JSON.parse(readFileSync(snapshotFile, 'utf8')) as {
  status: { batchId: string };
  expected: { query: string; type: string; label: string; value: string; hits: { id: string }[] }[];
};
function idFor(title: string) {
  const row = edgeData.fixtures.find(item => item.title === title);
  assert.ok(row, title);
  return row.id;
}

const edgeCases: Expected[] = [
  {query: '找总次数不少于20次的计划申请单', type: '计划申请单',
    condition: {label: '总次数', operator: 'gte', value: '20'},
    ids: [idFor('计划边界20'), idFor('计划边界21')], values: ['20', '21']},
  {query: '找总次数大于20次的计划申请单', type: '计划申请单',
    condition: {label: '总次数', operator: 'gt', value: '20'}, ids: [idFor('计划边界21')], values: ['21']},
  {query: '找总次数小于20次的计划申请单', type: '计划申请单',
    condition: {label: '总次数', operator: 'lt', value: '20'}, ids: [idFor('计划边界19')], values: ['19']},
  {query: '找靶区部位是头部的后装申请单', type: '后装申请单',
    condition: {label: '靶区部位', operator: 'eq', value: '头部'}, ids: [idFor('后装靶区头部')], values: ['头部']},
  {query: '找扫描部位是胸部的复位申请单', type: '复位申请单',
    condition: {label: '扫描部位', operator: 'eq', value: '胸部'}, ids: [idFor('复位扫描胸部')], values: ['胸部']},
];
const snapshotCases = snapshotData.expected.map(({query, type, label, value, hits}) => ({
  query, type, condition: {label, operator: 'eq', value},
  ids: hits.map(hit => hit.id), values: hits.map(() => value),
}));

async function search(origin: string, q: string) {
  const url = new URL('/api/prototype/search', origin);
  url.searchParams.set('q', q);
  const response = await fetch(url, {signal: AbortSignal.timeout(35000)});
  return {status: response.status, body: await response.json()};
}

for (const [origin, batch, cases] of [
  [edge, edgeData.status.batchId, edgeCases],
  [snapshot, snapshotData.status.batchId, snapshotCases],
] as const) {
  for (const {query, type, condition, ids, values} of cases) {
    const {status, body} = await search(origin, query);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.batchId, batch);
    assert.equal(body.simulationFilters.documentType, type);
    const [actual, ...other] = body.simulationFilters.fields;
    assert.deepEqual(other, []);
    assert.deepEqual({label: actual.label, operator: actual.operator, value: actual.value}, condition);
    assert.equal(body.total, ids.length);
    assert.deepEqual(body.hits.map((hit: {id: string}) => hit.id).sort(), ids.sort());
    const matched = body.hits.flatMap((hit: {documentType: string; matchedFields: {label: string; text: string}[]}) => {
      assert.equal(hit.documentType, type);
      return hit.matchedFields.filter(match => match.label === condition.label).map(match => match.text);
    });
    assert.deepEqual(matched.sort(), values.sort());
    console.log(JSON.stringify({query, status, condition, ids, matched}));
  }
}
for (const [origin, query, expectedStatus, code] of [
  [edge, '找总次数为20且总次数不少于19的计划申请单', 400, 'INVALID_QUERY'],
  [edge, '找扫描部位是胸部以及固定部位是头部的复位申请单', 400, 'INVALID_QUERY'],
  [edge, '找靶区部位不是头部的后装申请单', 400, 'INVALID_QUERY'],
  [edge, '找靶区部位是头部或颈部的后装申请单', 400, 'INVALID_QUERY'],
  [unavailable, edgeCases[0].query, 503, 'DOCUMENT_MODEL_UNAVAILABLE'],
] as const) {
  const {status, body} = await search(origin, query);
  assert.equal(status, expectedStatus, JSON.stringify(body));
  assert.equal(body.error.code, code);
  console.log(JSON.stringify({query, status, error: body.error}));
}
const missingType = await search(edge, '靶区部位是头部');
assert.ok([200, 400].includes(missingType.status));
assert.equal(missingType.body.simulationFilters, undefined);
console.log(JSON.stringify({query: '靶区部位是头部', status: missingType.status, documentFilter: false}));
const ordinary = await search(unavailable, '计划边界19');
assert.equal(ordinary.status, 200);
assert.equal(ordinary.body.simulationFilters, undefined);
console.log(JSON.stringify({query: '计划边界19', status: ordinary.status, keyword: true}));
