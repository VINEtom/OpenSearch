/** Test the offline parser and query execution on an isolated synthetic index. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { recordProperties } from '../server/mapping.js';
import { catalogs, runScoped, type Filter } from './audit-document-single-conditions.js';

const base = 'http://127.0.0.1:9207';
const index = 'audit-document-fields-' + randomUUID();
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, headers: { 'content-type': typeof body === 'string' ? 'application/x-ndjson' : 'application/json' },
    body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error(`${method} ${path} ${response.status} ${await response.text()}`);
  return response.json();
}

type Field = { label: string; value: string; numericValue?: number };
const field = (label: string, value: string, numericValue?: number): Field => ({ label, value, numericValue });
const fixtures: { id: string; documentType: string; recordFields: Field[]; bodyText?: string }[] = [];
const add = (id: string, documentType: string, fields: Field[], bodyText = '') =>
  fixtures.push({ id, documentType, recordFields: fields, bodyText });
const treatment = '第三、四段/再次改计划/第三、四靶点';
add('sim-29', '定位申请单', [field('技术', 'VMAT'), field('成像方式', 'CT'), field('CT层厚', '2.9', 2.9), field('扫描说明', '扫描时屏气')], '扫描时屏气');
add('sim-30', '定位申请单', [field('技术', 'IMRT'), field('成像方式', 'CT'), field('CT层厚', '3', 3), field('固定说明', '固定时屏气')], '固定时屏气');
add('sim-31', '定位申请单', [field('技术', 'VMAT'), field('成像方式', 'MR'), field('CT层厚', '3.1', 3.1)]);
add('sim-missing', '定位申请单', [field('CT毫安', '2.9', 2.9), field('摆位', 'VMAT')]);
add('reset-vmat', '复位申请单', [field('技术', 'VMAT'), field('CT层厚', '2.9', 2.9)]);
add('reset-imrt', '复位申请单', [field('技术', 'IMRT')]);
add('plan-vmat', '计划申请单', [field('技术', 'VMAT'), field('治疗类型', treatment), field('总次数', '3', 3)]);
add('plan-imrt', '计划申请单', [field('技术', 'IMRT'), field('治疗类型', '第二段/改计划/第二靶点'), field('计划治疗次数', '3', 3)]);
add('after-vmat', '后装申请单', [field('技术', 'VMAT'), field('治疗类型', treatment)]);
add('after-imrt', '后装申请单', [field('技术', 'IMRT')]);
add('tbi-vmat', '全身放疗申请单', [field('技术', 'VMAT')]);
add('tbi-imrt', '全身放疗申请单', [field('技术', 'IMRT')]);
add('one-head', '一站式申请单', [field('扫描部位', '头部')]);
add('one-neck', '一站式申请单', [field('扫描部位', '颈部'), field('部位', '头部')]);
add('exam-hit', '检查预约单', [field('备注', '安排复查')], '安排复查');
add('exam-miss', '检查预约单', [field('备注', '例行检查')]);
add('treat-hit', '治疗单', [field('备注', '安排复查')], '安排复查');
add('treat-miss', '治疗单', [field('备注', '例行检查')]);
add('custom-hit', '自定义单据', [field('正文', '安排复查')], '安排复查');
add('custom-miss', '自定义单据', [field('说明', '安排复查')], '安排复查');

export function queryFor(filter: Filter) {
  return { bool: { filter: [
    { term: { 'documentType.keyword': filter.type } },
    ...filter.conditions.map(({ label, operator, value }, i) => {
      const numeric = catalogs[filter.type].some(field => field.label === label && field.number);
      const criterion = operator === 'eq'
        ? numeric ? { term: { 'recordFields.numericValue': Number(value) } } : { term: { 'recordFields.value': value } }
        : operator === 'contains' ? { match_phrase: { 'recordFields.value.text': value } }
          : { range: { 'recordFields.numericValue': { [operator]: Number(value) } } };
      return { nested: { path: 'recordFields',
        query: { bool: { filter: [{ term: { 'recordFields.label': label } }, criterion] } },
        inner_hits: { name: `field-${i}` } } };
    }),
  ] } };
}

type Hit = { _id: string; inner_hits?: Record<string, { hits: { hits: { _source: Field }[] } }> };
const cases: { q: string; hits: Record<string, string[]> }[] = [
  { q: '找技术为VMAT的定位申请单', hits: { 'sim-29': ['技术=VMAT'], 'sim-31': ['技术=VMAT'] } },
  { q: '找技术为VMAT的复位申请单', hits: { 'reset-vmat': ['技术=VMAT'] } },
  { q: '找技术为VMAT的计划申请单', hits: { 'plan-vmat': ['技术=VMAT'] } },
  { q: '找技术为VMAT的后装申请单', hits: { 'after-vmat': ['技术=VMAT'] } },
  { q: '找技术为VMAT的全身放疗申请单', hits: { 'tbi-vmat': ['技术=VMAT'] } },
  { q: '找扫描部位为头部的一站式申请单', hits: { 'one-head': ['扫描部位=头部'] } },
  { q: '找备注包含复查的检查预约单', hits: { 'exam-hit': ['备注=安排复查'] } },
  { q: '找备注包含复查的治疗单', hits: { 'treat-hit': ['备注=安排复查'] } },
  { q: '找正文包含复查的自定义单据', hits: { 'custom-hit': ['正文=安排复查'] } },
  { q: '找扫描说明包含屏气的定位申请单', hits: { 'sim-29': ['扫描说明=扫描时屏气'] } },
  { q: '找CT层厚小于3的定位申请单', hits: { 'sim-29': ['CT层厚=2.9'] } },
  { q: '找CT层厚不超过3的定位申请单', hits: { 'sim-29': ['CT层厚=2.9'], 'sim-30': ['CT层厚=3'] } },
  { q: '找CT层厚等于3.0的定位申请单', hits: { 'sim-30': ['CT层厚=3'] } },
  { q: '找总次数至少3的计划申请单', hits: { 'plan-vmat': ['总次数=3'] } },
  { q: '找CT层厚大于3的定位申请单', hits: { 'sim-31': ['CT层厚=3.1'] } },
  { q: '找CT层厚至少3的定位申请单', hits: { 'sim-30': ['CT层厚=3'], 'sim-31': ['CT层厚=3.1'] } },
  { q: `找治疗类型为${treatment}的计划申请单`, hits: { 'plan-vmat': [`治疗类型=${treatment}`] } },
  { q: `治疗类型为${treatment}、技术为VMAT的计划申请单`, hits: { 'plan-vmat': ['技术=VMAT', `治疗类型=${treatment}`] } },
  { q: '成像方式为CT且CT层厚小于3的定位申请单', hits: { 'sim-29': ['CT层厚=2.9', '成像方式=CT'] } },
];

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const activeBefore = await request('/_alias/ois-records');
  const rows = [];
  await request('/' + index, 'PUT', { settings: { number_of_replicas: 0 },
    mappings: { dynamic: 'strict', properties: recordProperties } });
  try {
    const bulk = fixtures.flatMap(({ id, ...source }) => [
      JSON.stringify({ index: { _id: id } }), JSON.stringify(source),
    ]).join('\n') + '\n';
    assert.equal((await request(`/${index}/_bulk?refresh=true`, 'POST', bulk)).errors, false);
    for (const { q, hits } of cases) {
      const parsed = runScoped(q);
      assert.ok(parsed && parsed !== 'review', q);
      const response = await request(`/${index}/_search`, 'POST', { query: queryFor(parsed), size: 50 });
      const actual = Object.fromEntries((response.hits.hits as Hit[]).map(hit => [
        hit._id, Object.values(hit.inner_hits ?? {}).flatMap(h => h.hits.hits.map(({ _source }) => `${_source.label}=${_source.value}`)).sort(),
      ]));
      const expected = Object.fromEntries(Object.entries(hits).map(([id, matches]) => [id, [...matches].sort()]));
      assert.deepEqual(actual, expected, q);
      rows.push({ q, actual });
    }
    assert.equal(runScoped('技术为VMAT'), 'review');
    assert.equal(runScoped('成像方式为CT且CT层厚小于3'), 'review');
    assert.equal(runScoped('VMAT'), undefined);
    const keyword = await request(`/${index}/_search`, 'POST', { query: { nested: { path: 'recordFields',
      query: { term: { 'recordFields.value': 'VMAT' } } } }, size: 50 });
    const keywordIds = (keyword.hits.hits as Hit[]).map(hit => hit._id).sort();
    assert.deepEqual(keywordIds, ['after-vmat', 'plan-vmat', 'reset-vmat', 'sim-29', 'sim-31', 'sim-missing', 'tbi-vmat']);
    rows.push({ q: '技术为VMAT', actual: 'review' }, { q: '成像方式为CT且CT层厚小于3', actual: 'review' },
      { q: 'VMAT', actual: keywordIds });
  } finally {
    await request('/' + index, 'DELETE');
  }
  assert.deepEqual(await request('/_alias/ois-records'), activeBefore);
  const output = '.runtime/document-single-condition-baseline';
  mkdirSync(output, { recursive: true });
  writeFileSync(output + '/opensearch-report.json', JSON.stringify({ fixtures: fixtures.length, cases: rows }, null, 2) + '\n');
  console.log(`Passed ${rows.length} cases with ${fixtures.length} synthetic records`);
}
