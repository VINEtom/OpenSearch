import pg from 'pg';
import { config } from '../config.js';
import type { Snapshot } from '../data.js';
import { AppError } from '../errors.js';
import { assembleReal, type RealDocument, type RealInput } from './assemble.js';

const prototypeNames = new Set(['pms_demo', 'emr_demo', 'rvs_demo']);
const pools = new Map<string, pg.Pool>();
const tumorText = [
  'TumorSiteDescription_ActualDose', 'TumorSiteDescription_Gauze', 'TumorSiteDescription_GynecologicalExamination',
  'TumorSiteDescription_IntrauterinePosition', 'TumorSiteDescription_SideEffect', 'TumorSiteDescription_SingleTubeHRCTVPosition',
  'TumorSiteDescription_SingleTubePosition', 'TumorSiteDescription_ThreeTubeHRCTV', 'TumorSiteDescription_ThreeTubeHRCTVPosition',
  'TumorSiteDescription_VaginalPosition', 'TumorSiteDescription_WaterInjectionVolume', 'TumorSiteDescription_CervixDescription',
  'TumorSiteDescription_HRCTVOtherDescription', 'TumorSiteDescription_TubeDepthInside', 'TumorSiteDescription_VaginOtherDescription',
  'TumorSiteDescription_VulvaOtherDescription', 'TumorSiteDescription_Dose', 'TumorSiteDescription_PrrauterineDescription',
];

function pool(database: string): pg.Pool {
  if (!config.real.host || !config.real.user) throw new AppError('REAL_SOURCE_CONFIG', '真实数据源未配置主机或账号。', 500);
  if (prototypeNames.has(database)) throw new AppError('UNSAFE_DATABASE', `拒绝把原型库当作真实数据源：${database}`, 500);
  let current = pools.get(database);
  if (!current) {
    current = new pg.Pool({
      host: config.real.host, port: config.real.port, user: config.real.user, password: config.real.password,
      database, connectionTimeoutMillis: 8000, statement_timeout: 120000, application_name: 'ois-search-real-readonly',
    });
    current.on('error', () => undefined);
    pools.set(database, current);
  }
  return current;
}

async function readOnly<T>(database: string, read: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool(database).connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError('SOURCE_UNAVAILABLE', `${database} 读取失败`, 503);
  } finally { client.release(); }
}

export async function closeRealPools(): Promise<void> {
  const current = [...pools.values()];
  pools.clear();
  await Promise.all(current.map(item => item.end()));
}

