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

export function diagnosisValueSet(name: string) {
  return name === '鼻咽癌' || name === nasopharynxValueSet.title ? nasopharynxValueSet : undefined;
}

export function diagnosisCodingSystem(system: string | null, versionLabel: string | null) {
  if (system) return system;
  if (versionLabel === 'ICD-10') return ICD_10;
  if (versionLabel === 'ICD-11') return ICD_11;
  return null;
}
