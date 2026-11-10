import test from 'node:test';
import assert from 'node:assert/strict';
import { patientProfileFields, patientProfileText } from '../server/sources/patient-profile.js';

const doctorId = '11111111-1111-1111-1111-111111111111';

test('patient profile keeps page fields and resolves doctor ids to names', () => {
  const fields = patientProfileFields({
    row: {
      chinese_phonetic_for_search: 'zhangsan^^^^', admission_id: 'BL001', identity_number: '110101199001011234',
      patient_type: 0, id_type: 1, height: 170, attending_doctor_id: doctorId, in_charge_doctor_id: doctorId,
      resident_doctor_id: '22222222-2222-2222-2222-222222222222', in_charge_doctor_name: '外来医生',
      first_visit_doctor: '李四', telephone_number: '13800000000', domicile_province: '上海市', domicile_details: '某路1号',
      tags: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
    },
    ext: { recommended_doctor: '王五', employing_organization: '示例医院' },
    contacts: [{ name: '赵六', relation: '配偶', phone_one: '13900000000', phone_two: null }],
    doctors: new Map([[doctorId, '张三']]),
    tags: new Map([['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '绿色通道']]),
    weight: { weight: 60 },
  });
  const value = (label: string) => fields.find(field => field.label === label)?.value;
  assert.equal(value('拼音'), 'zhangsan');
  assert.equal(value('病历号'), 'BL001');
  assert.equal(value('证件类型'), '身份证');
  assert.equal(value('患者类型'), '治疗');
  assert.equal(value('主诊医生'), '张三');
  assert.equal(value('主管医生'), '张三');
  assert.equal(value('住院医生'), undefined);
  assert.equal(value('首诊医生'), '李四');
  assert.equal(value('推荐医生'), '王五');
  assert.equal(value('联系人'), '赵六 配偶 13900000000');
  assert.equal(value('户籍地址'), '上海市 某路1号');
  assert.equal(value('身高'), '170');
  assert.equal(value('体重'), '60');
  assert.equal(value('特殊情况'), '绿色通道');
  assert.equal(fields.some(field => field.label === '年龄'), false);
  assert.match(patientProfileText(fields) ?? '', /张三/);
  assert.doesNotMatch(patientProfileText(fields) ?? '', /13800000000/);
});

test('in-charge doctor falls back to the stored name when the user cannot be resolved', () => {
  const fields = patientProfileFields({
    row: { in_charge_doctor_id: doctorId, in_charge_doctor_name: '外来医生' },
    doctors: new Map(), tags: new Map(),
  });
  assert.equal(fields.find(field => field.label === '主管医生')?.value, '外来医生');
});