export async function readRealSnapshot(): Promise<Snapshot> {
  const pms = config.real.databases.pms;
  const emr = config.real.databases.emr;
  const [patients, clinical] = await Promise.all([
    readOnly(pms, async client => (await client.query(`
      SELECT id::text, patient_id AS "radiotherapyNo", patient_name_for_search AS name, sex,
        birthdate AS "birthDate", to_char(creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt",
        to_char(COALESCE(last_modification_time, creation_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt"
      FROM pms_patient WHERE NOT is_deleted ORDER BY id`)).rows),
    readOnly(emr, async client => {
      const diagnoses = (await client.query(`
        SELECT d.id::text, d.patient_index::text AS "patientId", d.name, d.icd_code AS code, icd.version AS "codeVersion",
          to_char(d.definite_diagnosis_date, 'YYYY-MM-DD') AS "definiteDate",
          d.clinical_description, d.remarks, d.method_description, d.family_history, d.other_tumor_history, d.additional_diagnosis,
          d.in_charge_doctor_name, d.attending_doctor_name,
          to_char(d.creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt",
          to_char(COALESCE(d.last_modification_time, d.creation_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt"
        FROM emr_diagnosis d
        LEFT JOIN LATERAL (
          SELECT "Version" AS version FROM emr_icd_template
          WHERE code = d.icd_code AND "Version" IS NOT NULL AND btrim("Version") <> ''
          ORDER BY "Version" LIMIT 1
        ) icd ON true
        WHERE NOT d.is_deleted AND d.status IS DISTINCT FROM 2 ORDER BY d.id`)).rows;
      const tumor = tumorText.map(name => `p."${name}"`).join(', ');
      const requests = (await client.query(`
        SELECT p.id::text, p.patient_guid::text AS "patientId", p.prescription_name AS title, p.course_id::text AS "courseId",
          p.prescription_type AS "prescriptionType",
          p.description, p.supplementary_advice, p.other_description, p.technique, p.treatment_equipment, p.accelerator_room,
          p.plan_system, p.contouring_system, p.clinic_name, p.protector_name, p.sensitizer_name,
          p.brachy_therapy_mr_description, p.first_visit_mr_description, ${tumor},
          targets.fractions, targets.sites, targets.sections,
          COALESCE(links.diagnosis_ids, '{}') AS "diagnosisIds",
          to_char(p.creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt",
          to_char(COALESCE(p.last_modification_time, p.creation_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt"
        FROM emr_prescription p
        LEFT JOIN LATERAL (
          SELECT max(equation_fraction) AS fractions,
            array_agg(DISTINCT prescription_site_name) FILTER (WHERE btrim(COALESCE(prescription_site_name, '')) <> '') AS sites,
            array_agg(DISTINCT target_section) FILTER (WHERE btrim(COALESCE(target_section, '')) <> '') AS sections
          FROM emr_prescription_target_doses WHERE "PrescriptionEntityId" = p.id
        ) targets ON true
        LEFT JOIN LATERAL (
          SELECT array_agg(diagnosis_id::text ORDER BY diagnosis_id) AS diagnosis_ids
          FROM emr_prescription_diagnosis_relation WHERE prescription_id = p.id
        ) links ON true
        WHERE NOT p.is_deleted AND p.is_enabled ORDER BY p.id`)).rows;
      const resets = new Set((await client.query('SELECT re_setup_order_id::text AS id FROM emr_re_setup_order_rx_relation')).rows.map(row => String(row.id)));
      const times = `to_char(creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt", to_char(COALESCE(last_modification_time, creation_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt"`;
      const sims = (await client.query(`SELECT id::text, patient_guid::text AS "patientId", title, course_id::text AS "courseId",
        immobilize_description, scan_description, immobilization_remarks, scan_remarks, past_history_list, delineate_audit_fail_reason,
        scan_site_list, treatment_site_name_list, localization_center, mark, technique, imaging_modality_key, mr_protocol,
        mr_scan_info_other_protocol, contouring_system_list, plan_system, to_char(open_finish_date_time, 'YYYY-MM-DD') AS "documentOn", ${times}
        FROM emr_sim_order WHERE NOT is_deleted AND is_enabled`)).rows;
      const ones = (await client.query(`SELECT id::text, patient_index::text AS "patientId", title, course_id::text AS "courseId",
        description, immobilize_description, site_name, protocol_template_name, scan_site_list, "ScanProtocolList",
        position_tolerance_name, treatment_tolerance_name, to_char(open_finish_date_time, 'YYYY-MM-DD') AS "documentOn", ${times}
        FROM emr_one_stop_order WHERE is_deleted IS NOT TRUE`)).rows;
      const exams = (await client.query(`SELECT id::text, patient_guid::text AS "patientId", title, course_id::text AS "courseId",
        appointment_type, remarks, to_char(appointment_date_time, 'YYYY-MM-DD') AS "documentOn", ${times}
        FROM emr_exam_appointment WHERE NOT is_deleted`)).rows;
      const customs = (await client.query(`SELECT id::text, patient_index::text AS "patientId", name AS title, course_id::text AS "courseId",
        description, regexp_replace(COALESCE(report_content, ''), '<[^>]+>', ' ', 'g') AS content,
        to_char(COALESCE(submission_date_time, creation_time), 'YYYY-MM-DD') AS "documentOn", ${times}
        FROM emr_custom_report WHERE is_deleted IS NOT TRUE`)).rows;
      const treats = (await client.query(`SELECT t.id::text, t.patient_guid::text AS "patientId", p.prescription_name AS title,
        t.prescription_id::text AS "prescriptionId", t.remark, to_char(t.approve_date_time, 'YYYY-MM-DD') AS "documentOn",
        to_char(t.creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt", to_char(t.creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt"
        FROM emr_treatment_order t LEFT JOIN emr_prescription p ON p.id = t.prescription_id`)).rows;
      return { diagnoses, requests, resets, sims, ones, exams, treats, customs };
    }),
  ]);
  const readAt = new Date().toISOString();
  const input: RealInput = {
    patients, readAt: { pms: readAt, emr: readAt, rvs: readAt },
    diagnoses: clinical.diagnoses.map(row => ({
      ...row, parts: [row.clinical_description, row.remarks, row.method_description, row.family_history, row.other_tumor_history, row.additional_diagnosis, row.in_charge_doctor_name, row.attending_doctor_name],
    })),
    requests: clinical.requests.map(row => ({
      id: row.id, patientId: row.patientId, title: row.title, fractions: row.fractions, diagnosisIds: row.diagnosisIds ?? [],
      courseId: row.courseId, documentType: requestKind(row.prescriptionType), createdAt: row.createdAt, updatedAt: row.updatedAt,
      parts: [row.description, row.supplementary_advice, row.other_description, row.technique, row.treatment_equipment, row.accelerator_room, row.plan_system, row.contouring_system, row.clinic_name, row.protector_name, row.sensitizer_name, row.brachy_therapy_mr_description, row.first_visit_mr_description, ...tumorText.map(name => row[name]), row.sites, row.sections],
    })),
    documents: [
      ...clinical.sims.map(row => documentFrom(row, clinical.resets.has(String(row.id)) ? '复位申请单' : '定位申请单', simParts)),
      ...clinical.ones.map(row => documentFrom(row, '一站式申请单', ['description', 'immobilize_description', 'site_name', 'protocol_template_name', 'scan_site_list', 'ScanProtocolList', 'position_tolerance_name', 'treatment_tolerance_name'])),
      ...clinical.exams.map(row => documentFrom(row, '检查预约单', ['appointment_type', 'remarks'])),
      ...clinical.treats.map(row => documentFrom(row, '治疗单', ['remark'], true)),
      ...clinical.customs.map(row => documentFrom(row, '自定义单据', ['description', 'content'])),
    ],
  };
  return assembleReal(input);
}

