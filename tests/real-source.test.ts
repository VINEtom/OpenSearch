import test from 'node:test';
import assert from 'node:assert/strict';
import { baseline, idFor } from '../fixtures/samples.js';
import { detailFromSnapshot, projectRecords, validateSnapshot } from '../server/data.js';
import { assembleReal, type RealInput } from '../server/sources/assemble.js';
import { fillJump } from '../server/sources/jump.js';
import { joinText } from '../server/sources/text.js';
import { AppError } from '../server/errors.js';

const times = { createdAt: '2026-01-01T00:00:00', updatedAt: '2026-01-02T00:00:00' };
function input(extra: Partial<RealInput> = {}): RealInput {
  return { patients: [], diagnoses: [], requests: [], documents: [], readAt: { pms: times.createdAt, emr: times.createdAt, rvs: times.createdAt }, ...extra };
}

test('joins clinical text in order and skips empty JSON, prefixes and identifiers', () => {
  assert.equal(joinText([null, '  ', '[]', '["LocationSite:Head","LocationSite:Neck"]', '备注', '3a225c82-acf5-dd92-763b-8025a57508c8']), 'Head\nNeck\n备注');
  assert.equal(joinText(['[]', null]), null);
});

test('maps sex, confirmation, fractions, multiple diagnoses and document type', () => {
  const snapshot = assembleReal(input({
    patients: [{ id: idFor('RP1'), radiotherapyNo: 'PA2600', name: '王小明啊^^^^', sex: 1, birthDate: '1999-08-18', ...times }, { id: idFor('RP2'), radiotherapyNo: 'PA1', name: '空性别', sex: null, birthDate: null, ...times }],
    diagnoses: [
      { id: idFor('RD1'), patientId: idFor('RP1'), name: '鼻咽癌', code: 'C11', codeVersion: 'ICD-10', definiteDate: '2026-08-06 08:00:00', parts: ['临床', null, '方法'], ...times },
      { id: idFor('RD2'), patientId: idFor('RP1'), name: '未确诊', code: null, codeVersion: null, definiteDate: null, parts: [], ...times },
    ],
    requests: [{ id: idFor('RR1'), patientId: idFor('RP1'), title: '计划申请单', parts: ['描述', ['直肠', '直肠', 'PTV1']], fractions: 28, diagnosisIds: [idFor('RD1'), idFor('RD2')], courseId: idFor('RC1'), ...times }],
    documents: [
      { id: idFor('RS1'), patientId: idFor('RP1'), documentType: '复位申请单', title: '复位申请单0', parts: ['定位'], documentOn: '2026-11-04', courseId: idFor('RC1'), prescriptionId: null, ...times },
      { id: idFor('RT1'), patientId: idFor('RP1'), documentType: '治疗单', title: '计划申请单0', parts: ['备注'], documentOn: null, courseId: null, prescriptionId: idFor('RR1'), ...times },
    ],
  }));
  validateSnapshot(snapshot, { real: true });
  assert.equal(snapshot.patients[0].sex, 'male');
  assert.equal(snapshot.patients[0].name, '王小明啊');
  assert.equal(snapshot.patients[1].sex, 'unknown');
  assert.equal(snapshot.diagnoses[0].confirmation_status, 'confirmed');
  assert.equal(snapshot.diagnoses[0].code, 'C11');
  assert.equal(snapshot.diagnoses[0].code_version, 'ICD-10');
  assert.equal(snapshot.diagnoses[0].code_system, null);
  assert.equal(snapshot.diagnoses[1].confirmation_status, 'unknown');
  assert.equal(snapshot.diagnoses[0].summary, '临床\n方法');
  assert.deepEqual(snapshot.planRequests[0].diagnosis_ids, [idFor('RD1'), idFor('RD2')].sort());
  assert.equal(snapshot.planRequests[0].prescribed_fractions, 28);
  assert.equal(snapshot.planRequests[0].request_no, null);
  assert.equal(snapshot.planRequests[0].document_type, '计划申请单');
  assert.equal(snapshot.planRequests[0].body_text, '描述\n直肠\n直肠\nPTV1');
  assert.equal(snapshot.documents[0].document_type, '复位申请单');
  assert.equal(snapshot.documents[1].title, '计划申请单0');
});

