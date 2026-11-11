import { parseSimulationClue, parseSimulationQuery } from '../server/simulation-query.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseline } from '../fixtures/samples.js';
import { patientSearchCatalog } from '../shared/patient-search-catalog.js';
import { projectRecords } from '../server/data.js';
import { birthDateRange, parseAgeQuery, parsePatientQuery, parseSexQuery, splitAgeQuery } from '../server/patient-query.js';
import { htmlToText, readableText } from '../server/sources/text.js';
import { assertCompleteResponse, buildSearchQuery, matchedPatientConditions, matchedPatientFields, parseMarkedHighlight, presentMarkedFragment, validateSearchParams } from '../server/search.js';

test('rejects unsupported, duplicated, mismatched and malformed query inputs', () => {
  for (const input of [
    { q: '' }, { q: ['a', 'b'] }, { q: '屏气', rawQuery: '{}' },
    { q: '屏气', scope: 'patient' }, { q: '屏气', source: 'pms', type: 'document' },
    { q: '屏气', page: 'NaN' }, { q: '屏气', page: -1 }, { q: '屏气', batchId: '../other' },
  ]) assert.throws(() => validateSearchParams(input));
});
test('leading zero identifiers are retained and scope filters do not include object-type facet selection', () => {
  const params = validateSearchParams({ q: ' 000123 ', source: 'emr', type: 'document' });
  const query = buildSearchQuery(params, 'OPEN', 'CLOSE');
  assert.equal(params.q, '000123');
  assert.deepEqual(query.query.bool.filter, [{ term: { source: 'emr' } }]);
  assert.deepEqual(query.post_filter, { term: { recordType: 'document' } });
  const category = buildSearchQuery(validateSearchParams({ q: '定位', type: '定位申请单' }), 'OPEN', 'CLOSE');
  assert.deepEqual(category.post_filter, { term: { 'documentType.keyword': '定位申请单' } });
  assert.throws(() => validateSearchParams({ q: '定位', source: 'pms', type: '定位申请单' }));
  assert.equal(query.track_total_hits, true);
});
test('highlight conversion preserves unsafe-looking text as literal text and computes UTF-16 ranges', () => {
  const result = parseMarkedHighlight('<img onerror=x>😀[屏气]训练', '[', ']');
  assert.equal(result.text, '<img onerror=x>😀屏气训练');
  assert.deepEqual(result.ranges, [[17, 19]]);
  assert.equal(result.text.slice(...result.ranges[0]), '屏气');
});
test('a text match in patient details is labeled with the specific field', () => {
  const matches = matchedPatientFields('test', [
    { label: '拼音', value: 'TEST' },
    { label: '备注', value: '其他说明' },
    { label: '联系人', value: '张三 test 配偶' },
  ]);
  assert.deepEqual(matches.map(match => match.label), ['拼音', '联系人']);
  assert.equal(matches[0].text, 'TEST');
  assert.deepEqual(matches[0].ranges, [[0, 4]]);
});
test('display text decodes entities and keeps clinical comparisons', () => {
  assert.equal(readableText('a < b > c &nbsp; d'), 'a < b > c d');
  const [match] = matchedPatientFields('b', [{ label: '备注', value: 'a < b > c' }]);
  assert.equal(match.text, 'a < b > c');
  assert.equal(match.text.slice(...match.ranges[0]), 'b');
});
test('custom report html decodes entities before dropping tags', () => {
  assert.equal(htmlToText('&lt;span&gt;治疗目的&lt;/span&gt; &nbsp;'), '治疗目的');
  assert.equal(htmlToText('<p>治疗目的</p>'), '治疗目的');
});
test('a long document hit keeps a short plain-text window around the keyword', () => {
  const filler = '疗前评估单 '.repeat(40);
  const stored = `${filler}关联诊断 : [[关联诊断]] &nbsp;治疗目的 : [[治疗目的]] &nbsp;${filler}`;
  const [match] = matchedPatientFields('治疗目的', [{ label: '正文', value: stored }]);
  assert.ok(match.text.length < 160);
  assert.equal(match.text.includes('&nbsp;'), false);
  assert.equal(match.text.slice(...match.ranges[0]), '治疗目的');
  assert.ok(match.text.startsWith('…'));
  assert.ok(match.text.endsWith('…'));
});
test('highlight fragments are cleaned and clipped around the keyword', () => {
  const filler = '疗前评估单 '.repeat(40);
  const presented = presentMarkedFragment(`${filler}&nbsp;[治疗目的]${filler}`, '[', ']');
  assert.ok(presented);
  assert.equal(presented.text.includes('&nbsp;'), false);
  assert.equal(presented.text.slice(...presented.ranges[0]), '治疗目的');
  assert.ok(presented.text.startsWith('…'));
  assert.ok(presented.text.endsWith('…'));
});
test('labels only the patient values that satisfy structured search conditions', () => {
  const patient = projectRecords(baseline(), 'test').find(record => record.recordType === 'patient')!;
  const conditions = [
    { label: '主诊医生', value: '虚构医生' },
    { label: '住院科室', value: '放疗科' },
    { label: '性别', value: 'female' },
  ].map(({ label, value }) => ({ id: patientSearchCatalog.find(field => field.label === label)!.id, value }));
  const record = { ...patient, sex: 'female', patientFields: [
    { label: '主诊医生', value: '其他医生' },
    { label: '主诊医生', value: '虚构医生' },
    { label: '住院科室', value: '放疗科' },
    { label: '备注', value: '虚构医生' },
  ] };
  assert.deepEqual(matchedPatientConditions(record, conditions), [
    { field: 'patientFields', label: '主诊医生', text: '虚构医生', ranges: [[0, 4]] },
    { field: 'patientFields', label: '住院科室', text: '放疗科', ranges: [[0, 3]] },
    { field: 'sex', label: '性别', text: '女', ranges: [[0, 1]] },
  ]);
  assert.deepEqual(matchedPatientConditions(record, [{ ...conditions[0], value: '放疗科' }]), []);
});
test('unclosed marker remains literal rather than dropping source text', () => {
  assert.deepEqual(parseMarkedHighlight('前文[未闭合', '[', ']'), { text: '前文[未闭合', ranges: [] });
});
test('partial, timed-out and inexact search results never become successful zero-result pages', () => {
  const good = { timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 7, relation: 'eq' }, hits: [] } };
  assert.doesNotThrow(() => assertCompleteResponse(good));
  assert.throws(() => assertCompleteResponse({ ...good, timed_out: true }));
  assert.throws(() => assertCompleteResponse({ ...good, _shards: { failed: 1 } }));
  assert.throws(() => assertCompleteResponse({ ...good, hits: { total: { value: 10000, relation: 'gte' }, hits: [] } }));
});

