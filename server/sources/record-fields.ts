import type { PatientField } from '../../shared/types.js';
import { fieldValues, joinText, plain } from './text.js';

export interface FieldSpec {
  label: string;
  column?: string;
  columns?: string[];
  text?: boolean;
  split?: boolean;
  enum?: Record<string, string>;
  boolean?: boolean;
  number?: boolean;
  lookup?: 'doctor' | 'equipment' | 'site' | 'fixedSite' | 'treatGoal' | 'guidedMode' | 'afterLoadMode' | 'applicator';
}

const diagnosisSpecs: FieldSpec[] = [
  { column: 'clinical_description', label: '临床描述', text: true },
  { column: 'remarks', label: '备注', text: true },
  { column: 'method_description', label: '方法', text: true },
  { column: 'family_history', label: '家族史', text: true },
  { column: 'other_tumor_history', label: '其他肿瘤史', text: true },
  { column: 'additional_diagnosis', label: '补充诊断', text: true },
  { column: 'in_charge_doctor_name', label: '主管医生', text: true },
  { column: 'attending_doctor_name', label: '主诊医生', text: true },
];

/** 申请单字段分类；靶区描述组按传入的来源列合并为一个文字字段。 */
export function requestFieldSpecs(tumorColumns: string[]): FieldSpec[] {
  return [
    { column: 'description', label: '申请说明', text: true },
    { column: 'supplementary_advice', label: '补充医嘱', text: true },
    { column: 'other_description', label: '其他描述', text: true },
    { column: 'technique', label: '技术' },
    { column: 'treatment_equipment', label: '治疗设备' },
    { column: 'accelerator_room', label: '加速器室' },
    { column: 'plan_system', label: '计划系统' },
    { column: 'contouring_system', label: '勾画系统' },
    { column: 'clinic_name', label: '诊室' },
    { column: 'protector_name', label: '防护' },
    { column: 'sensitizer_name', label: '增敏剂' },
    { column: 'brachy_therapy_mr_description', label: '后装病程', text: true },
    { column: 'first_visit_mr_description', label: '初诊病程', text: true },
    { label: '靶区描述', columns: tumorColumns, text: true },
    { column: 'sites', label: '靶区部位', split: true },
    { column: 'sections', label: '靶区分段', split: true },
    { column: 'patient_position', label: '摆位', enum: {
      '1': '头先仰卧 HFS', '2': '头先俯卧 HFP', '3': '脚先仰卧 FFS', '4': '脚先俯卧 FFP',
      '5': '头先进向右侧卧 HFDR', '6': '头先进向左侧卧 HFDL', '7': '脚先进向右侧卧 FFDR', '8': '脚先进向左侧卧 FFDL',
    } },
    { column: 'treatment_type', label: '治疗类型', enum: {
      '1': '首/再程（第一段/第一靶点）', '2': '第二段/改计划/第二靶点', '3': '第三、四段/再次改计划/第三、四靶点',
    } },
    { column: 'radiation_type_enum', label: '放射类型', enum: { '1': '光子', '2': '电子', '3': '质子', '4': '后装' } },
    { column: 'gating_mode_is_gating', label: '是否门控', boolean: true },
    { column: 'gating_mode_optical_surface', label: '是否光学表面', boolean: true },
    { column: 'sbrt', label: '是否SBRT', boolean: true },
    { column: 'is_fif', label: '是否FIF', boolean: true },
    { column: 'is_uhdr', label: '是否UHDR', boolean: true },
    { column: 'is_long_target_area', label: '是否长靶区', boolean: true },
    { column: 'abdominal_press', label: '是否腹压', boolean: true },
    { column: 'image_fusion', label: '是否图像融合', boolean: true },
    { column: 'is_painless_anesthesia', label: '是否无痛麻醉', boolean: true },
    { column: 'is_ultrasonic_guidance', label: '是否超声引导', boolean: true },
    { column: 'is_bscan_guide', label: '是否B超引导', boolean: true },
    { column: 'has_implantable_devices', label: '是否有植入物', boolean: true },
    { column: 'is_protector', label: '是否防护', boolean: true },
    { column: 'is_sensitizer', label: '是否增敏', boolean: true },
    { column: 'adaptive_option_is_adaptive_option', label: '是否自适配', boolean: true },
    { column: 'is_include_holiday', label: '是否含节假日', boolean: true },
    { column: 'every_other_day', label: '是否隔天', boolean: true },
    { column: 'only_work_day', label: '是否仅工作日', boolean: true },
    { column: 'skip_holiday', label: '是否跳过节假日', boolean: true },
    { column: 'include_shift_day', label: '是否含调休日', boolean: true },
    { column: 'is_guide_plate_appointment', label: '是否导板预约', boolean: true },
    { column: 'has_abort', label: '是否中止', boolean: true },
    { column: 'is_priority_plan', label: '是否优先计划', boolean: true },
    { column: 'times_per_day', label: '每日次数', number: true },
    { column: 'times_per_week', label: '每周次数', number: true },
    { column: 'days_per_week', label: '每周天数', number: true },
    { column: 'total_treat_number', label: '总次数', number: true },
    { column: 'plan_treatment_count', label: '计划治疗次数', number: true },
    { column: 'interval_hours', label: '每次间隔小时', number: true },
    { column: 'expect_treatment_time', label: '预计治疗时长', number: true },
    { column: 'adaptive_option_frequency', label: '自适配频率', number: true },
    { column: 'treat_goal_id', label: '治疗目的', lookup: 'treatGoal' },
    { column: 'image_guided_mode_id', label: '图像引导方式', lookup: 'guidedMode' },
    { column: 'after_load_mode_ids', label: '后装模式', split: true, lookup: 'afterLoadMode' },
    { column: 'after_load_sim_equipment', label: '施源器', lookup: 'applicator' },
    { column: 'special_equipment_name', label: '特殊设备' },
    { column: 'planner_id', label: '计划师', lookup: 'doctor' },
    { column: 'operating_physicist_id', label: '操作物理师', lookup: 'doctor' },
    { column: 'doctor_operator_id', label: '医嘱医生', lookup: 'doctor' },
    { column: 'nurse_operator_id', label: '护士操作', lookup: 'doctor' },
    { column: 'plan_evaluation_doctor_id', label: '计划评估医生', lookup: 'doctor' },
    { column: 'audit_user_id', label: '审核人', lookup: 'doctor' },
    { column: 'confirmed_user_id', label: '确认人', lookup: 'doctor' },
    { column: 'design_user_id', label: '设计人', lookup: 'doctor' },
    { column: 'approval_user_id', label: '审批人', lookup: 'doctor' },
    { column: 'review_user_id', label: '复核人', lookup: 'doctor' },
    { column: 'abort_reason', label: '中止原因', text: true },
    { column: 'radiotherapy_diagnosis', label: '放疗诊断', text: true },
    { column: 'guide_plate_appointment_remarks', label: '导板预约备注', text: true },
    { column: 'manual_marking_str', label: '人工标记', text: true },
    { column: 'irradiation_scheme', label: '照射方案', text: true },
    { column: 'adaptive_option_adaptive_description', label: '自适配描述', text: true },
    { column: 'expected_plan_completed', label: '预计计划完成' },
  ];
}

