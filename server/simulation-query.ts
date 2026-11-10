import { normalizeLocalizationSite } from '../shared/simulation-fields.js';
import type { SimulationSearchFilters } from '../shared/types.js';

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
