/** Offline regression for routing explicit localization-site queries to their index field. */
import assert from 'node:assert/strict';
import { buildSearchQuery, validateSearchParams } from '../server/search.js';
import { runScoped } from '../tests/support/legacy/document-field-query.js';
import { parseSimulationQuery } from '../tests/support/legacy/simulation-query.js';

function resolveLocalizationSite(query: string) {
  const legacy = parseSimulationQuery(query);
  if (!legacy?.localizationSite || legacy.imagingModality) return undefined;

  const scoped = runScoped(query);
  if (scoped === 'review') return { status: 'review', message: '请指定单据类型' } as const;
  if (scoped?.type !== '定位申请单' || scoped.conditions.length !== 1) return undefined;
  const [condition] = scoped.conditions;
  if (condition.label !== '扫描部位' || condition.operator !== 'eq') return undefined;

  const plan = buildSearchQuery(validateSearchParams({ q: query }), '<mark>', '</mark>', undefined, {
    localizationSite: legacy.localizationSite,
  });
  return { status: 'filter', query: plan.query } as const;
}

const expected = {
  status: 'filter',
  query: { bool: { filter: [
    { term: { recordType: 'document' } },
    { term: { 'documentType.keyword': '定位申请单' } },
    { term: { localizationSites: '头部' } },
  ] } },
};
const cases = [
  ['定位部位是头部的定位申请单', expected],
  ['找定位部位为Head的定位申请单', expected],
  ['定位部位是头部', { status: 'review', message: '请指定单据类型' }],
  ['固定部位是头部的定位申请单', undefined],
  ['成像方式为CT且定位部位为头部的定位申请单', undefined],
] as const;

for (const [query, wanted] of cases) {
  const result = resolveLocalizationSite(query);
  assert.deepEqual(result, wanted, query);
  console.log(JSON.stringify({ input: query, result: result ?? { status: 'outOfScope' } }));
}
