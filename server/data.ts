import pg from 'pg';
import { config } from './config.js';
import { fillJump } from './sources/jump.js';
import { patientProfileText } from './sources/patient-profile.js';
import { AppError } from './errors.js';
import { RECORD_TYPES, SOURCES, TYPE_SOURCES, type DetailField, type DetailResponse, type PatientField, type RecordDocument, type RecordType, type Relation, type Source, type SourceDefect } from '../shared/types.js';

export interface BaseRow {
  id: string;
  created_at: string;
  updated_at: string;
  revision: number;
  deleted_at: string | null;
}
export interface PatientRow extends BaseRow {
  radiotherapy_no: string;
  name: string;
  sex: 'female' | 'male' | 'other' | 'unknown';
  birth_date: string | null;
  fields?: PatientField[];
}
export interface ClinicalRow extends BaseRow { patient_id: string; voided_at: string | null }
export interface DiagnosisRow extends ClinicalRow {
  diagnosis_name: string;
  code_system: string | null;
  code_version: string | null;
  code: string | null;
  confirmation_status: 'confirmed' | 'suspected' | 'refuted' | 'unknown';
  diagnosed_on: string | null;
  source_document_id: string | null;
  summary: string | null;
}
export interface PlanRequestRow extends ClinicalRow {
  diagnosis_ids: string[];
  request_no: string | null;
  course_id?: string | null;
  title: string;
  body_text: string | null;
  requested_on: string | null;
  prescribed_fractions: number | null;
  document_type?: string | null;
}
export interface DocumentRow extends ClinicalRow {
  document_type: string;
  title: string;
  body_text: string | null;
  document_on: string | null;
  course_id?: string | null;
  prescription_id?: string | null;
  imaging_modality?: string | null;
  localization_sites?: string[];
}
export interface TreatmentPlanRow extends ClinicalRow {
  plan_request_id: string;
  plan_no: string;
  name: string;
  status: string | null;
  notes: string | null;
  planned_on: string | null;
}
export interface Snapshot {
  patients: PatientRow[];
  diagnoses: DiagnosisRow[];
  planRequests: PlanRequestRow[];
  documents: DocumentRow[];
  treatmentPlans: TreatmentPlanRow[];
  readAt?: Record<Source, string>;
  defects?: SourceDefect[];
}
type Row = PatientRow | DiagnosisRow | PlanRequestRow | DocumentRow | TreatmentPlanRow;
const tables: Record<RecordType, string> = { patient: 'patients', diagnosis: 'diagnoses', plan_request: 'plan_requests', document: 'documents', treatment_plan: 'treatment_plans' };
const databaseNames: Record<Source, string> = { pms: 'pms_demo', emr: 'emr_demo', rvs: 'rvs_demo' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pools = new Map<Source, pg.Pool>();

export function assertPrototypeDatabases(): void {
  for (const source of SOURCES) {
    if (config.databases[source] !== databaseNames[source]) {
      throw new AppError('UNSAFE_DATABASE', `拒绝连接非原型数据库：${source}`, 500);
    }
  }
}

export function getPool(source: Source): pg.Pool {
  assertPrototypeDatabases();
  if (!SOURCES.includes(source)) throw new AppError('INVALID_SOURCE', '来源无效');
  let pool = pools.get(source);
  if (!pool) {
    pool = new pg.Pool({
      host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword,
      database: databaseNames[source], connectionTimeoutMillis: 5000, statement_timeout: 10000,
      application_name: 'ois-search-prototype',
      // Keep DATE values as calendar dates; pg's local-time Date conversion can shift them.
      types: { getTypeParser(oid: number, format?: string) {
        if (oid === 1082 || oid === 1184) return (value: string) => value;
        return pg.types.getTypeParser(oid, format as 'text' | 'binary');
      } },
    });
    pool.on('error', () => { /* A failed idle connection is replaced on the next query. */ });
    pools.set(source, pool);
  }
  return pool;
}

export async function closePools(): Promise<void> {
  const current = [...pools.values()];
  pools.clear();
  const { closeRealPools } = await import('./sources/real.js');
  await Promise.all([...current.map(pool => pool.end()), closeRealPools()]);
}

function normalizeRows<T extends Row>(rows: Record<string, unknown>[]): T[] {
  return rows.map(row => ({ ...row, revision: Number(row.revision) }) as unknown as T);
}

export async function readSnapshot(): Promise<Snapshot> {
  if (config.sourceMode === 'real') {
    const { readRealSnapshot } = await import('./sources/real.js');
    return readRealSnapshot();
  }
  assertPrototypeDatabases();
  const readAt = {} as Record<Source, string>;
  async function readSource(source: Source, names: string[]): Promise<Record<string, unknown>[][]> {
    let client: pg.PoolClient | undefined;
    try {
      client = await getPool(source).connect();
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result: Record<string, unknown>[][] = [];
      for (const name of names) {
        const sql = name === 'plan_requests'
          ? `SELECT request.id, request.created_at, request.updated_at, request.revision, request.deleted_at, request.voided_at,
              request.patient_id, request.request_no, request.title, request.body_text, request.requested_on, request.prescribed_fractions,
              COALESCE((SELECT array_agg(link.diagnosis_id ORDER BY link.diagnosis_id) FROM plan_request_diagnoses AS link WHERE link.plan_request_id = request.id), '{}') AS diagnosis_ids
            FROM plan_requests AS request ORDER BY request.id`
          : `SELECT * FROM ${name} ORDER BY id`;
        result.push((await client.query(sql)).rows);
      }
      await client.query('COMMIT');
      readAt[source] = new Date().toISOString();
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError('SOURCE_UNAVAILABLE', `${source.toUpperCase()} 原型数据读取失败`, 503);
    } finally { client?.release(); }
  }
  const [pms, emr, rvs] = await Promise.all([
    readSource('pms', ['patients']), readSource('emr', ['diagnoses', 'plan_requests', 'documents']),
    readSource('rvs', ['treatment_plans']),
  ]);
  return {
    patients: normalizeRows<PatientRow>(pms[0]), diagnoses: normalizeRows<DiagnosisRow>(emr[0]),
    planRequests: normalizeRows<PlanRequestRow>(emr[1]), documents: normalizeRows<DocumentRow>(emr[2]),
    treatmentPlans: normalizeRows<TreatmentPlanRow>(rvs[0]), readAt,
  };
}

function rowsByType(snapshot: Snapshot): Record<RecordType, Row[]> {
  return { patient: snapshot.patients, diagnosis: snapshot.diagnoses, plan_request: snapshot.planRequests, document: snapshot.documents, treatment_plan: snapshot.treatmentPlans };
}
function badData(message: string): never { throw new AppError('INVALID_SOURCE_DATA', message, 409); }
function badRelation(message: string): never { throw new AppError('RELATION_ERROR', message, 409); }
function nonblank(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function checkDate(value: unknown, nullable: boolean, field: string): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) badData(`${field} 不是有效业务日期`);
}
function checkTime(value: unknown, nullable: boolean, field: string): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value) || Number.isNaN(Date.parse(value))) badData(`${field} 不是有效时间`);
}
function checkText(value: unknown, field: string): void {
  if (value !== null && typeof value !== 'string') badData(`${field} 必须为文本或 NULL`);
}
function validateRow(type: RecordType, row: Row, real = false): void {
  const data = row as unknown as Record<string, unknown>;
  if (!uuid.test(row.id)) badData(`${type} 的 UUID 无效`);
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) badData(`${type}:${row.id} 版本无效`);
  checkTime(row.created_at, false, 'created_at'); checkTime(row.updated_at, false, 'updated_at');
  checkTime(row.deleted_at, true, 'deleted_at');
  if (Date.parse(row.updated_at) < Date.parse(row.created_at)) badData(`${type}:${row.id} 更新时间早于创建时间`);
  if (type !== 'patient') {
    if (typeof data.patient_id !== 'string' || !uuid.test(data.patient_id)) badData(`${type}:${row.id} 患者 UUID 无效`);
    checkTime(data.voided_at, true, 'voided_at');
  }
  const required: Record<RecordType, string[]> = {
    patient: ['radiotherapy_no', 'name'], diagnosis: ['diagnosis_name'],
    plan_request: real ? ['title'] : ['request_no', 'title'], document: ['document_type', 'title'], treatment_plan: ['plan_no', 'name'],
  };
  for (const field of required[type]) if (!nonblank(data[field])) badData(`${type}:${row.id} 的 ${field} 不能为空`);
  const dateField = { patient: 'birth_date', diagnosis: 'diagnosed_on', plan_request: 'requested_on', document: 'document_on', treatment_plan: 'planned_on' }[type];
  checkDate(data[dateField], true, dateField);
  if (type === 'patient' && !['female', 'male', 'other', 'unknown'].includes(String(data.sex))) badData(`患者 ${row.id} 性别无效`);
  if (type === 'diagnosis') {
    if (!['confirmed', 'suspected', 'refuted', 'unknown'].includes(String(data.confirmation_status))) badData(`诊断 ${row.id} 确认状态无效`);
    const codes = [data.code_system, data.code_version, data.code];
    if (!real && !codes.every(value => value === null) && !codes.every(nonblank)) badData(`诊断 ${row.id} 编码必须成套填写`);
    if (data.source_document_id !== null && (typeof data.source_document_id !== 'string' || !uuid.test(data.source_document_id))) badData(`诊断 ${row.id} 来源单据 UUID 无效`);
    checkText(data.summary, 'summary');
  }
  if (type === 'plan_request') {
    const diagnosisIds = (row as PlanRequestRow).diagnosis_ids;
    if (!Array.isArray(diagnosisIds) || diagnosisIds.some(value => typeof value !== 'string' || !uuid.test(value)) || new Set(diagnosisIds).size !== diagnosisIds.length) {
      badData(`申请单 ${row.id} 的关联诊断无效`);
    }
    const fractions = (row as PlanRequestRow).prescribed_fractions;
    if (fractions !== null && (!Number.isInteger(fractions) || fractions < 1 || fractions > 2147483647)) badData('处方分次数必须为正整数或 NULL');
  }
  if (type === 'plan_request' || type === 'document') checkText(data.body_text, 'body_text');
  if (type === 'treatment_plan') { checkText(data.notes, 'notes'); checkText(data.status, 'status'); }
}

