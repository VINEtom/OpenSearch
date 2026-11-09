import type { RecordType } from '../../shared/types.js';

export function fillJump(templates: Record<string, string | undefined>, type: RecordType, documentType: string, values: { sourceId: string; patientId: string; courseId?: string | null; prescriptionId?: string | null }): string | null {
  const template = type === 'patient' ? templates.JUMP_PMS_PATIENT
    : type === 'diagnosis' ? templates.JUMP_EMR_DIAGNOSIS
    : type === 'plan_request' ? templates.JUMP_EMR_PLAN_REQUEST
    : type === 'document' ? templates[`JUMP_EMR_DOCUMENT_${documentType}`] || templates.JUMP_EMR_DOCUMENT
    : undefined;
  if (!template) return null;
  return template.replaceAll('{sourceId}', values.sourceId).replaceAll('{patientId}', values.patientId)
    .replaceAll('{courseId}', values.courseId || '').replaceAll('{prescriptionId}', values.prescriptionId || '');
}
