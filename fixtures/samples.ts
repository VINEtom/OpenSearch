import { createHash } from 'node:crypto';
import type { BaseRow, ClinicalRow, DiagnosisRow, DocumentRow, Snapshot } from '../server/data.js';

export const SAMPLE_TIMESTAMP = '2026-11-01T00:00:00+08:00';

export function idFor(symbol: string): string {
  const bytes = createHash('sha256').update(`ois-search-prototype:${symbol}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function base(symbol: string): BaseRow {
  return { id: idFor(symbol), created_at: SAMPLE_TIMESTAMP, updated_at: SAMPLE_TIMESTAMP, revision: 1, deleted_at: null };
}
function clinical(symbol: string, patient: string): ClinicalRow {
  return { ...base(symbol), patient_id: idFor(patient), voided_at: null };
}
function coding(code: string): Pick<DiagnosisRow, 'code_system' | 'code_version' | 'code'> {
  return { code_system: 'DEMO-ONCOLOGY', code_version: '1', code };
}

/** Every call returns a fresh copy of the exact S0 fixtures in docs/test-cases.md. */
export function baseline(): Snapshot {
  return {
    patients: [
      { ...base('P1'), radiotherapy_no: '000123', name: '林示例', sex: 'male', birth_date: '1986-11-08' },
      { ...base('P2'), radiotherapy_no: '00123', name: '林示例', sex: 'female', birth_date: '1986-11-09' },
      { ...base('P3'), radiotherapy_no: '000124', name: '周参照', sex: 'unknown', birth_date: null },
    ],
    diagnoses: [
      { ...clinical('D1', 'P1'), diagnosis_name: '鼻咽癌', ...coding('DEMO-NPC'), confirmation_status: 'confirmed', diagnosed_on: '2026-10-01', source_document_id: idFor('O1'), summary: '诊断说明甲' },
      { ...clinical('D2', 'P1'), diagnosis_name: '肺癌', ...coding('DEMO-LUNG'), confirmation_status: 'confirmed', diagnosed_on: '2026-10-02', source_document_id: null, summary: '诊断说明乙' },
      { ...clinical('D3', 'P2'), diagnosis_name: '鼻咽癌', ...coding('DEMO-NPC'), confirmation_status: 'suspected', diagnosed_on: '2026-10-03', source_document_id: idFor('O2'), summary: '诊断说明丙' },
      { ...clinical('D4', 'P3'), diagnosis_name: '肺癌', code_system: null, code_version: null, code: null, confirmation_status: 'unknown', diagnosed_on: null, source_document_id: null, summary: null },
    ],
    planRequests: [
      { ...clinical('R1', 'P1'), diagnosis_ids: [idFor('D1'), idFor('D2')], request_no: 'REQ-001', title: '鼻咽癌放疗申请', body_text: '本次采用屏气训练方案。', prescribed_fractions: 20, requested_on: '2026-10-05' },
      { ...clinical('R2', 'P1'), diagnosis_ids: [idFor('D2')], request_no: 'REQ-002', title: '肺部计划申请', body_text: '按常规流程准备。', prescribed_fractions: 10, requested_on: '2026-10-05' },
      { ...clinical('R3', 'P2'), diagnosis_ids: [idFor('D3')], request_no: 'REQ-003', title: '历史申请', body_text: '历史申请内容。', prescribed_fractions: 30, requested_on: '2026-10-05', deleted_at: SAMPLE_TIMESTAMP },
    ],
    treatmentPlans: [
      { ...clinical('T1', 'P1'), plan_request_id: idFor('R1'), plan_no: 'PLAN-001', name: '治疗计划甲', status: '计划已准备', notes: '屏气训练已完成。', planned_on: '2026-10-06' },
      { ...clinical('T2', 'P2'), plan_request_id: idFor('R3'), plan_no: 'PLAN-002', name: '治疗计划乙', status: '待复核', notes: '按常规流程复核。', planned_on: '2026-10-06' },
      { ...clinical('T3', 'P1'), plan_request_id: idFor('R2'), plan_no: 'PLAN-003', name: '历史计划', status: '历史状态', notes: '历史计划备注。', planned_on: '2026-10-06', voided_at: SAMPLE_TIMESTAMP },
    ],
    documents: [
      { ...clinical('O1', 'P1'), document_type: '病理报告', title: '标本记录甲', body_text: '诊断记录：鼻咽癌。', document_on: '2026-10-01' },
      { ...clinical('O2', 'P2'), document_type: '诊疗记录', title: '门诊记录乙', body_text: '考虑鼻咽癌可能，建议进一步检查。', document_on: '2026-10-03' },
      { ...clinical('O3', 'P3'), document_type: '诊疗记录', title: '门诊记录丙', body_text: '已排除鼻咽癌。', document_on: '2026-10-03' },
      { ...clinical('O4', 'P1'), document_type: '治疗备注', title: '训练记录', body_text: '屏气训练记录。', document_on: '2026-10-06' },
      { ...clinical('O5', 'P3'), document_type: '家族史', title: '家族记录', body_text: '父亲曾患鼻咽癌。', document_on: '2026-10-04' },
    ],
  };
}

export function paginationDocuments(count = 25): DocumentRow[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > 10000) throw new Error('分页样例数量应为 0 至 10000');
  return Array.from({ length: count }, (_, index) => ({
    ...clinical(`O${101 + index}`, 'P1'), document_type: '测试记录', title: `分页样例${String(index + 1).padStart(3, '0')}`,
    body_text: '分页唯一词', document_on: '2026-11-08',
  }));
}

export function repeatedDiagnosis(): DiagnosisRow {
  return {
    ...clinical('D5', 'P1'), diagnosis_name: '鼻咽癌', ...coding('DEMO-NPC'),
    confirmation_status: 'confirmed', diagnosed_on: '2026-10-08', source_document_id: null,
    summary: '复诊记录：鼻咽癌。',
  };
}
