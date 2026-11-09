## Context

原型患者结果目前只按放疗号和姓名匹配。真实 PMS 患者表具备更多可用字段：病历号 `admission_id`、诊疗号 `medical_treatment_number`、门诊号 `outpatient_number`、住院号 `admission_number`、证件号码 `identity_number`、本人电话（`telephone_number` 等）、主管医生 `in_charge_doctor_name`、拼音检索列 `chinese_phonetic_for_search`；联系人电话在 `pms_patient_contact_info`（`phone_one`、`phone_two`）。真实量级覆盖率：56% 患者有电话、54% 有证件号。

已验证 PMS 的 `[Encrypted]` 字段在当前环境按明文加 `^` 尾部填充存储，直连 SQL 读取到的是可用明文；姓名必须使用 `patient_name_for_search`（已在 `connect-real-pms-emr-sources` 中确定），编号与电话字段实测干净无填充，映射时统一做去尾部 `^` 处理作为防御。

业务确认：命中证件号码与电话直接展示完整值，不做脱敏；地址、单位、过敏史等自由文本不进入索引。

## Goals / Non-Goals

**Goals:**

- 患者结果支持患者编号、证件号码、本人与联系人电话精确匹配，主管医生姓名与拼音检索，命中标明字段类型和完整值。
- 演示库与真实源同构扩展，虚构样例覆盖各命中方式。

**Non-Goals:**

- 不改其他对象类型（诊断、申请单、单据）的搜索字段。
- 不实现按证件或电话的模糊（部分值）匹配。
- 不引入按字段的权限差异展示（集成阶段按守则处理可见范围）。

## Decisions

### 1. 患者文档新增字段

| 字段 | OpenSearch 类型 | 内容与命中方式 |
| --- | --- | --- |
| `patientNumbers` | `nested`（`kind` keyword、`value` keyword） | 病历号、诊疗号、门诊号、住院号；`value` 精确匹配，保留前导零；命中展示 `kind` 与完整值 |
| `identityNumber` | `keyword` | 证件号码，精确匹配 |
| `phones` | `nested`（`kind` keyword、`value` keyword） | 本人电话（联系电话/备用手机/办公电话/家庭电话）与联系人电话；精确匹配，命中展示类型与完整值 |
| `inChargeDoctor` | `text`，附 `keyword` 子字段 | 主管医生姓名，全文与精确匹配 |
| `namePhonetic` | `text`（standard 分析器） | 姓名拼音（源系统明文检索列），支持全拼输入 |

号码与电话只做精确匹配，不参与全文分词，不把自由文本隐私字段拼成正文。嵌套结构保留"字段类型"标签，使命中展示能区分"病历号命中"与"电话命中"。

### 2. 真实源映射（PMS）

| 患者文档字段 | 源字段 |
| --- | --- |
| `patientNumbers` | `admission_id`（病历号）、`medical_treatment_number`（诊疗号）、`outpatient_number`（门诊号）、`admission_number`（住院号），空值跳过 |
| `identityNumber` | `identity_number` |
| `phones`（本人） | `telephone_number`（联系电话）、`mobile_phone_two`（备用手机）、`office_phone`、`home_phone` |
| `phones`（联系人） | `pms_patient_contact_info.phone_one`、`phone_two`（kind 标为联系人电话，多人合并） |
| `inChargeDoctor` | `in_charge_doctor_name` |
| `namePhonetic` | `chinese_phonetic_for_search` |

所有值统一去除尾部 `^` 加密填充后写入索引；空字符串不写入。卡号类字段（就诊卡号、患者卡号 1–4）本批不接，后续按同一模式追加。

### 3. 演示库同构扩展

`pms_demo.patients` 新增可空列：`patient_numbers jsonb`、`identity_number text`、`phones jsonb`、`doctor_name text`、`name_phonetic text`，结构与真实映射的嵌套值一致；`db:init` 幂等加列，种子补覆盖各命中方式的虚构样例。真实适配层与演示读取层产出相同的 `PatientRow` 扩展。

### 4. 命中展示

复用编号精确命中的现有机制：`matchedFields` 返回字段标签（如"病历号""联系人电话""主管医生"）与完整值，不做截断或脱敏（业务确认口径）。患者详情的字段列表同步展示新增字段（病历号、诊疗号、证件号码、主管医生）。

### 5. 隐私与访问控制

证件号码与电话进入搜索索引后，索引本身承载 PII：搜索与写入账号分离、限制 Dashboards 访问沿用集成守则；本批按业务确认展示明文，如后续合规要求变化，可在此基础上换为哈希索引（查询时哈希匹配，明文只在源库），映射集中在适配层单处。

## Risks / Trade-offs

- [PII 进入 OpenSearch 索引] → 索引访问控制按守则收紧；哈希方案保留为演进路径。
- [联系人电话命中患者可能让搜索者通过他人号码定位患者] → 与源系统现有查询能力一致（源系统本身支持按电话查患者），命中展示遵循同一业务确认口径。
- [`^` 填充清理依赖当前存储格式] → 只做尾部修剪且仅针对该填充字符；若存储格式变化，单元测试样例先行暴露。

## Migration Plan

1. 演示库加列与种子更新（`db:init` 幂等），患者投影、映射与查询扩展，单元测试更新。
2. 真实源适配层按同一映射补充患者字段（依赖 `connect-real-pms-emr-sources` 的适配层落地）。
3. 回滚：投影按字段缺失处理（空数组/空值不影响既有放疗号与姓名命中），演示库加列可保留不回退。

## Open Questions

- 卡号类字段（就诊卡号、患者卡号）是否进入第二批扩展，待业务确认使用场景。
- 集成阶段若要求按角色脱敏，在命中展示层增加口径即可，映射不变。
