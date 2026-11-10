import { parseSimulationQuery } from '../server/simulation-query.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatientQuery } from '../server/patient-query.js';
import { assertCompleteResponse, buildSearchQuery, parseMarkedHighlight, validateSearchParams } from '../server/search.js';

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
