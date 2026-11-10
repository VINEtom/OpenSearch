import type { PatientField } from '../../shared/types.js';
import { calendarDate, plain } from './text.js';

export interface PatientProfileSource {
  row: Record<string, unknown>;
  ext?: Record<string, unknown> | null;
  contacts?: Record<string, unknown>[];
  doctors: ReadonlyMap<string, string>;
  tags: ReadonlyMap<string, string>;
  weight?: Record<string, unknown> | null;
  temperature?: Record<string, unknown> | null;
}

const patientType: Record<string, string> = { '0': '治疗', '1': '测试', '2': '科研' };
const radiationType: Record<string, string> = { '1': '光子', '2': '电子', '3': '质子', '4': '后装' };
const idType: Record<string, string> = { '1': '身份证', '2': '社保卡', '3': '未知', '4': '驾驶证' };

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return plain(value);
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function enumerated(value: unknown, labels: Record<string, string>): string | null {
  const raw = text(value);
  return raw ? labels[raw] ?? raw : null;
}

function dated(value: unknown): string | null {
  return calendarDate(value) ?? text(value);
}

function join(parts: unknown[]): string | null {
  const values = parts.map(text).filter((value): value is string => !!value);
  return values.length ? values.join(' ') : null;
}

export function patientProfileFields(source: PatientProfileSource): PatientField[] {
  const row = source.row;
  const ext = source.ext ?? {};
  const fields: PatientField[] = [];
  const add = (label: string, value: string | null) => {
    if (value) fields.push({ label, value });
  };
  const doctor = (id: unknown) => {
    const key = identifier(id);
    return key ? source.doctors.get(key) ?? null : null;
  };
  add('拼音', text(row.chinese_phonetic_for_search));
  add('拼音首字母', text(row.phonetic_first_letter));
  add('病历号', text(row.admission_id));
  add('诊疗号', text(row.medical_treatment_number));
  add('民族', text(row.patient_national));
  add('国籍', text(row.patient_country));
  add('证件类型', enumerated(row.id_type, idType));
  add('证件号码', text(row.identity_number));
  add('医保', text(row.medical_insurance));
  add('医保号', text(ext.medical_insurance_number));
  add('身高', text(row.height));
  add('患者类型', enumerated(row.patient_type, patientType));
  add('放疗类型', enumerated(row.radiation_type, radiationType));
  const tagNames = (Array.isArray(row.tags) ? row.tags : []).map(id => source.tags.get(String(id))).filter((name): name is string => !!name);
  add('特殊情况', tagNames.length ? tagNames.join('、') : null);
  add('研究入组', text(row.research_in_group));
  add('主诊医生', doctor(row.attending_doctor_id));
  add('主管医生', doctor(row.in_charge_doctor_id) ?? text(row.in_charge_doctor_name));
  add('住院医生', doctor(row.resident_doctor_id));
  add('物理师', doctor(row.radiation_therapist_id));
  add('婚育史', text(row.obsterical_history));
  add('饮酒史', text(row.drinking_history));
  add('吸烟史', text(row.smoking_history));
  add('子女数', text(row.children_number));
  add('签名方式', text(row.signature_type));
  add('门诊号', text(row.outpatient_number));
  add('挂号号', text(row.registration_number));
  add('就诊卡号', text(row.ssn_number));
  add('患者卡号1', text(row.id_one));
  add('患者卡号2', text(row.id_two));
  add('患者卡号3', text(row.id_three));
  add('患者卡号4', text(row.id_four));
  add('住院次数', text(row.hospitalized_count));
  add('医生组', text(row.doctor_group));
  add('患者来源', text(row.patient_source));
  add('住院科室', text(row.hospitalized_department));
  add('入院时间', dated(row.hospital_start_date));
  add('出院时间', dated(row.hospital_end_date));
  add('病区', text(row.hospitalization_ward));
  add('床号', text(row.sickbed_number));
  add('住院号', text(row.admission_number));
  add('转诊医院', text(row.referral_hospital));
  add('转诊科室', text(row.hospital_department));
  add('预计入院', dated(ext.predict_admission_time));
  add('入院备注', text(ext.admission_remark));
  add('家庭电话', text(row.home_phone));
  add('联系电话', text(row.telephone_number));
  add('其他电话', text(row.mobile_phone_two));
  add('办公电话', text(row.office_phone));
  add('邮箱', text(row.e_mail));
  add('传真', text(row.fax));
  add('其他号码', text(row.other_number));
  add('户籍地址', join([row.domicile_province, row.domicile_details, row.domicile_zip_code]));
  add('居住地址', join([row.live_address_province, row.live_address_details, row.live_address_zip_code]));
  add('地址标签', text(row.live_address_tag));
  add('工作单位', text(ext.employing_organization));
  add('单位地址', text(ext.company_address));
  add('职业', text(row.professional));
  add('备注', text(row.other_description));
  add('登记时间', dated(row.register_date_time));
  add('登记人', text(row.registrar));
  add('首诊医生', text(row.first_visit_doctor));
  add('推荐医生', text(ext.recommended_doctor));
  add('体重', text(source.weight?.weight));
  add('体温', text(source.temperature?.temperature));
  for (const contact of source.contacts ?? []) {
    const who = join([contact.name, contact.relation, contact.phone_one, contact.phone_two]);
    add('联系人', who);
  }
  return fields;
}

const profileLabels = new Set(['拼音', '拼音首字母', '民族', '国籍', '主诊医生', '主管医生', '住院医生', '物理师', '婚育史', '饮酒史', '吸烟史', '特殊情况', '研究入组', '医生组', '患者来源', '住院科室', '病区', '转诊医院', '转诊科室', '入院备注', '户籍地址', '居住地址', '地址标签', '工作单位', '单位地址', '职业', '备注', '登记人', '首诊医生', '推荐医生', '联系人']);

export function patientProfileText(fields: PatientField[]): string | null {
  const text = fields.filter(field => profileLabels.has(field.label)).map(field => field.value);
  return text.length ? text.join('\n') : null;
}