function mapsFor(snapshot: Snapshot) {
  return {
    patients: new Map(snapshot.patients.map(row => [row.id, row])),
    diagnoses: new Map(snapshot.diagnoses.map(row => [row.id, row])),
    requests: new Map(snapshot.planRequests.map(row => [row.id, row])),
    documents: new Map(snapshot.documents.map(row => [row.id, row])),
  };
}
function requireRelation<T extends ClinicalRow>(map: Map<string, T>, id: string, patientId: string, label: string): T {
  const target = map.get(id);
  if (!target) badRelation(`${label}不存在：${id}`);
  if (target.patient_id !== patientId) badRelation(`${label}与患者不一致：${id}`);
  return target;
}
function validateRelations(type: RecordType, row: Row, maps: ReturnType<typeof mapsFor>): void {
  if (type === 'patient') return;
  const patientId = (row as ClinicalRow).patient_id;
  if (!maps.patients.has(patientId)) badRelation(`所属患者不存在：${patientId}`);
  const diagnoses: DiagnosisRow[] = [];
  if (type === 'diagnosis') diagnoses.push(row as DiagnosisRow);
  if (type === 'plan_request' || type === 'treatment_plan') {
    const request = type === 'plan_request' ? row as PlanRequestRow : requireRelation(maps.requests, (row as TreatmentPlanRow).plan_request_id, patientId, '来源申请单');
    if (request.diagnosis_ids.length < 1) badRelation(`申请单没有关联具体诊断：${request.id}`);
    for (const diagnosisId of request.diagnosis_ids) diagnoses.push(requireRelation(maps.diagnoses, diagnosisId, patientId, '关联诊断'));
  }
  for (const linked of diagnoses) if (linked.source_document_id) requireRelation(maps.documents, linked.source_document_id, patientId, '诊断来源单据');
}

