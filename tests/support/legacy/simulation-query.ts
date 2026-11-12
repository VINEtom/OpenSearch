import { normalizeLocalizationSite } from '../../../shared/simulation-fields.js';
import { simulationSpecs } from '../../../server/sources/record-fields.js';
import type { SimulationFieldCondition, SimulationSearchFilters } from '../../../shared/types.js';

const modality = /^(?:成像方式|定位方式)\s*(?:是|为|=|:)?\s*([a-z][a-z0-9-]{0,19})/iu;
const site = /^定位部位\s*(?:是|为|=|:)?\s*([\p{Script=Han}a-z0-9·/()-]{1,30}?)(?=\s*(?:[,;、。]|并且|且|和|同时|成像方式|定位方式|定位部位|$))/iu;
const separator = /^(?:\s|[,;、。]|并且|且|和|同时)+/u;

export function parseSimulationQuery(query: string): SimulationSearchFilters | undefined {
  let rest = query.normalize('NFKC').trim()
    .replace(/^(?:查找|搜索|找)\s*/u, '')
    .replace(/\s*(?:的\s*)?定位申请单\s*[。]?$/u, '');
  const filters: SimulationSearchFilters = {};
  while (rest) {
    const byModality = modality.exec(rest);
    const bySite = byModality ? null : site.exec(rest);
    if (byModality && !filters.imagingModality) filters.imagingModality = byModality[1].toUpperCase();
    else if (bySite && !filters.localizationSite) filters.localizationSite = normalizeLocalizationSite(bySite[1]);
    else return undefined;
    rest = rest.slice((byModality ?? bySite)![0].length).replace(separator, '');
  }
  return filters.imagingModality || filters.localizationSite ? filters : undefined;
}

export function parseSimulationClue(query: string): { filters: SimulationSearchFilters; fieldQuery: string; clue: string } | undefined {
  const match = /^(.*?)\s*[,、;]\s*备注(?:里说要|里提到|提到|里写着)\s*(.+?)(?:的)?定位申请单[。]?$/u.exec(query.normalize('NFKC').trim());
  if (!match) return undefined;
  const filters = parseSimulationQuery(match[1]);
  const clue = match[2].trim();
  return filters && clue ? { filters, fieldQuery: match[1], clue } : undefined;
}

const comparisonOperators: Record<string, SimulationFieldCondition['operator']> = {
  是: 'eq', 为: 'eq', 等于: 'eq', '=': 'eq', ':': 'eq', 包含: 'contains',
  小于: 'lt', '<': 'lt', 不超过: 'lte', 至多: 'lte', '<=': 'lte', '≤': 'lte',
  大于: 'gt', '>': 'gt', 至少: 'gte', 不少于: 'gte', '>=': 'gte', '≥': 'gte',
};
const fieldByLabel = new Map(simulationSpecs.map(field => [field.label.replaceAll(' ', '').toLowerCase(), field]));

export function parseSimulationFieldQuery(query: string): SimulationSearchFilters | 'invalid' | undefined {
  const normalized = query.normalize('NFKC').trim()
    .replace(/^(?:查找|搜索|找)\s*/u, '')
    .replace(/\s*(?:的\s*)?定位申请单\s*[。]?$/u, '');
  const clauses = normalized.split(/\s*(?:并且|且|[,、;])\s*/u);
  const filters: SimulationSearchFilters = {};
  const fields: SimulationFieldCondition[] = [];
  let incomplete = false;
  for (const clause of clauses) {
    const match = /^(.+?)\s*(包含|等于|大于|小于|不超过|不少于|至少|至多|>=|<=|[≥≤=<>:]|是|为)\s*(.*)$/u.exec(clause);
    const spec = match && fieldByLabel.get(match[1].replace(/\s/gu, '').toLowerCase());
    if ((!spec || spec.label === '成像方式' || spec.label === '定位方式') && clause) {
      const legacy = parseSimulationQuery(clause);
      if (legacy) {
        if ((filters.imagingModality && legacy.imagingModality) || (filters.localizationSite && legacy.localizationSite)) incomplete = true;
        Object.assign(filters, legacy);
        continue;
      }
    }
    if (!match || !spec) {
      incomplete = true;
      continue;
    }
    const operator = comparisonOperators[match[2]];
    const value = match[3].trim();
    if (!value || (operator === 'contains' && !spec.text) ||
        (operator !== 'eq' && operator !== 'contains' && !spec.number) ||
        (spec.number && (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value) || !Number.isFinite(Number(value))))) return 'invalid';
    fields.push({ label: spec.label, operator, value, numeric: spec.number });
  }
  if (!fields.length) return undefined;
  return incomplete ? 'invalid' : { ...filters, fields };
}
