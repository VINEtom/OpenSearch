import type { RecordType } from '../../shared/types.js';

const documentJumpKeys: Record<string, string> = {
  定位申请单: 'JUMP_EMR_DOCUMENT_SIM',
  复位申请单: 'JUMP_EMR_DOCUMENT_RESET',
  一站式申请单: 'JUMP_EMR_DOCUMENT_ONE_STOP',
  检查预约单: 'JUMP_EMR_DOCUMENT_EXAM',
  治疗单: 'JUMP_EMR_DOCUMENT_TREATMENT',
  自定义单据: 'JUMP_EMR_DOCUMENT_CUSTOM',
};

const planRequestJumpKeys: Record<string, string> = {
  计划申请单: 'JUMP_EMR_PLAN_REQUEST_PLAN',
  后装申请单: 'JUMP_EMR_PLAN_REQUEST_BRACHY',
  全身放疗申请单: 'JUMP_EMR_PLAN_REQUEST_TBI',
};

export function fillJump(templates: Record<string, string | undefined>, type: RecordType, documentType: string, values: { sourceId: string; patientId: string; courseId?: string | null; prescriptionId?: string | null }): string | null {
  const specific = type === 'document' ? documentJumpKeys[documentType]
    : type === 'plan_request' ? planRequestJumpKeys[documentType]
    : undefined;
  const template = type === 'patient' ? templates.JUMP_PMS_PATIENT
    : type === 'diagnosis' ? templates.JUMP_EMR_DIAGNOSIS
    : specific ? templates[specific] || templates[`JUMP_EMR_${type === 'document' ? 'DOCUMENT' : 'PLAN_REQUEST'}_${documentType}`]
    : type === 'plan_request' ? templates.JUMP_EMR_PLAN_REQUEST
    : type === 'document' ? templates.JUMP_EMR_DOCUMENT
    : undefined;
  if (!template) return null;
  return template.replaceAll('{sourceId}', values.sourceId).replaceAll('{patientId}', values.patientId)
    .replaceAll('{courseId}', values.courseId || '').replaceAll('{prescriptionId}', values.prescriptionId || '');
}
