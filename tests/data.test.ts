import test from 'node:test';
import assert from 'node:assert/strict';
import { baseline, idFor, paginationDocuments, SAMPLE_TIMESTAMP } from '../fixtures/samples.js';
import { assertPrototypeDatabases, detailFromSnapshot, projectRecords, validateSnapshot } from '../server/data.js';
import { config } from '../server/config.js';
import { AppError } from '../server/errors.js';

function code(expected: string) { return (error: unknown) => error instanceof AppError && error.code === expected; }

test('S0 projects the documented 16 independent records and exact text matches', () => {
  const records = projectRecords(baseline(), 'baseline');
  assert.equal(records.length, 16);
  const count = (field: 'source' | 'recordType') => records.reduce<Record<string, number>>((result, row) => {
    result[row[field]] = (result[row[field]] ?? 0) + 1; return result;
  }, {});
  assert.deepEqual(count('source'), { pms: 3, emr: 11, rvs: 2 });
  assert.deepEqual(count('recordType'), { patient: 3, diagnosis: 4, plan_request: 2, treatment_plan: 2, document: 5 });
  const ids = (text: string) => records.filter(row => `${row.title}\n${row.bodyText ?? ''}`.includes(text)).map(row => row.sourceId).sort();
  assert.deepEqual(ids('屏气'), ['R1', 'T1', 'O4'].map(idFor).sort());
  assert.deepEqual(ids('鼻咽癌'), ['D1', 'D3', 'R1', 'O1', 'O2', 'O3', 'O5'].map(idFor).sort());
  assert.equal(records.filter(row => row.radiotherapyNo === '000123').length, 8);
  assert.equal(records.filter(row => row.radiotherapyNo === '00123').length, 4);
  assert.equal(records.find(row => row.sourceId === idFor('T2'))?.diagnosisId, idFor('D3'));
});

test('missing fields remain null, and a patient receives no clinical body or fabricated date', () => {
  const records = projectRecords(baseline(), 'baseline');
  const patient = records.find(row => row.sourceId === idFor('P3'))!;
  assert.equal(patient.birthDate, null);
  assert.equal(patient.bodyText, null);
  assert.equal(patient.businessDate, null);
  assert.deepEqual(patient.missingFields, ['birthDate']);
  const diagnosis = records.find(row => row.sourceId === idFor('D4'))!;
  assert.equal(diagnosis.confirmationStatus, 'unknown');
  assert.deepEqual(diagnosis.missingFields, ['birthDate', 'businessDate', 'bodyText', 'codeSystem', 'codeVersion', 'code']);
});

test('deleting a patient excludes all eight records; parent invalidation keeps available children', () => {
  const deletedPatient = baseline();
  deletedPatient.patients[0].deleted_at = SAMPLE_TIMESTAMP;
  const remaining = projectRecords(deletedPatient, 'patient-deleted');
  assert.equal(remaining.length, 8);
  assert.ok(remaining.every(row => row.patientId !== idFor('P1')));
  for (const parent of ['request', 'diagnosis'] as const) {
    const snapshot = baseline();
    if (parent === 'request') snapshot.planRequests[0].voided_at = SAMPLE_TIMESTAMP;
    else snapshot.diagnoses[0].deleted_at = SAMPLE_TIMESTAMP;
    const projected = projectRecords(snapshot, 'parent-invalid');
    assert.equal(projected.length, 15);
    assert.ok(projected.some(row => row.sourceId === idFor('T1')));
  }
});

test('missing or cross-patient references fail validation even when the record is unavailable', () => {
  const mutations = [
    (snapshot: ReturnType<typeof baseline>) => { snapshot.treatmentPlans[0].plan_request_id = idFor('R99'); },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.treatmentPlans[0].patient_id = idFor('P2'); },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.planRequests[0].diagnosis_id = idFor('D3'); },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.diagnoses[0].source_document_id = idFor('O2'); },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.documents[0].patient_id = idFor('P99'); },
  ];
  for (const mutate of mutations) {
    const snapshot = baseline();
    mutate(snapshot);
    assert.throws(() => validateSnapshot(snapshot), code('RELATION_ERROR'));
  }
  const snapshot = baseline();
  snapshot.treatmentPlans[2].plan_request_id = idFor('R99');
  assert.throws(() => projectRecords(snapshot, 'invalid'), code('RELATION_ERROR'));
});

test('source constraints reject incomplete codes, invalid dates, blank names and unsafe revisions', () => {
  const mutations = [
    (snapshot: ReturnType<typeof baseline>) => { snapshot.diagnoses[0].code_version = null; },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.patients[0].birth_date = '2026-02-30'; },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.patients[0].name = '  '; },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.documents[0].revision = 0; },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.documents[0].revision = Number.MAX_SAFE_INTEGER + 1; },
    (snapshot: ReturnType<typeof baseline>) => { snapshot.patients[1].radiotherapy_no = '000123'; },
  ];
  for (const mutate of mutations) {
    const snapshot = baseline(); mutate(snapshot);
    assert.throws(() => validateSnapshot(snapshot), code('INVALID_SOURCE_DATA'));
  }
});

