import type { Snapshot } from '../server/data.js';
import { DOCUMENT_CATEGORIES } from '../shared/types.js';
import { idFor, SAMPLE_TIMESTAMP } from './samples.js';

const at = SAMPLE_TIMESTAMP;

function patient(symbol: string, no: string, name: string, sex: 'female' | 'male', birth: string) {
  return { id: idFor(symbol), created_at: at, updated_at: at, revision: 1, deleted_at: null, radiotherapy_no: no, name, sex, birth_date: birth };
}
function clinical(symbol: string, patientSymbol: string) {
  return { id: idFor(symbol), created_at: at, updated_at: at, revision: 1, deleted_at: null, patient_id: idFor(patientSymbol), voided_at: null };
}

/** Fictional records covering every search category. Safe to regenerate; contains no hospital data. */
export function simulation(): Snapshot {
  const plan = clinical('SIM-R1', 'SIM-P1');
  const afterload = clinical('SIM-R2', 'SIM-P1');
  const wholeBody = clinical('SIM-R3', 'SIM-P2');
  return {
    patients: [
      patient('SIM-P1', 'PA900001', '陈模拟', 'male', '1990-01-02'),
      patient('SIM-P2', 'PA900002', '李对照', 'female', '1988-06-15'),
    ],
    diagnoses: [
      { ...clinical('SIM-D1', 'SIM-P1'), diagnosis_name: '鼻咽癌', code_system: 'DEMO-ONCOLOGY', code_version: '1', code: 'DEMO-NPC', confirmation_status: 'confirmed', diagnosed_on: '2026-10-01', source_document_id: null, summary: '模拟确诊说明。' },
      { ...clinical('SIM-D2', 'SIM-P2'), diagnosis_name: '肺癌', code_system: 'DEMO-ONCOLOGY', code_version: '1', code: 'DEMO-LUNG', confirmation_status: 'confirmed', diagnosed_on: '2026-09-12', source_document_id: null, summary: '模拟对照说明。' },
    ],
    planRequests: [
      { ...plan, diagnosis_ids: [idFor('SIM-D1')], request_no: 'SIM-REQ-001', title: '模拟计划申请', body_text: '模拟计划正文，处方分次用于演示。', prescribed_fractions: 20, requested_on: '2026-10-05', document_type: '计划申请单' },
      { ...afterload, diagnosis_ids: [idFor('SIM-D1')], request_no: 'SIM-REQ-002', title: '模拟后装申请', body_text: '模拟后装正文。', prescribed_fractions: 4, requested_on: '2026-10-06', document_type: '后装申请单' },
      { ...wholeBody, diagnosis_ids: [idFor('SIM-D2')], request_no: 'SIM-REQ-003', title: '模拟全身放疗申请', body_text: '模拟全身放疗正文。', prescribed_fractions: 8, requested_on: '2026-10-07', document_type: '全身放疗申请单' },
    ],
    treatmentPlans: [
      { ...clinical('SIM-T1', 'SIM-P1'), plan_request_id: plan.id, plan_no: 'SIM-PLAN-001', name: '模拟治疗计划', status: '计划已准备', notes: '模拟计划备注。', planned_on: '2026-10-08' },
    ],
    documents: [
      { ...clinical('SIM-O1', 'SIM-P1'), document_type: '定位申请单', title: '模拟定位申请', body_text: '模拟定位正文。', document_on: '2026-10-02' },
      { ...clinical('SIM-O2', 'SIM-P1'), document_type: '复位申请单', title: '模拟复位申请', body_text: '模拟复位正文。', document_on: '2026-10-03' },
      { ...clinical('SIM-O3', 'SIM-P1'), document_type: '一站式申请单', title: '模拟一站式申请', body_text: '模拟一站式正文。', document_on: '2026-10-04' },
      { ...clinical('SIM-O4', 'SIM-P2'), document_type: '检查预约单', title: '模拟检查预约', body_text: '模拟检查预约正文。', document_on: '2026-10-04' },
      { ...clinical('SIM-O5', 'SIM-P1'), document_type: '治疗单', title: '模拟治疗单', body_text: '模拟治疗单正文。', document_on: '2026-10-09' },
      { ...clinical('SIM-O6', 'SIM-P2'), document_type: '自定义单据', title: '模拟放疗记录', body_text: '模拟自定义单据正文。', document_on: '2026-10-10' },
    ],
  };
}

export function simulationCategories(): string[] {
  const snapshot = simulation();
  return [...snapshot.planRequests.map(row => row.document_type || '计划申请单'), ...snapshot.documents.map(row => row.document_type)];
}

export function simulationCoversSearchCategories(): boolean {
  const present = new Set(simulationCategories());
  return DOCUMENT_CATEGORIES.every(name => present.has(name));
}
