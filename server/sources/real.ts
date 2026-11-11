import pg from 'pg';
import { config } from '../config.js';
import type { Snapshot } from '../data.js';
import { AppError } from '../errors.js';
import { assembleReal, type RealDocument, type RealInput, type RealPatient } from './assemble.js';
import { patientProfileFields } from './patient-profile.js';
import { diagnosisSpecs, documentFieldSpecs, requestFieldSpecs, splitRecordFields, treatGoalLabel, type FieldSpec } from './record-fields.js';
import { htmlToText, plain } from './text.js';

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
  const [patientSource, clinical] = await Promise.all([
    readOnly(pms, async client => {
      const rows = (await client.query(`
        SELECT id::text, patient_id AS "radiotherapyNo", patient_name_for_search AS name, sex,
          birthdate AS "birthDate", to_char(creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt",
          to_char(COALESCE(last_modification_time, creation_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt",
          chinese_phonetic_for_search, phonetic_first_letter, admission_id, medical_treatment_number,
          patient_national, patient_country, id_type, identity_number, medical_insurance, height, patient_type,
          radiation_type, tags, research_in_group, attending_doctor_id::text, in_charge_doctor_id::text,
          in_charge_doctor_name, resident_doctor_id::text, radiation_therapist_id::text, obsterical_history,
          drinking_history, smoking_history, children_number, signature_type, outpatient_number, registration_number,
          ssn_number, id_one, id_two, id_three, id_four, hospitalized_count, doctor_group, patient_source,
          hospitalized_department, hospital_start_date, hospital_end_date, hospitalization_ward, sickbed_number,
          admission_number, referral_hospital, hospital_department, home_phone, telephone_number, mobile_phone_two,
          office_phone, e_mail, fax, other_number, domicile_zip_code, domicile_province, domicile_details,
          live_address_zip_code, live_address_province, live_address_details, live_address_tag, professional,
          other_description, to_char(register_date_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS register_date_time, registrar,
          first_visit_doctor
        FROM pms_patient WHERE NOT is_deleted ORDER BY id`)).rows as Record<string, unknown>[];
      const doctors = await client.query('SELECT doctor_id::text AS id, doctor_name AS name FROM pms_doctor_information');
      const contacts = await client.query('SELECT patient_index::text AS patient_id, relation, name, phone_one, phone_two FROM pms_patient_contact_info ORDER BY patient_index, position');
      const extras = await client.query('SELECT id::text, medical_insurance_number, predict_admission_time, admission_remark, employing_organization, company_address, recommended_doctor FROM pms_patient_ext');
      const tags = await client.query('SELECT id::text, name FROM pms_patient_tag WHERE NOT is_deleted');
      const weights = await client.query('SELECT DISTINCT ON (patient_index) patient_index::text AS id, weight FROM pms_weight_on_date ORDER BY patient_index, date DESC');
      const temperatures = await client.query('SELECT DISTINCT ON (patient_index) patient_index::text AS id, temperature FROM pms_temperature_on_date ORDER BY patient_index, date DESC');
      const named = (rows: { id: unknown; name: unknown }[]) => new Map(rows.flatMap(row => {
        const name = plain(row.name);
        return name ? [[String(row.id), name] as const] : [];
      }));
      const doctorNames = named(doctors.rows);
      const tagNames = named(tags.rows);
      const extById = new Map(extras.rows.map(row => [String(row.id), row as Record<string, unknown>]));
      const weightById = new Map(weights.rows.map(row => [String(row.id), row as Record<string, unknown>]));
      const temperatureById = new Map(temperatures.rows.map(row => [String(row.id), row as Record<string, unknown>]));
      const contactsByPatient = new Map<string, Record<string, unknown>[]>();
      for (const contact of contacts.rows) {
        const list = contactsByPatient.get(String(contact.patient_id)) ?? [];
        list.push(contact as Record<string, unknown>);
        contactsByPatient.set(String(contact.patient_id), list);
      }
      return {
        patients: rows.map(row => ({
          ...row,
          fields: patientProfileFields({
            row, ext: extById.get(String(row.id)), contacts: contactsByPatient.get(String(row.id)),
            doctors: doctorNames, tags: tagNames, weight: weightById.get(String(row.id)), temperature: temperatureById.get(String(row.id)),
          }),
        })) as RealPatient[],
        doctorNames: Object.fromEntries(doctorNames),
      };
    }),
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
          p.patient_position, p.treatment_type, p.radiation_type_enum, p.gating_mode_is_gating,
          p.gating_mode_optical_surface, p.sbrt, p.is_fif, p.is_uhdr, p.is_long_target_area, p.abdominal_press,
          p.image_fusion, p.is_painless_anesthesia, p.is_ultrasonic_guidance, p.is_bscan_guide,
          p.has_implantable_devices, p.is_protector, p.is_sensitizer, p.adaptive_option_is_adaptive_option,
          p.is_include_holiday, p.every_other_day, p.only_work_day, p.skip_holiday, p.include_shift_day,
          p.is_guide_plate_appointment, p.has_abort, p.is_priority_plan,
          p.times_per_day, p.times_per_week, p.days_per_week, p.total_treat_number, p.plan_treatment_count,
          p.interval_hours, p.expect_treatment_time, p.adaptive_option_frequency, p.special_equipment_name,
          p.treat_goal_id::text, p.image_guided_mode_id::text, p.after_load_mode_ids::text[], p.after_load_sim_equipment::text,
          p.planner_id::text, p.operating_physicist_id::text, p.doctor_operator_id::text, p.nurse_operator_id::text,
          p.plan_evaluation_doctor_id::text, p.audit_user_id::text, p.confirmed_user_id::text, p.design_user_id::text,
          p.approval_user_id::text, p.review_user_id::text,
          p.abort_reason, p.radiotherapy_diagnosis, p.guide_plate_appointment_remarks, p.manual_marking_str,
          p.irradiation_scheme, p.adaptive_option_adaptive_description,
          to_char(p.expected_plan_completed_date_time, 'YYYY-MM-DD') AS expected_plan_completed,
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
      const equipmentRows = await client.query('SELECT id::text, name FROM emr_equipment_information WHERE is_deleted IS NOT TRUE');
      const siteRows = await client.query('SELECT id::text, name FROM emr_site WHERE NOT is_deleted');
      const fixedRows = await client.query('SELECT id::text, left_fixed_position, right_fixed_position FROM emr_body_fixed_position');
      const treatGoalRows = await client.query('SELECT id::text, name FROM emr_diagnosis_config_treat_goal WHERE NOT is_deleted');
      const guidedModeRows = await client.query('SELECT id::text, image_guided_mode_name AS name FROM emr_image_guided_mode_config WHERE NOT is_deleted');
      const afterLoadModeRows = await client.query('SELECT id::text, after_load_mode_name AS name FROM emr_after_load_mode_config WHERE NOT is_deleted');
      const applicatorRows = await client.query('SELECT id::text, source_applicator_name AS name FROM emr_source_applicator_config WHERE NOT is_deleted');
      const named = (rows: { id: unknown; name: unknown }[]) => new Map(rows.flatMap(row => {
        const name = plain(row.name);
        return name ? [[String(row.id), name] as const] : [];
      }));
      const simLookups: Record<string, Record<string, string>> = {
        equipment: Object.fromEntries(named(equipmentRows.rows)),
        site: Object.fromEntries(named(siteRows.rows)),
        fixedSite: Object.fromEntries(fixedRows.rows.flatMap(row => {
          const name = [row.left_fixed_position, row.right_fixed_position].filter(Boolean).join('/');
          return name ? [[String(row.id), name] as const] : [];
        })),
        treatGoal: Object.fromEntries(Array.from(named(treatGoalRows.rows), ([id, name]) => [id, treatGoalLabel(name)])),
        guidedMode: Object.fromEntries(named(guidedModeRows.rows)),
        afterLoadMode: Object.fromEntries(named(afterLoadModeRows.rows)),
        applicator: Object.fromEntries(named(applicatorRows.rows)),
      };
      const times = `to_char(creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt", to_char(COALESCE(last_modification_time, creation_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt"`;
      const sims = (await client.query(`SELECT id::text, patient_guid::text AS "patientId", title, course_id::text AS "courseId",
        immobilize_description, scan_description, immobilization_remarks, scan_remarks, past_history_list, delineate_audit_fail_reason,
        scan_site_list, treatment_site_name_list, localization_center, mark, technique, imaging_modality_key, mr_protocol,
        mr_scan_info_other_protocol, contouring_system_list, plan_system,
        sim_patient_position, arm_position, is_enhance, localization_method, localization_type, sim_goal,
        treatment_type, treatment_equipment_type, gating_mode_is_gating, gating_mode_gating_mode_type, gating_mode_optical_surface,
        gating_mode_gating_equipment_id::text, reset_verification, delineate_audit_status,
        scan_details_is_four_dct, scan_details_ct_scan_kv, scan_details_ct_scan_ma, scan_details_ct_slice_thickness,
        scan_upper_bound, scan_lower_bound, has_moulding, mould_time, mould_confirm_time, mould_equipment_id::text,
        equipment_id::text, radiation_therapist_id::text, mould_technician_id::text, signature_doctor_id::text, audit_doctor_id::text,
        is_has_water_intake, water_intake, water_intake_time, abdominal_press, is_puncture, is_shrink_field, has_plan_qa,
        is_outside_hospital, lead_block_number, laser_punctuation, oral_contrast_agents,
        uppers_ids::text[], downpers_id::text[], immobilization_site_id::text, other_immobilization_site,
        to_char(open_finish_date_time, 'YYYY-MM-DD') AS "documentOn", ${times}
        FROM emr_sim_order WHERE NOT is_deleted AND is_enabled`)).rows;
      const ones = (await client.query(`SELECT id::text, patient_index::text AS "patientId", title, course_id::text AS "courseId",
        description, immobilize_description, site_name, protocol_template_name, scan_site_list, "ScanProtocolList",
        position_tolerance_name, treatment_tolerance_name, to_char(open_finish_date_time, 'YYYY-MM-DD') AS "documentOn", ${times}
        FROM emr_one_stop_order WHERE is_deleted IS NOT TRUE`)).rows;
      const exams = (await client.query(`SELECT id::text, patient_guid::text AS "patientId", title, course_id::text AS "courseId",
        appointment_type, remarks, to_char(appointment_date_time, 'YYYY-MM-DD') AS "documentOn", ${times}
        FROM emr_exam_appointment WHERE NOT is_deleted`)).rows;
      const customs = (await client.query(`SELECT id::text, patient_index::text AS "patientId", name AS title, course_id::text AS "courseId",
        description, report_content AS content,
        to_char(COALESCE(submission_date_time, creation_time), 'YYYY-MM-DD') AS "documentOn", ${times}
        FROM emr_custom_report WHERE is_deleted IS NOT TRUE`)).rows;
      const treats = (await client.query(`SELECT t.id::text, t.patient_guid::text AS "patientId", p.prescription_name AS title,
        t.prescription_id::text AS "prescriptionId", t.remark, to_char(t.approve_date_time, 'YYYY-MM-DD') AS "documentOn",
        to_char(t.creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt", to_char(t.creation_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt"
        FROM emr_treatment_order t LEFT JOIN emr_prescription p ON p.id = t.prescription_id`)).rows;
      return { diagnoses, requests, resets, sims, ones, exams, treats, customs, simLookups };
    }),
  ]);
  const readAt = new Date().toISOString();
  const requestSpecs = requestFieldSpecs(tumorText);
  const { patients } = patientSource;
  const simLookups = { ...clinical.simLookups, doctor: patientSource.doctorNames };
  const input: RealInput = {
    patients, readAt: { pms: readAt, emr: readAt, rvs: readAt },
    diagnoses: clinical.diagnoses.map(row => {
      const { fields, textParts } = splitRecordFields(diagnosisSpecs, row);
      return { ...row, parts: textParts, fields };
    }),
    requests: clinical.requests.map(row => {
      const { fields, textParts } = splitRecordFields(requestSpecs, row, simLookups);
      return {
        id: row.id, patientId: row.patientId, title: row.title, fractions: row.fractions, diagnosisIds: row.diagnosisIds ?? [],
        courseId: row.courseId, documentType: requestKind(row.prescriptionType), createdAt: row.createdAt, updatedAt: row.updatedAt,
        parts: textParts, fields,
      };
    }),
    documents: [
      ...clinical.sims.map(row => documentFrom(row, clinical.resets.has(String(row.id)) ? '复位申请单' : '定位申请单', documentFieldSpecs.定位申请单, false, simLookups)),
      ...clinical.ones.map(row => documentFrom(row, '一站式申请单', documentFieldSpecs.一站式申请单)),
      ...clinical.exams.map(row => documentFrom(row, '检查预约单', documentFieldSpecs.检查预约单)),
      ...clinical.treats.map(row => documentFrom(row, '治疗单', documentFieldSpecs.治疗单, true)),
      ...clinical.customs.map(row => documentFrom({ ...row, content: htmlToText(row.content) }, '自定义单据', documentFieldSpecs.自定义单据)),
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

function documentFrom(row: Record<string, unknown>, documentType: string, specs: FieldSpec[], treatment = false, lookups?: Record<string, Record<string, string>>): RealDocument {
  const { fields, textParts } = splitRecordFields(specs, row, lookups);
  return {
    id: String(row.id), patientId: String(row.patientId), documentType,
    title: row.title == null ? null : String(row.title),
    parts: textParts, fields,
    ...(documentType === '定位申请单' ? {
      imagingModalityKey: row.imaging_modality_key,
      scanSiteList: row.scan_site_list,
      simulationSourceFields: {
        treatmentSites: row.treatment_site_name_list ?? null,
        localizationCenter: row.localization_center ?? null,
        technique: row.technique ?? null,
        scanRemarks: row.scan_remarks ?? null,
        immobilizationRemarks: row.immobilization_remarks ?? null,
      },
    } : {}),
    documentOn: row.documentOn == null ? null : String(row.documentOn),
    courseId: row.courseId == null ? null : String(row.courseId),
    prescriptionId: row.prescriptionId == null ? null : String(row.prescriptionId),
    missingPrescription: treatment && row.title == null,
    createdAt: row.createdAt == null ? null : String(row.createdAt),
    updatedAt: row.updatedAt == null ? null : String(row.updatedAt),
  };
}