test('details trace UUID relations, expose matching field names and never append related body text', () => {
  const snapshot = baseline();
  const plan = detailFromSnapshot(snapshot, 'rvs', 'treatment_plan', idFor('T1'));
  assert.equal(plan.record.bodyText, '屏气训练已完成。');
  assert.ok(plan.relations.some(row => row.sourceId === idFor('R1') && row.recordType === 'plan_request'));
  assert.ok(plan.relations.some(row => row.sourceId === idFor('D1') && row.recordType === 'diagnosis'));
  assert.equal(plan.fields.find(field => field.name === 'bodyText')?.label, '计划备注');
  const diagnosis = detailFromSnapshot(snapshot, 'emr', 'diagnosis', idFor('D1'));
  assert.ok(diagnosis.relations.some(row => row.sourceId === idFor('O1') && row.recordType === 'document'));
  assert.deepEqual(diagnosis.relations.filter(row => row.recordType === 'treatment_plan').map(row => row.sourceId), [idFor('T1')]);
  const secondDiagnosis = detailFromSnapshot(snapshot, 'emr', 'diagnosis', idFor('D2'));
  assert.deepEqual(secondDiagnosis.relations.filter(row => row.recordType === 'treatment_plan').map(row => [row.sourceId, row.availability]), [[idFor('T3'), 'voided']]);
  const document = detailFromSnapshot(snapshot, 'emr', 'document', idFor('O1'));
  assert.ok(document.relations.some(row => row.sourceId === idFor('D1')));
  assert.equal(document.fields.find(field => field.name === 'documentType')?.value, '病理报告');
  const patient = detailFromSnapshot(snapshot, 'pms', 'patient', idFor('P1'));
  assert.equal(patient.relations.filter(row => row.recordType === 'plan_request').length, 2);
  assert.equal(patient.relations.filter(row => row.recordType === 'document').length, 2);
  assert.deepEqual(snapshot, baseline());
});

test('details distinguish unavailable targets and keep unavailable parents identifiable', () => {
  const snapshot = baseline();
  const plan = detailFromSnapshot(snapshot, 'rvs', 'treatment_plan', idFor('T2'));
  assert.equal(plan.relations.find(row => row.sourceId === idFor('R3'))?.availability, 'deleted');
  assert.throws(() => detailFromSnapshot(snapshot, 'emr', 'plan_request', idFor('R3')), code('DELETED'));
  assert.throws(() => detailFromSnapshot(snapshot, 'rvs', 'treatment_plan', idFor('T3')), code('VOIDED'));
  assert.throws(() => detailFromSnapshot(snapshot, 'emr', 'document', idFor('O99')), code('NOT_FOUND'));
  assert.throws(() => detailFromSnapshot(snapshot, 'rvs', 'document', idFor('O1')), code('INVALID_TARGET'));
  snapshot.documents[0].deleted_at = SAMPLE_TIMESTAMP;
  const diagnosis = detailFromSnapshot(snapshot, 'emr', 'diagnosis', idFor('D1'));
  assert.equal(diagnosis.record.confirmationStatus, 'confirmed');
  assert.equal(diagnosis.relations.find(row => row.sourceId === idFor('O1'))?.availability, 'deleted');
  snapshot.treatmentPlans[0].plan_request_id = idFor('R99');
  assert.throws(() => detailFromSnapshot(snapshot, 'rvs', 'treatment_plan', idFor('T1')), code('RELATION_ERROR'));
  snapshot.patients[1].deleted_at = SAMPLE_TIMESTAMP;
  assert.throws(() => detailFromSnapshot(snapshot, 'rvs', 'treatment_plan', idFor('T2')), code('PATIENT_DELETED'));
});

test('pagination fixtures have fixed independent IDs and baseline is fresh on every call', () => {
  const documents = paginationDocuments();
  assert.equal(documents.length, 25);
  assert.equal(new Set(documents.map(row => row.id)).size, 25);
  assert.equal(documents[0].id, idFor('O101'));
  assert.equal(documents[24].title, '分页样例025');
  const snapshot = baseline(); snapshot.documents.push(...documents);
  assert.equal(projectRecords(snapshot, 'pagination').length, 41);
  assert.equal(baseline().documents.length, 5);
});

test('database guard refuses any name outside the three prototype databases', () => {
  const original = config.databases.pms;
  try {
    config.databases.pms = 'business_database';
    assert.throws(assertPrototypeDatabases, code('UNSAFE_DATABASE'));
  } finally { config.databases.pms = original; }
});
