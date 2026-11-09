import test from 'node:test';
import assert from 'node:assert/strict';
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