export function validateSnapshot(snapshot: Snapshot, options: { real?: boolean } = {}): void {
  const groups = rowsByType(snapshot);
  const maps = mapsFor(snapshot);
  for (const type of RECORD_TYPES) {
    const seen = new Set<string>();
    for (const row of groups[type]) {
      if (seen.has(row.id)) badData(`${type} 重复 UUID：${row.id}`);
      seen.add(row.id);
      validateRow(type, row, options.real);
      validateRelations(type, row, maps);
    }
  }
  for (const [rows, key] of [[snapshot.patients, 'radiotherapy_no'], [snapshot.planRequests, 'request_no'], [snapshot.treatmentPlans, 'plan_no']] as const) {
    const seen = new Set<string>();
    for (const row of rows) {
      const value = (row as unknown as Record<string, string | null>)[key];
      if (options.real && (value === null || value === '')) continue;
      if (value !== null && seen.has(value)) badData(`重复编号 ${key}：${value}`);
      if (value !== null) seen.add(value);
    }
  }
}

function availability(row: Row): Relation['availability'] {
  if (row.deleted_at) return 'deleted';
  if ('voided_at' in row && row.voided_at) return 'voided';
  return 'available';
}
function projectRow(type: RecordType, row: Row, patient: PatientRow, batchId: string, snapshot: Snapshot): RecordDocument {
  const source = TYPE_SOURCES[type];
  const document: RecordDocument = {
    id: `${source}:${type}:${row.id}`, batchId, source, recordType: type, sourceDatabase: databaseNames[source],
    sourceTable: tables[type], sourceId: row.id, sourceRevision: row.revision,
    patientId: patient.id, patientRevision: patient.revision, radiotherapyNo: patient.radiotherapy_no,
    patientName: patient.name, sex: patient.sex, birthDate: patient.birth_date,
    recordNo: null, title: '', bodyText: null, businessDate: null, updatedAt: new Date(row.updated_at).toISOString(),
    diagnosisIds: null, planRequestId: null, sourceDocumentId: null, confirmationStatus: null,
    planStatus: null, documentType: null, codeSystem: null, codeVersion: null, code: null, missingFields: [],
  };
  if (type === 'patient') {
    document.title = patient.name;
    const sexLabel = { male: '男', female: '女', other: '其他', unknown: '未知' }[patient.sex];
    const fields = [...(patient.fields ?? [])];
    if (sexLabel && !fields.some(field => field.label === '性别')) fields.unshift({ label: '性别', value: sexLabel });
    if (fields.length) {
      document.patientFields = fields;
      const profile = patientProfileText(fields);
      if (profile) document.patientProfile = profile;
    }
  }
  if (type === 'diagnosis') {
    const value = row as DiagnosisRow;
    Object.assign(document, { title: value.diagnosis_name, bodyText: value.summary, businessDate: value.diagnosed_on,
      sourceDocumentId: value.source_document_id, confirmationStatus: value.confirmation_status,
      codeSystem: value.code_system, codeVersion: value.code_version, code: value.code });
  }
  if (type === 'plan_request') {
    const value = row as PlanRequestRow;
    Object.assign(document, { title: value.title, bodyText: value.body_text, recordNo: value.request_no,
      businessDate: value.requested_on, diagnosisIds: [...value.diagnosis_ids].sort(), prescribedFractions: value.prescribed_fractions,
      documentType: value.document_type || '计划申请单' });
  }
  if (type === 'document') {
    const value = row as DocumentRow;
    Object.assign(document, { title: value.title, bodyText: value.body_text, businessDate: value.document_on, documentType: value.document_type });
    if (value.document_type === '定位申请单' && value.imaging_modality !== undefined && value.localization_sites !== undefined) {
      document.imagingModality = value.imaging_modality;
      document.localizationSites = value.localization_sites;
    }
  }
  if (type === 'treatment_plan') {
    const value = row as TreatmentPlanRow;
    Object.assign(document, { title: value.name, bodyText: value.notes, recordNo: value.plan_no,
      businessDate: value.planned_on, planRequestId: value.plan_request_id, planStatus: value.status,
      diagnosisIds: [...(snapshot.planRequests.find(request => request.id === value.plan_request_id)?.diagnosis_ids ?? [])].sort() });
  }
  const expected: (keyof RecordDocument)[] = ['birthDate'];
  if (type !== 'patient') expected.push('businessDate', 'bodyText');
  if (type === 'diagnosis') expected.push('codeSystem', 'codeVersion', 'code');
  if (type === 'treatment_plan') expected.push('planStatus');
  document.missingFields = expected.filter(field => document[field] === null || document[field] === '');
  return document;
}

