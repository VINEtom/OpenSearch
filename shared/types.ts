export const SOURCES = ['pms', 'emr', 'rvs'] as const;
export type Source = (typeof SOURCES)[number];
export const RECORD_TYPES = ['patient', 'diagnosis', 'plan_request', 'treatment_plan', 'document'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const TYPE_LABELS: Record<RecordType, string> = {
  patient: '患者', diagnosis: '诊断', plan_request: '计划申请单', treatment_plan: '治疗计划', document: '其他单据',
};
export const TYPE_SOURCES: Record<RecordType, Source> = {
  patient: 'pms', diagnosis: 'emr', plan_request: 'emr', treatment_plan: 'rvs', document: 'emr',
};
export interface RecordDocument {
  id: string;
  batchId: string;
  source: Source;
  recordType: RecordType;
  sourceDatabase: string;
  sourceTable: string;
  sourceId: string;
  sourceRevision: number;
  patientId: string;
  patientRevision: number;
  radiotherapyNo: string;
  patientName: string;
  sex: string;
  birthDate: string | null;
  recordNo: string | null;
  title: string;
  bodyText: string | null;
  businessDate: string | null;
  updatedAt: string;
  diagnosisId: string | null;
  planRequestId: string | null;
  sourceDocumentId: string | null;
  confirmationStatus: string | null;
  planStatus: string | null;
  documentType: string | null;
  codeSystem: string | null;
  codeVersion: string | null;
  code: string | null;
  prescribedFractions?: number | null;
  diagnosisFilters?: { name: string; diagnosedOn: string; maxPrescribedFractions: number }[];
  missingFields: string[];
}
export interface MatchField {
  field: string;
  label: string;
  text: string;
  ranges: [number, number][];
}
export interface SearchHit extends RecordDocument { matchedFields: MatchField[] }
export interface SearchParams {
  q: string;
  scope?: 'all' | 'patient';
  patientId?: string;
  source?: Source | 'all';
  type?: RecordType | 'all';
  page?: number;
  batchId?: string;
}
export interface PatientSearchFilters {
  diagnosis: string;
  diagnosedFrom: string;
  diagnosedThrough: string;
  minimumFractions: number;
}
export interface SearchResponse {
  patientFilters?: PatientSearchFilters;
  q: string;
  scope: 'all' | 'patient';
  patientId?: string;
  source: Source | 'all';
  type: RecordType | 'all';
  page: number;
  pageSize: number;
  total: number;
  typeCounts: Record<RecordType, number>;
  batchId: string;
  syncedAt: string;
  hits: SearchHit[];
  elapsedMs: number;
}
export interface SyncAttempt {
  status: 'success' | 'failed';
  at: string;
  message: string;
  // A failed attempt can be recovered only when this candidate is the active alias target.
  publicationBatchId?: string;
}
export interface IndexStatus {
  state: 'ready' | 'not_synced' | 'unavailable';
  batchId: string | null;
  syncedAt: string | null;
  total: number | null;
  lastAttempt: SyncAttempt | null;
  warning?: string;
}
export interface Relation {
  label: string;
  source: Source;
  recordType: RecordType;
  sourceId: string;
  patientId: string;
  title: string;
  recordNo: string | null;
  availability: 'available' | 'deleted' | 'voided' | 'missing' | 'invalid';
}
export interface DetailField { name: string; label: string; value: string | null; kind?: 'text' | 'paragraph' | 'date' }
export interface DetailResponse {
  record: RecordDocument;
  patient: RecordDocument;
  fields: DetailField[];
  relations: Relation[];
}
export interface ApiError { error: { code: string; message: string } }

export interface DiagnosisPatientResponse {
  q: string;
  page: number;
  batchId: string;
  hasNext: boolean;
  patients: {
    patientId: string;
    patientName: string;
    radiotherapyNo: string;
    diagnosisId: string;
    diagnosisName: string;
    diagnosedOn: string | null;
  }[];
}
