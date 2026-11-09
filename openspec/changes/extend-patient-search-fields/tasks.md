## 1. 演示库与数据模型

- [ ] 1.1 `scripts/schema/` + `scripts/init-db.ts`：`pms_demo.patients` 幂等新增 `patient_numbers jsonb`、`identity_number text`、`phones jsonb`、`doctor_name text`、`name_phonetic text` 可空列
- [ ] 1.2 `scripts/seed.ts` 补虚构样例：不同编号类型、证件号码、本人与联系人电话、主管医生、拼音各有覆盖；`--reset` 基线同步更新

## 2. 投影、映射与查询

- [ ] 2.1 `shared/types.ts` + `server/data.ts`：`PatientRow` 扩展编号、证件、电话、医生、拼音字段；演示读取与行校验同步
- [ ] 2.2 `server/mapping.ts` + `server/data.ts` 投影：患者文档新增 `patientNumbers`（nested）、`identityNumber`、`phones`（nested）、`inChargeDoctor`、`namePhonetic`，空值进 `missingFields` 或留空
- [ ] 2.3 `server/search.ts` 查询：编号/证件/电话嵌套精确匹配、主管医生全文与精确、拼音检索；`matchedFields` 返回字段标签与完整值
- [ ] 2.4 患者详情字段列表展示新增字段（病历号、诊疗号、证件号码、主管医生）
- [ ] 2.5 单元测试：各编号类型命中与不串号、证件与电话精确命中（含联系人电话）、部分值不命中、拼音命中、`^` 尾部清理、自由文本地址不命中

## 3. 真实源映射（依赖 connect-real-pms-emr-sources 适配层）

- [ ] 3.1 `server/sources/real.ts` 患者映射按设计文档扩展：编号四类、证件号码、本人四类电话、联系人表电话合并、主管医生、拼音，全部去尾部 `^` 填充
- [ ] 3.2 真实模式联调：用真实病历号、证件号码、联系电话、联系人电话、主管医生姓名和拼音各执行一次搜索，命中展示与源库一致

## 4. 文档同步

- [ ] 4.1 更新 `docs/data-model.md`（演示库新列与真实源字段映射）、`docs/requirements.md`、`docs/test-cases.md`（患者扩展命中的浏览器场景与预期）