/** 治疗目的配置表存的是枚举键，按放疗目的话术翻译。 */
const therapeuticPurpose: Record<string, string> = {
  '1': '术前放疗', '2': '术后放疗', '3': '局部进展期放疗', '4': '姑息', '5': '脑转移', '6': '骨转移',
  '7': '后腹膜转移', '8': '肺转移', '9': '根治性放疗', '10': '预防性脑照射', '11': '后装治疗', '12': '复发', '13': '其他',
};

export function treatGoalLabel(name: string): string {
  const match = /^Enum:TherapeuticPurpose:(\d+)$/u.exec(name);
  if (!match) return name;
  return therapeuticPurpose[match[1]] ?? name;
}

export const simulationSpecs: FieldSpec[] = [
  { column: 'immobilize_description', label: '固定说明', text: true },
  { column: 'scan_description', label: '扫描说明', text: true },
  { column: 'immobilization_remarks', label: '固定备注', text: true },
  { column: 'scan_remarks', label: '扫描备注', text: true },
  { column: 'past_history_list', label: '既往史', text: true },
  { column: 'delineate_audit_fail_reason', label: '勾画审核失败原因', text: true },
  { column: 'scan_site_list', label: '扫描部位', split: true },
  { column: 'treatment_site_name_list', label: '治疗部位', split: true },
  { column: 'localization_center', label: '定位中心' },
  { column: 'mark', label: '标记' },
  { column: 'technique', label: '技术' },
  { column: 'imaging_modality_key', label: '成像方式', split: true },
  { column: 'mr_protocol', label: 'MR 协议' },
  { column: 'mr_scan_info_other_protocol', label: 'MR 扫描其他协议' },
  { column: 'contouring_system_list', label: '勾画系统', split: true },
  { column: 'plan_system', label: '计划系统' },
  { column: 'sim_patient_position', label: '摆位', enum: {
    '1': '头先仰卧 HFS', '2': '头先俯卧 HFP', '3': '脚先仰卧 FFS', '4': '脚先俯卧 FFP',
    '5': '头先进向右侧卧 HFDR', '6': '头先进向左侧卧 HFDL', '7': '脚先进向右侧卧 FFDR', '8': '脚先进向左侧卧 FFDL',
  } },
  { column: 'arm_position', label: '手臂位置', enum: {
    '1': '其它', '2': '举过头顶', '3': '平放胸前', '4': '身体两侧', '5': '双手叉腰',
  } },
  { column: 'is_enhance', label: '是否增强', enum: { '1': '增强', '2': '平扫', '3': '平扫+增强', '10': '平+增' } },
  { column: 'localization_method', label: '定位方式', enum: { '0': '定位', '1': '复位' } },
  { column: 'localization_type', label: '定位类型', enum: { '1': '首次定位', '2': '重新定位', '3': '第三次及以上定位' } },
  { column: 'sim_goal', label: '定位目的', enum: { '1': '肿瘤定位', '2': '后装', '3': '电子线' } },
  { column: 'treatment_type', label: '治疗类型', enum: {
    '1': '首/再程（第一段/第一靶点）', '2': '第二段/改计划/第二靶点', '3': '第三、四段/再次改计划/第三、四靶点',
  } },
  { column: 'treatment_equipment_type', label: '治疗设备类型' },
  { column: 'gating_mode_is_gating', label: '是否门控', boolean: true },
  { column: 'gating_mode_gating_mode_type', label: '门控方式', enum: { '1': '时项', '2': '幅值' } },
  { column: 'gating_mode_optical_surface', label: '是否光学表面', boolean: true },
  { column: 'gating_mode_gating_equipment_id', label: '门控设备', lookup: 'equipment' },
  { column: 'reset_verification', label: '复位验证', enum: { '1': '1', '2': '1-1', '3': '2及以上' } },
  { column: 'delineate_audit_status', label: '勾画审核状态', enum: { '1': '通过', '2': '未通过' } },
  { column: 'scan_details_is_four_dct', label: '是否4DCT', boolean: true },
  { column: 'scan_details_ct_scan_kv', label: 'CT千伏', number: true },
  { column: 'scan_details_ct_scan_ma', label: 'CT毫安', number: true },
  { column: 'scan_details_ct_slice_thickness', label: 'CT层厚', number: true },
  { column: 'scan_upper_bound', label: '扫描上界' },
  { column: 'scan_lower_bound', label: '扫描下界' },
  { column: 'has_moulding', label: '是否制模', boolean: true },
  { column: 'mould_time', label: '制模时间' },
  { column: 'mould_confirm_time', label: '制模确认时间' },
  { column: 'mould_equipment_id', label: '制模设备', lookup: 'equipment' },
  { column: 'equipment_id', label: '扫描设备', lookup: 'equipment' },
  { column: 'radiation_therapist_id', label: '定位技师', lookup: 'doctor' },
  { column: 'mould_technician_id', label: '制模技师', lookup: 'doctor' },
  { column: 'signature_doctor_id', label: '签署医生', lookup: 'doctor' },
  { column: 'audit_doctor_id', label: '审核医生', lookup: 'doctor' },
  { column: 'is_has_water_intake', label: '是否饮水', boolean: true },
  { column: 'water_intake', label: '饮水量', number: true },
  { column: 'water_intake_time', label: '饮水时间', number: true },
  { column: 'abdominal_press', label: '是否腹压', boolean: true },
  { column: 'is_puncture', label: '是否穿刺', boolean: true },
  { column: 'is_shrink_field', label: '是否缩野', boolean: true },
  { column: 'has_plan_qa', label: '是否计划QA', boolean: true },
  { column: 'is_outside_hospital', label: '是否院外', enum: { '0': '是', '1': '否', '2': '暂不确认' } },
  { column: 'lead_block_number', label: '铅块编号' },
  { column: 'laser_punctuation', label: '激光打点', number: true },
  { column: 'oral_contrast_agents', label: '口服对比剂', number: true },
  { column: 'uppers_ids', label: '上界器官', split: true, lookup: 'site' },
  { column: 'downpers_id', label: '下界器官', split: true, lookup: 'site' },
  { column: 'immobilization_site_id', label: '固定部位', lookup: 'fixedSite' },
  { column: 'other_immobilization_site', label: '其他固定部位' },
];