test('recognizes a sex phrase in Chinese or English', () => {
  assert.deepEqual(parseSexQuery('性别为男'), { sex: 'male', label: '男' });
  assert.deepEqual(parseSexQuery('性别为male'), { sex: 'male', label: '男' });
  assert.deepEqual(parseSexQuery('性别是女'), { sex: 'female', label: '女' });
  assert.equal(parseSexQuery('男'), undefined);
  assert.equal(parseSexQuery('性别为男孩'), undefined);
});
test('filters by completed years using the Shanghai query date and strict boundaries', () => {
  const now = new Date('2026-11-09T16:30:00Z');
  const q = '年龄大于二十岁';
  const filter = parseAgeQuery(q, now)!;
  assert.deepEqual(filter, { operator: '>', years: 20, asOf: '2026-11-10' });
  assert.deepEqual(parseAgeQuery('年龄 > ２０周岁', now), filter);
  assert.equal(parseAgeQuery('年龄大于二十岁且在住院', now), undefined);
  const query = buildSearchQuery(validateSearchParams({ q }), 'OPEN', 'CLOSE', undefined, undefined, undefined, undefined, undefined, filter);
  assert.deepEqual(query.query.bool.filter, [
    { term: { recordType: 'patient' } }, { range: { birthDate: { lte: '2005-11-10' } } },
  ]);
  assert.deepEqual(birthDateRange(parseAgeQuery('年龄至少20岁', now)!), { lte: '2006-11-10' });
  assert.deepEqual(birthDateRange(parseAgeQuery('年龄小于20岁', now)!), { gt: '2006-11-10', lte: '2026-11-10' });
  assert.deepEqual(birthDateRange(parseAgeQuery('年龄至多20岁', now)!), { gt: '2005-11-10', lte: '2026-11-10' });
  assert.deepEqual(birthDateRange({ operator: '>=', years: 1, asOf: '2024-02-29' }), { lte: '2023-02-28' });
  assert.deepEqual(birthDateRange({ operator: '>=', years: 1, asOf: '2025-02-28' }), { lte: '2024-02-28' });
});
test('keeps age and other conditions in the same patient query regardless of clause order', () => {
  const now = new Date('2026-11-10T01:00:00Z');
  for (const q of ['年龄大于二十岁且性别为女', '性别为女并且年龄大于二十岁']) {
    const parsed = splitAgeQuery(q, now);
    assert.ok(parsed && parsed !== 'review');
    assert.deepEqual(parsed.remaining, ['性别为女']);
    const sex = parseSexQuery(parsed.remaining[0])?.sex;
    const query = buildSearchQuery(validateSearchParams({ q }), 'OPEN', 'CLOSE', undefined, undefined, undefined, sex, undefined, parsed.ageFilter);
    assert.deepEqual(query.query.bool.filter, [
      { term: { recordType: 'patient' } }, { range: { birthDate: { lte: '2005-11-10' } } }, { term: { sex: 'female' } },
    ]);
  }
  for (const q of ['年龄大于二十岁或性别为女', '年龄大于二十岁且性别为女或为男', '年龄大于二十岁且', '年龄大于二十岁且年龄小于三十岁']) {
    assert.equal(splitAgeQuery(q, now), 'review');
  }
  assert.equal(splitAgeQuery('找颜艳主诊的女性患者', now), undefined);
});
test('parses the complete patient query in the Shanghai calendar and clamps month end', () => {
  const now = new Date('2026-05-30T16:30:00Z');
  const q = '最近三个月确诊鼻咽癌、处方不少于 20 次';
  assert.deepEqual(parsePatientQuery(q, now), {
    diagnosis: '鼻咽癌', diagnosedFrom: '2026-02-28', diagnosedThrough: '2026-05-31', minimumFractions: 20,
  });
  assert.equal(parsePatientQuery(q + '且未开始治疗', now), undefined);
  assert.equal(parsePatientQuery('鼻咽癌', now), undefined);
});

