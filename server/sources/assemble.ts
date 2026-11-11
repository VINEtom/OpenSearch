import { normalizeLocalizationSite } from '../../shared/simulation-fields.js';
import { AppError } from '../errors.js';
import type { DiagnosisRow, DocumentRow, PatientRow, PlanRequestRow, Snapshot } from '../data.js';
import type { PatientField, SimulationSourceFields, SourceDefect } from '../../shared/types.js';
import { calendarDate, fieldValues, joinText, plain, timestamp } from './text.js';

const stamp = '1970-01-01T00:00:00';
export interface RealPatient {
  id: string;
  radiotherapyNo: string | null;
  name: string | null;
  sex: number | null;
  birthDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  fields?: PatientField[];
}
export interface RealDiagnosis {
  id: string;
  patientId: string;
  name: string | null;
  code: string | null;
  codeVersion: string | null;
  definiteDate: string | null;
  parts: unknown[];
  fields?: PatientField[];
  createdAt: string | null;
  updatedAt: string | null;
}
export interface RealRequest {
  id: string;
  patientId: string;
  title: string | null;
  parts: unknown[];
  fractions: number | null;
  diagnosisIds: string[];
  courseId: string | null;
  documentType?: string | null;
  fields?: PatientField[];
  createdAt: string | null;
  updatedAt: string | null;
}
export interface RealDocument {
  id: string;
  patientId: string;
  documentType: string;
  title: string | null;
  parts: unknown[];
  fields?: PatientField[];
  documentOn: string | null;
  courseId: string | null;
  prescriptionId: string | null;
  simulationSourceFields?: SimulationSourceFields;
  imagingModalityKey?: unknown;
  scanSiteList?: unknown;
  missingPrescription?: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface RealInput {
  patients: RealPatient[];
  diagnoses: RealDiagnosis[];
  requests: RealRequest[];
  documents: RealDocument[];
  readAt: Snapshot['readAt'];
}

function sexOf(value: number | null): PatientRow['sex'] {
  if (value === 1) return 'male';
  if (value === 2) return 'female';
  if (value === 3) return 'other';
  return 'unknown';
}
function rowTimes(createdAt: string | null, updatedAt: string | null): { created_at: string; updated_at: string } {
  const created = timestamp(createdAt, stamp);
  const updated = timestamp(updatedAt, created);
  return { created_at: created, updated_at: Date.parse(updated) < Date.parse(created) ? created : updated };
}
function base(id: string, createdAt: string | null, updatedAt: string | null) {
  return { id, ...rowTimes(createdAt, updatedAt), revision: 1, deleted_at: null };
}

export function assembleReal(input: RealInput): Snapshot & { defects: SourceDefect[] } {
  const defects: SourceDefect[] = [];
  const patients = new Map<string, PatientRow>();
  for (const row of input.patients) {
    const name = plain(row.name);
    const radiotherapyNo = plain(row.radiotherapyNo);
    if (!name || !radiotherapyNo) continue;
    patients.set(row.id, {
      ...base(row.id, row.createdAt, row.updatedAt),
      radiotherapy_no: radiotherapyNo, name, sex: sexOf(row.sex), birth_date: calendarDate(row.birthDate),
      ...(row.fields?.length ? { fields: row.fields } : {}),
    });
  }
  function keptPatient(recordType: SourceDefect['recordType'], id: string, patientId: string): boolean {
    if (patients.has(patientId)) return true;
    defects.push({ recordType, sourceId: id, reason: '患者不在 PMS 中' });
    return false;
  }
  const diagnoses: DiagnosisRow[] = [];
  const diagnosisIds = new Set<string>();
  for (const row of input.diagnoses) {
    if (!keptPatient('diagnosis', row.id, row.patientId)) continue;
    const name = plain(row.name);
    if (!name) {
      defects.push({ recordType: 'diagnosis', sourceId: row.id, reason: '诊断名称为空' });
      continue;
    }
    diagnosisIds.add(row.id);
    const diagnosedOn = calendarDate(row.definiteDate);
    diagnoses.push({
      ...base(row.id, row.createdAt, row.updatedAt), patient_id: row.patientId, voided_at: null,
      diagnosis_name: name, code_system: null, code_version: plain(row.codeVersion), code: plain(row.code),
      confirmation_status: diagnosedOn ? 'confirmed' : 'unknown', diagnosed_on: diagnosedOn,
      source_document_id: null, summary: joinText(row.parts),
      ...(row.fields?.length ? { fields: row.fields } : {}),
    });
  }
  const requests: PlanRequestRow[] = [];
  const requestDiagnosis = new Map(input.diagnoses.map(row => [row.id, row.patientId]));
  for (const row of input.requests) {
    if (!keptPatient('plan_request', row.id, row.patientId)) continue;
    const missing = row.diagnosisIds.find(id => !requestDiagnosis.has(id));
    if (missing) throw new AppError('RELATION_ERROR', `关联诊断不存在：${missing}`, 409);
    const otherPatient = row.diagnosisIds.find(id => requestDiagnosis.get(id) !== row.patientId);
    if (otherPatient) throw new AppError('RELATION_ERROR', `关联诊断与患者不一致：${otherPatient}`, 409);
    const linked = row.diagnosisIds.filter(id => diagnosisIds.has(id));
    const title = plain(row.title);
    if (!title || linked.length < 1) {
      defects.push({ recordType: 'plan_request', sourceId: row.id, reason: !title ? '申请单标题为空' : '申请单没有关联具体诊断' });
      continue;
    }
    const fractions = row.fractions;
    requests.push({
      ...base(row.id, row.createdAt, row.updatedAt), patient_id: row.patientId, voided_at: null,
      diagnosis_ids: [...new Set(linked)].sort(), request_no: null, document_type: plain(row.documentType) || '计划申请单',
      title, body_text: joinText(row.parts), requested_on: null,
      prescribed_fractions: Number.isInteger(fractions) && fractions! > 0 ? fractions : null,
      course_id: row.courseId,
      ...(row.fields?.length ? { fields: row.fields } : {}),
    });
  }
  const documents: DocumentRow[] = [];
  for (const row of input.documents) {
    if (!keptPatient('document', row.id, row.patientId)) continue;
    const title = plain(row.title);
    if (!title || row.missingPrescription) {
      defects.push({ recordType: 'document', sourceId: row.id, reason: row.missingPrescription ? '治疗单关联的计划申请单不存在' : '单据标题为空' });
      continue;
    }
    documents.push({
      ...base(row.id, row.createdAt, row.updatedAt), patient_id: row.patientId, voided_at: null,
      document_type: row.documentType, title, body_text: joinText(row.parts), document_on: calendarDate(row.documentOn),
      course_id: row.courseId, prescription_id: row.prescriptionId,
      ...(row.fields?.length ? { fields: row.fields } : {}),
      ...(row.documentType === '定位申请单' && row.simulationSourceFields ? { simulation_source_fields: row.simulationSourceFields } : {}),
      ...(row.documentType === '定位申请单' && 'imagingModalityKey' in row && 'scanSiteList' in row ? {
        imaging_modality: fieldValues(row.imagingModalityKey)[0]?.toUpperCase() ?? null,
        localization_sites: [...new Set(fieldValues(row.scanSiteList).map(normalizeLocalizationSite))].sort(),
      } : {}),
    });
  }
  return { patients: [...patients.values()], diagnoses, planRequests: requests, documents, treatmentPlans: [], readAt: input.readAt, defects };
}