const oneStopSpecs: FieldSpec[] = [
  { column: 'description', label: '说明', text: true },
  { column: 'immobilize_description', label: '固定说明', text: true },
  { column: 'site_name', label: '部位' },
  { column: 'protocol_template_name', label: '协议模板' },
  { column: 'scan_site_list', label: '扫描部位', split: true },
  { column: 'ScanProtocolList', label: '扫描协议', split: true },
  { column: 'position_tolerance_name', label: '摆位容差' },
  { column: 'treatment_tolerance_name', label: '治疗容差' },
];

const examSpecs: FieldSpec[] = [
  { column: 'appointment_type', label: '预约类型' },
  { column: 'remarks', label: '备注', text: true },
];
const treatmentSpecs: FieldSpec[] = [{ column: 'remark', label: '备注', text: true }];
const customSpecs: FieldSpec[] = [
  { column: 'description', label: '说明', text: true },
  { column: 'content', label: '正文', text: true },
];

/** 各单据类型使用同一套拆分方式；定位和复位申请单共用一组字段。 */
export const documentFieldSpecs: Record<string, FieldSpec[]> = {
  定位申请单: simulationSpecs,
  复位申请单: simulationSpecs,
  一站式申请单: oneStopSpecs,
  检查预约单: examSpecs,
  治疗单: treatmentSpecs,
  自定义单据: customSpecs,
};