test('recognizes confirmed diagnosis dates without adding a prescription constraint', () => {
  assert.deepEqual(parsePatientQuery('最近10个月确诊鼻咽癌', new Date('2026-11-09T08:00:00Z')), {
    diagnosis: '鼻咽癌', diagnosedFrom: '2026-01-09', diagnosedThrough: '2026-11-09',
  });
});

test('parses two exact simulation fields without turning ordinary text into a field query', () => {
  assert.deepEqual(parseSimulationQuery('定位方式是 CT'), { imagingModality: 'CT' });
  assert.deepEqual(parseSimulationQuery('定位部位是头部'), { localizationSite: '头部' });
  assert.deepEqual(parseSimulationQuery('找定位部位是Head、成像方式为ｃｔ的定位申请单'), { localizationSite: '头部', imagingModality: 'CT' });
  assert.equal(parseSimulationQuery('头部 CT 定位申请单'), undefined);
  assert.equal(parseSimulationQuery('定位方式是 CT，定位方式是 MR'), undefined);
  const params = validateSearchParams({ q: '定位方式是 CT 且定位部位是头部' });
  const query = buildSearchQuery(params, 'OPEN', 'CLOSE', undefined, parseSimulationQuery(params.q));
  assert.deepEqual(query.query.bool.filter, [
    { term: { recordType: 'document' } }, { term: { 'documentType.keyword': '定位申请单' } },
    { term: { imagingModality: 'CT' } }, { term: { localizationSites: '头部' } },
  ]);
});

test('keeps the remark clue separate from explicit simulation fields', () => {
  const q = '找成像方式为 CT、定位部位是头部，备注里说要趴着摆位的定位申请单';
  const mixed = parseSimulationClue(q);
  assert.deepEqual(mixed, {
    filters: { imagingModality: 'CT', localizationSite: '头部' },
    fieldQuery: '找成像方式为 CT、定位部位是头部',
    clue: '趴着摆位',
  });
  assert.equal(parseSimulationClue('备注里提到 CT、备注里说要趴着摆位的定位申请单'), undefined);
  assert.equal(parseSimulationClue('找成像方式不是 CT、备注里说要趴着摆位的定位申请单'), undefined);
  const { query } = buildSearchQuery(validateSearchParams({ q }), 'OPEN', 'CLOSE', undefined, mixed?.filters, mixed?.clue);
  assert.deepEqual(query.bool.should, [{ match: { bodyText: '趴着摆位' } }]);
  assert.ok(query.bool.filter.some(item => JSON.stringify(item) === '{"term":{"imagingModality":"CT"}}'));
});
