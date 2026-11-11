import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosisSpecs, documentFieldSpecs, requestFieldSpecs, splitRecordFields } from '../server/sources/record-fields.js';

test('diagnosis text fields go to both record fields and the body text', () => {
  const { fields, textParts } = splitRecordFields(diagnosisSpecs, {
    clinical_description: '咳嗽三个月', remarks: null, in_charge_doctor_name: '张三', attending_doctor_name: '李四^^^^',
  });
  assert.deepEqual(fields.map(field => field.label), ['临床描述', '主管医生', '主诊医生']);
  assert.equal(fields.find(field => field.label === '主诊医生')?.value, '李四');
  assert.deepEqual(textParts, ['咳嗽三个月', '张三', '李四']);
});

test('request enum fields stay exact-only and arrays split into one entry per value', () => {
  const specs = requestFieldSpecs(['TumorSiteDescription_ActualDose', 'TumorSiteDescription_Gauze']);
  const { fields, textParts } = splitRecordFields(specs, {
    description: '姑息放疗', technique: 'IMRT', plan_system: 'Eclipse',
    sites: ['头', '颈'], sections: '[]',
    TumorSiteDescription_ActualDose: '实际剂量 30Gy', TumorSiteDescription_Gauze: null,
    brachy_therapy_mr_description: null,
  });
  const labels = fields.map(field => field.label);
  assert.deepEqual(labels.filter(label => label === '靶区部位'), ['靶区部位', '靶区部位']);
  assert.deepEqual(fields.filter(field => field.label === '靶区部位').map(field => field.value), ['头', '颈']);
  assert.equal(fields.find(field => field.label === '靶区描述')?.value, '实际剂量 30Gy');
  assert.equal(fields.find(field => field.label === '技术')?.value, 'IMRT');
  assert.ok(!textParts.includes('IMRT'));
  assert.ok(!textParts.includes('头'));
  assert.deepEqual(textParts, ['姑息放疗', '实际剂量 30Gy']);
});

test('simulation documents classify text remarks and exact scan sites separately', () => {
  const { fields, textParts } = splitRecordFields(documentFieldSpecs.定位申请单, {
    scan_remarks: '屏气训练', immobilization_remarks: '', scan_site_list: '["头部","Neck"]',
    imaging_modality_key: 'XRayComputedTomography:CT', technique: '3DCRT', mark: null,
  });
  const labels = fields.map(field => field.label);
  assert.deepEqual(labels, ['扫描备注', '扫描部位', '扫描部位', '技术', '成像方式']);
  assert.deepEqual(fields.filter(field => field.label === '扫描部位').map(field => field.value), ['Neck', '头部']);
  assert.equal(fields.find(field => field.label === '成像方式')?.value, 'CT');
  assert.deepEqual(textParts, ['屏气训练']);
});

test('sim enums translate to page labels and id references resolve to names', () => {
  const lookups = {
    doctor: { '11111111-1111-1111-1111-111111111111': '王技师' },
    equipment: { '22222222-2222-2222-2222-222222222222': 'Philips' },
    site: { '33333333-3333-3333-3333-333333333333': '大腿骨' },
    fixedSite: { '44444444-4444-4444-4444-444444444444': '左上/右上' },
  };
  const { fields } = splitRecordFields(documentFieldSpecs.定位申请单, {
    sim_patient_position: 1, is_enhance: 2, localization_method: 0, sim_goal: 99,
    has_moulding: false, scan_details_ct_scan_kv: 120,
    radiation_therapist_id: '11111111-1111-1111-1111-111111111111',
    equipment_id: '22222222-2222-2222-2222-222222222222',
    uppers_ids: ['33333333-3333-3333-3333-333333333333'],
    immobilization_site_id: '44444444-4444-4444-4444-444444444444',
    signature_doctor_id: null,
  }, lookups);
  const value = (label: string) => fields.find(field => field.label === label)?.value;
  assert.equal(value('摆位'), '头先仰卧 HFS');
  assert.equal(value('是否增强'), '平扫');
  assert.equal(value('定位方式'), '定位');
  assert.equal(value('是否制模'), '否');
  assert.equal(value('CT千伏'), '120');
  assert.equal(value('定位技师'), '王技师');
  assert.equal(value('扫描设备'), 'Philips');
  assert.equal(value('上界器官'), '大腿骨');
  assert.equal(value('固定部位'), '左上/右上');
  assert.ok(!fields.some(field => field.label === '定位目的'), 'unknown enum values are skipped');
  assert.ok(!fields.some(field => field.label === '签署医生'), 'unresolvable ids are skipped');
});