function requestKind(value: unknown): string {
  const type = Number(value);
  if (type === 1) return '后装申请单';
  if (type === 2) return '全身放疗申请单';
  return '计划申请单';
}

const simParts = ['immobilize_description', 'scan_description', 'immobilization_remarks', 'scan_remarks', 'past_history_list', 'delineate_audit_fail_reason', 'scan_site_list', 'treatment_site_name_list', 'localization_center', 'mark', 'technique', 'imaging_modality_key', 'mr_protocol', 'mr_scan_info_other_protocol', 'contouring_system_list', 'plan_system'];

function documentFrom(row: Record<string, unknown>, documentType: string, parts: string[], treatment = false): RealDocument {
  return {
    id: String(row.id), patientId: String(row.patientId), documentType,
    title: row.title == null ? null : String(row.title),
    parts: parts.map(name => row[name]),
    ...(documentType === '定位申请单' ? { imagingModalityKey: row.imaging_modality_key, scanSiteList: row.scan_site_list } : {}),
    documentOn: row.documentOn == null ? null : String(row.documentOn),
    courseId: row.courseId == null ? null : String(row.courseId),
    prescriptionId: row.prescriptionId == null ? null : String(row.prescriptionId),
    missingPrescription: treatment && row.title == null,
    createdAt: row.createdAt == null ? null : String(row.createdAt),
    updatedAt: row.updatedAt == null ? null : String(row.updatedAt),
  };
}
