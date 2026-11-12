import { osRequest } from './opensearch.js';

const ICD_10 = 'http://hl7.org/fhir/sid/icd-10';
const ICD_11 = 'http://id.who.int/icd/release/11/mms';

export const nasopharynxValueSet = {
  resourceType: 'ValueSet',
  name: 'NasopharyngealMalignancy',
  title: '鼻咽恶性肿瘤',
  status: 'active',
  compose: {
    include: [
      { system: ICD_10, concept: ['C11', 'C11.0', 'C11.1', 'C11.2', 'C11.3', 'C11.8', 'C11.9'].map(code => ({ code })) },
      { system: ICD_11, concept: ['2B6B', '2B6B.0', '2B6B.1', '2B6B.2', '2B6B.20', '2B6B.21', '2B6B.2Y', '2B6B.2Z', '2B6B.Y', '2B6B.Z'].map(code => ({ code })) },
    ],
  },
} as const;

const nasopharynxNames = ['鼻咽癌', nasopharynxValueSet.title] as const;
const lungNames = ['肺癌', '支气管或肺恶性肿瘤'] as const;
export const diagnosisAliases = [...nasopharynxNames, ...lungNames];
const lungValueSet = {
  compose: { include: [
    { system: ICD_10, concept: ['C34', 'C34.0', 'C34.1', 'C34.2', 'C34.3', 'C34.8', 'C34.9'].map(code => ({ code })) },
    { system: ICD_11, concept: ['2C25', '2C25.0', '2C25.1'].map(code => ({ code })) },
  ] },
};

export function diagnosisValueSet(name: string) {
  if (nasopharynxNames.some(term => term === name)) return nasopharynxValueSet;
  if (lungNames.some(term => term === name)) return lungValueSet;
  return undefined;
}

export function diagnosisCodingSystem(system: string | null, versionLabel: string | null) {
  if (system) return system;
  if (versionLabel === 'ICD-10') return ICD_10;
  if (versionLabel === 'ICD-11') return ICD_11;
  return null;
}


export interface IndexedDiagnosisTerm {
  title: string;
  code?: string;
}

let catalog: { index: string; terms: Promise<IndexedDiagnosisTerm[]> } | undefined;

export function indexedDiagnosisTerms(index: string) {
  if (catalog?.index === index) return catalog.terms;
  const terms = loadDiagnosisTerms(index);
  catalog = { index, terms };
  void terms.catch(() => { if (catalog?.terms === terms) catalog = undefined; });
  return terms;
}

async function loadDiagnosisTerms(index: string): Promise<IndexedDiagnosisTerm[]> {
  type Page = { aggregations: { terms: { after_key?: IndexedDiagnosisTerm; buckets: { key: IndexedDiagnosisTerm }[] } } };
  const sources = Object.entries({ title: 'title.keyword', code: 'code' })
    .map(([name, field]) => ({ [name]: { terms: { field, missing_bucket: name !== 'title' } } }));
  const terms: IndexedDiagnosisTerm[] = [];
  let after: IndexedDiagnosisTerm | undefined;
  do {
    const page: Page = await osRequest(`/${encodeURIComponent(index)}/_search?allow_partial_search_results=false`, 'POST', {
      size: 0,
      query: { term: { recordType: 'diagnosis' } },
      aggs: { terms: { composite: { size: 500, sources, ...(after ? { after } : {}) } } },
    });
    const aggregation = page.aggregations.terms;
    terms.push(...aggregation.buckets.map(bucket => bucket.key));
    after = aggregation.after_key;
  } while (after);
  return terms;
}

export function diagnosisName(term: IndexedDiagnosisTerm) {
  const title = term.title.normalize('NFKC').trim();
  const code = term.code?.normalize('NFKC');
  return code && title.startsWith(code) ? title.slice(code.length).trim() : title;
}
