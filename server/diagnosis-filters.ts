import type { RecordDocument } from '../shared/types.js';
import { diagnosisCodingSystem } from './diagnosis-terminology.js';

export function withDiagnosisFilters(records: RecordDocument[]): RecordDocument[] {
  const maxByDiagnosis = new Map<string, number>();
  for (const record of records) {
    if (record.recordType !== 'plan_request' || record.prescribedFractions == null) continue;
    for (const diagnosisId of record.diagnosisIds ?? []) {
      const key = `${record.patientId}:${diagnosisId}`;
      maxByDiagnosis.set(key, Math.max(maxByDiagnosis.get(key) ?? 0, record.prescribedFractions));
    }
  }

  const byPatient = new Map<string, NonNullable<RecordDocument['diagnosisFilters']>>();
  for (const record of records) {
    if (record.recordType !== 'diagnosis' || record.confirmationStatus !== 'confirmed' || !record.businessDate) continue;
    const filters = byPatient.get(record.patientId) ?? [];
    filters.push({
      name: record.title,
      diagnosedOn: record.businessDate,
      codingSystem: diagnosisCodingSystem(record.codeSystem, record.codeVersion),
      code: record.code,
      maxPrescribedFractions: maxByDiagnosis.get(`${record.patientId}:${record.sourceId}`) ?? null,
    });
    byPatient.set(record.patientId, filters);
  }
  return records.map(record => record.recordType === 'patient'
    ? { ...record, diagnosisFilters: byPatient.get(record.patientId) ?? [] }
    : record);
}