/** 按分类拆出来源行：fields 供精确匹配，textParts 只含文字字段的原始值，用于拼正文。 */
export function splitRecordFields(specs: FieldSpec[], row: Record<string, unknown>, lookups?: Record<string, Record<string, string>>): { fields: PatientField[]; textParts: unknown[] } {
  const fields: PatientField[] = [];
  const textParts: unknown[] = [];
  const add = (spec: FieldSpec, value: string) => {
    if (!value) return;
    fields.push({ label: spec.label, value });
    if (spec.text) textParts.push(value);
  };
  for (const spec of specs) {
    if (spec.columns) {
      const merged = joinText(spec.columns.map(name => row[name]));
      if (merged) {
        fields.push({ label: spec.label, value: merged });
        if (spec.text) textParts.push(merged);
      }
      continue;
    }
    const raw = row[spec.column!];
    if (spec.enum) {
      if (raw == null) continue;
      add(spec, spec.enum[String(raw)] ?? '');
      continue;
    }
    if (spec.boolean) {
      if (raw == null) continue;
      add(spec, raw === true ? '是' : raw === false ? '否' : String(raw));
      continue;
    }
    if (spec.number) {
      if (raw == null || !Number.isFinite(Number(raw))) continue;
      add(spec, String(raw));
      continue;
    }
    if (spec.lookup) {
      const table = lookups?.[spec.lookup];
      if (!table || raw == null) continue;
      let ids: unknown[];
      if (spec.split) {
        if (Array.isArray(raw)) ids = raw.flat();
        else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
          try { ids = JSON.parse(raw) as unknown[]; } catch { ids = [raw]; }
        } else ids = [raw];
      } else ids = [raw];
      for (const id of ids) {
        const text = String(id).trim();
        if (!text || text === '[]') continue;
        const name = table[text.toLowerCase()] ?? table[text];
        if (name) fields.push({ label: spec.label, value: name });
      }
      continue;
    }
    if (spec.split) {
      const values = fieldValues(raw);
      for (const value of values) fields.push({ label: spec.label, value });
      if (spec.text && values.length) textParts.push(...values);
    } else {
      const value = spec.text ? joinText([raw]) : plain(raw);
      add(spec, value ?? '');
    }
  }
  return { fields, textParts };
}

export { diagnosisSpecs };