test('isolates missing patients, unlinked requests and treatment orders without blocking the rest', () => {
  const snapshot = assembleReal(input({
    patients: [{ id: idFor('RP1'), radiotherapyNo: 'PA1', name: '甲', sex: 2, birthDate: null, ...times }],
    diagnoses: [{ id: idFor('RD1'), patientId: idFor('RP1'), name: '鼻咽癌', code: null, codeVersion: null, definiteDate: '2026-01-01', parts: [], ...times }, { id: idFor('RD9'), patientId: idFor('RP9'), name: '本地', code: null, codeVersion: null, definiteDate: null, parts: [], ...times }],
    requests: [
      { id: idFor('RR1'), patientId: idFor('RP1'), title: '有关联', parts: [], fractions: null, diagnosisIds: [idFor('RD1')], courseId: null, ...times },
      { id: idFor('RR2'), patientId: idFor('RP1'), title: '无关联', parts: [], fractions: 10, diagnosisIds: [], courseId: null, ...times },
    ],
    documents: [{ id: idFor('RT1'), patientId: idFor('RP1'), documentType: '治疗单', title: null, parts: [], documentOn: null, courseId: null, prescriptionId: null, missingPrescription: true, ...times }],
  }));
  assert.deepEqual(snapshot.defects.map(item => item.reason), ['患者不在 PMS 中', '申请单没有关联具体诊断', '治疗单关联的计划申请单不存在']);
  assert.deepEqual(snapshot.planRequests.map(row => row.id), [idFor('RR1')]);
  assert.equal(snapshot.planRequests[0].prescribed_fractions, null);
  assert.equal(snapshot.documents.length, 0);
});

test('a diagnosis linked across patients blocks the batch', () => {
  assert.throws(() => assembleReal(input({
    patients: [{ id: idFor('RP1'), radiotherapyNo: 'PA1', name: '甲', sex: 1, birthDate: null, ...times }, { id: idFor('RP2'), radiotherapyNo: 'PA2', name: '乙', sex: 1, birthDate: null, ...times }],
    diagnoses: [{ id: idFor('RD2'), patientId: idFor('RP2'), name: '肺癌', code: null, codeVersion: null, definiteDate: null, parts: [], ...times }],
    requests: [{ id: idFor('RR1'), patientId: idFor('RP1'), title: '错关联', parts: [], fractions: 1, diagnosisIds: [idFor('RD2')], courseId: null, ...times }],
  })), (error: unknown) => error instanceof AppError && error.code === 'RELATION_ERROR');
});

test('demo details have no jump url and real templates fill the saved identifiers', () => {
  assert.equal(detailFromSnapshot(baseline(), 'emr', 'plan_request', idFor('R1')).jumpUrl, null);
  const url = fillJump({ JUMP_EMR_PLAN_REQUEST: 'http://emr/order?courseId={courseId}&id={sourceId}&patientGuid={patientId}' }, 'plan_request', '', { sourceId: 'r1', patientId: 'p1', courseId: 'c1' });
  assert.equal(url, 'http://emr/order?courseId=c1&id=r1&patientGuid=p1');
  assert.equal(fillJump({}, 'plan_request', '', { sourceId: 'r1', patientId: 'p1' }), null);
});

test('projects scan sites independently of treatment sites and clinical text', () => {
  const patientId = idFor('RP1');
  const snapshot = assembleReal(input({
    patients: [{ id: patientId, radiotherapyNo: 'PA1', name: '甲', sex: 1, birthDate: null, ...times }],
    documents: [
      { id: idFor('RS1'), patientId, documentType: '定位申请单', title: '定位申请单', parts: ['备注 MR 脚部'], documentOn: null, courseId: null, prescriptionId: null, imagingModalityKey: 'ImagingModality:ct', scanSiteList: '["LocationSite:Head","头部","LocationSite:Neck"]', ...times },
      { id: idFor('RS2'), patientId, documentType: '复位申请单', title: '复位申请单', parts: ['CT 头部'], documentOn: null, courseId: null, prescriptionId: null, imagingModalityKey: 'CT', scanSiteList: ['头部'], ...times },
    ],
  }));
  const documents = projectRecords(snapshot, 'test').filter(row => row.recordType === 'document');
  assert.equal(documents[0].imagingModality, 'CT');
  assert.deepEqual(documents[0].localizationSites, ['Neck', '头部']);
  assert.equal(documents[1].imagingModality, undefined);
  assert.equal(documents[1].localizationSites, undefined);
});