export function projectRecords(snapshot: Snapshot, batchId: string): RecordDocument[] {
  validateSnapshot(snapshot, { real: config.sourceMode === 'real' });
  const patients = new Map(snapshot.patients.map(row => [row.id, row]));
  const groups = rowsByType(snapshot);
  return RECORD_TYPES.flatMap(type => groups[type].flatMap(row => {
    const patient = patients.get(type === 'patient' ? row.id : (row as ClinicalRow).patient_id)!;
    if (availability(row) !== 'available' || availability(patient) !== 'available') return [];
    return [projectRow(type, row, patient, batchId, snapshot)];
  }));
}

function detailFields(record: RecordDocument): DetailField[] {
  const fields: DetailField[] = [
    { name: 'title', label: record.recordType === 'patient' ? '患者姓名' : '名称 / 标题', value: record.title },
    { name: 'patientName', label: '所属患者', value: record.patientName },
    { name: 'radiotherapyNo', label: '放疗号', value: record.radiotherapyNo },
    { name: 'sex', label: '性别', value: record.sex },
    { name: 'birthDate', label: '出生日期', value: record.birthDate, kind: 'date' },
  ];
  if (record.recordType === 'patient') {
    for (const field of record.patientFields ?? []) fields.push({ name: 'patientFields', label: field.label, value: field.value });
  }
  if (record.recordType !== 'patient') fields.push({ name: 'businessDate', label: '业务日期', value: record.businessDate, kind: 'date' });
  if (record.recordType === 'diagnosis') fields.push(
    { name: 'confirmationStatus', label: '确认状态', value: record.confirmationStatus },
    { name: 'codeSystem', label: '编码体系', value: record.codeSystem },
    { name: 'codeVersion', label: '编码版本', value: record.codeVersion },
    { name: 'code', label: '诊断编码', value: record.code },
  );
  if (record.recordType === 'plan_request' || record.recordType === 'treatment_plan') fields.push({ name: 'recordNo', label: record.recordType === 'plan_request' ? '申请单编号' : '计划编号', value: record.recordNo });
  if (record.recordType === 'plan_request') fields.push({
    name: 'prescribedFractions', label: '处方分次数',
    value: record.prescribedFractions == null ? null : String(record.prescribedFractions),
  });
  if (record.recordType === 'document') fields.push({ name: 'documentType', label: '单据类型', value: record.documentType });
  if (record.recordType === 'treatment_plan') fields.push({ name: 'planStatus', label: '计划状态', value: record.planStatus });
  const bodyLabel: Partial<Record<RecordType, string>> = { diagnosis: '诊断说明', plan_request: '申请内容', document: '单据正文', treatment_plan: '计划备注' };
  if (record.recordType !== 'patient') fields.push({ name: 'bodyText', label: bodyLabel[record.recordType]!, value: record.bodyText, kind: 'paragraph' });
  return fields;
}

export function detailFromSnapshot(snapshot: Snapshot, source: Source, type: RecordType, id: string): DetailResponse {
  if (!SOURCES.includes(source) || !RECORD_TYPES.includes(type) || TYPE_SOURCES[type] !== source || !uuid.test(id)) {
    throw new AppError('INVALID_TARGET', '记录来源、类型或 UUID 无效');
  }
  const groups = rowsByType(snapshot);
  id = id.toLowerCase();
  const row = groups[type].find(value => value.id === id);
  if (!row) throw new AppError('NOT_FOUND', '记录不存在', 404);
  const maps = mapsFor(snapshot);
  const patientId = type === 'patient' ? row.id : (row as ClinicalRow).patient_id;
  const patient = maps.patients.get(patientId);
  if (!patient) badRelation(`所属患者不存在：${patientId}`);
  if (patient.deleted_at) throw new AppError('PATIENT_DELETED', '所属患者已删除', 410);
  if (row.deleted_at) throw new AppError('DELETED', '记录已删除', 410);
  if ('voided_at' in row && row.voided_at) throw new AppError('VOIDED', '记录已作废', 410);
  validateRow(type, row, config.sourceMode === 'real');
  validateRelations(type, row, maps);
  const record = projectRow(type, row, patient, 'live', snapshot);
  const relations: Relation[] = [];
  function add(relatedType: RecordType, target: Row, label: string): void {
    const actualPatientId = relatedType === 'patient' ? target.id : (target as ClinicalRow).patient_id;
    const valid = actualPatientId === patientId;
    const projected = projectRow(relatedType, target, patient!, 'live', snapshot);
    let state = availability(target);
    if (!valid) state = 'invalid';
    else {
      try { validateRelations(relatedType, target, maps); } catch { state = 'invalid'; }
    }
    relations.push({ label, source: TYPE_SOURCES[relatedType], recordType: relatedType, sourceId: target.id,
      patientId, title: valid ? projected.title : '患者关联不一致', recordNo: valid ? projected.recordNo : null, availability: state });
  }
  if (type !== 'patient') add('patient', patient, '所属患者');
  if (type === 'patient') {
    for (const childType of RECORD_TYPES.filter(value => value !== 'patient')) {
      for (const child of groups[childType]) if ((child as ClinicalRow).patient_id === patientId) {
        const label = childType === 'plan_request' ? (child as PlanRequestRow).document_type || '计划申请单' : childType === 'document' ? (child as DocumentRow).document_type : childType === 'diagnosis' ? '诊断' : '治疗计划';
        add(childType, child, label);
      }
    }
  }
  if (type === 'diagnosis') {
    const diagnosis = row as DiagnosisRow;
    if (diagnosis.source_document_id) add('document', maps.documents.get(diagnosis.source_document_id)!, '来源单据');
    for (const request of snapshot.planRequests.filter(value => value.diagnosis_ids.includes(id))) {
      add('plan_request', request, '关联申请单');
      if (request.patient_id === patientId) {
        for (const plan of snapshot.treatmentPlans.filter(value => value.plan_request_id === request.id && value.patient_id === patientId)) {
          add('treatment_plan', plan, '诊断下的治疗计划');
        }
      }
    }
  }
  if (type === 'plan_request') {
    for (const diagnosisId of (row as PlanRequestRow).diagnosis_ids) add('diagnosis', maps.diagnoses.get(diagnosisId)!, '关联诊断');
    for (const plan of snapshot.treatmentPlans.filter(value => value.plan_request_id === id)) add('treatment_plan', plan, '关联治疗计划');
  }
  if (type === 'treatment_plan') {
    const request = maps.requests.get((row as TreatmentPlanRow).plan_request_id)!;
    add('plan_request', request, '来源申请单');
    for (const diagnosisId of request.diagnosis_ids) add('diagnosis', maps.diagnoses.get(diagnosisId)!, '关联诊断');
  }
  if (type === 'document') for (const diagnosis of snapshot.diagnoses.filter(value => value.source_document_id === id)) add('diagnosis', diagnosis, '引用本单据的诊断');
  return { record, patient: projectRow('patient', patient, patient, 'live', snapshot), fields: detailFields(record), relations, jumpUrl: jumpUrlFor(type, row, patientId) };
}

function jumpUrlFor(type: RecordType, row: Row, patientId: string): string | null {
  if (config.sourceMode !== 'real') return null;
  return fillJump(config.jump, type, type === 'document' ? (row as DocumentRow).document_type : '', {
    sourceId: row.id, patientId,
    courseId: 'course_id' in row ? row.course_id : null,
    prescriptionId: 'prescription_id' in row ? row.prescription_id : null,
  });
}

export async function loadDetail(source: Source, type: RecordType, id: string): Promise<DetailResponse> {
  if (!SOURCES.includes(source) || !RECORD_TYPES.includes(type) || TYPE_SOURCES[type] !== source || !uuid.test(id)) {
    throw new AppError('INVALID_TARGET', '记录来源、类型或 UUID 无效');
  }
  return detailFromSnapshot(await readSnapshot(), source, type, id);
}
