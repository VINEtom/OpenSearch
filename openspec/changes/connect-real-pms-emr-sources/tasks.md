## 1. 演示库多对多关联模型

- [x] 1.1 在 `scripts/schema/` 为 `emr_demo` 新增 `plan_request_diagnoses` 关联表（`id`、`plan_request_id`、`diagnosis_id`、`patient_id`，外键保证同患者），`scripts/init-db.ts` 幂等迁移：建表、按 `plan_requests.diagnosis_id` 回填关联行、删除旧列
- [x] 1.2 更新 `scripts/seed.ts`：申请单种子通过关联表写入，并补一条关联多条诊断的虚构样例；`--reset` 基线恢复同步调整
- [x] 1.3 更新 `shared/types.ts`、`server/data.ts`：`PlanRequestRow` 以 `diagnosis_ids: string[]` 取代单个 `diagnosis_id`；演示库读取改为联查关联表；详情响应的关联诊断改为列表

## 2. 校验、投影与组合筛选

- [x] 2.1 更新 `server/data.ts` 行校验与关系校验：每张申请单至少一条关联、关联诊断存在且同患者，缺失或跨患者为坏引用阻断发布
- [x] 2.2 更新 `server/mapping.ts` 与投影生成：`diagnosisId` 改为 `diagnosisIds`（keyword 数组，不用 nested）
- [x] 2.3 更新 `server/patient-query.ts` 与 `server/diagnosis-search.ts`：组合筛选按每条关联诊断分别计入申请单分次数，`diagnosisFilters` 聚合与详情关联列表按新模型输出
- [x] 2.4 更新单元测试（投影、关联、查询参数、命中片段）并通过 `npm run test:unit`
- [x] 2.5 同步写入按 OpenSearch 索引维护建议调整：建索引时 `refresh_interval` 为 `-1`，批量请求不强制刷新，校验前只刷新一次；别名发布后将新索引设为只读，保留上一批索引并删除更早的本原型索引

## 3. 真实源适配层

- [x] 3.1 扩展 `server/config.ts`：新增 `SOURCE_MODE` 与真实源连接配置（主机、端口、账号、两个库名）；`.env.example` 补充示例，凭据只存本地 `.env`
- [x] 3.2 新增 `server/sources/real.ts`：按设计文档字段映射只读查询 PMS（患者含 `patient_name_for_search` 明文列）与 EMR（诊断、三种计划申请单、处方诊断关联、靶区分次数 `max(equation_fraction)`、定位/复位申请单、一站式申请单、检查预约单、治疗单），产出与演示模式相同的 `Snapshot`；正文按设计文档的字段清单按序非空拼接（诊断含备注/方法/家族史等，申请单含补充医嘱/技术/设备/后装描述组，单据含部位/协议/备注等，GUID 数组不进正文）；复位申请单按 `emr_re_setup_order_rx_relation` 判定类型，治疗单标题按关联计划申请单名称推导；可用性过滤：患者未删除、诊断未删除且非无效状态、申请单未删除且未作废、定位单未删除且未作废、一站式与检查预约单未删除、治疗单全量；真实模式放宽申请单编号必填和编码成套校验
- [x] 3.3 同步入口与详情读取按 `SOURCE_MODE` 分派：`scripts/sync.ts`、`server/sync.ts`、详情接口在 `demo`/`real` 间切换，默认 `demo` 保持现网行为；同步状态接口返回当前数据源模式，页面与既有演示数据标识区分展示
- [x] 3.4 实现可隔离缺陷清单：EMR 本地患者不在 PMS、申请单无诊断关联、治疗单挂接处方缺失三类缺陷记录标识与原因，写入 `.runtime/sync-state.json` 并在同步状态接口返回，页面同步状态区展示清单；受影响记录不进索引；结构性坏引用沿用阻断逻辑
- [x] 3.5 为真实映射补充单元测试：性别枚举转换、确认状态推导（有无确诊日期）、靶区分次数聚合与缺失处理、多关联展开、可用性过滤（删除/无效/作废）、单据类型判定（复位 vs 定位）、治疗单标题推导、正文拼接规则（非空跳过、顺序稳定、JSON 数组解析与前缀剥离、空数组跳过、GUID 数组排除、靶区部位/靶区名去重、空字段不产生多余分隔）、缺陷清单、真实模式放宽校验
- [x] 3.6 实现回源跳转（demo 级直链）：`.env` 增加按来源与对象类型的路由模板（占位符含 `sourceId`、`patientId` 及内部参数如 `courseId`），详情接口在真实模式返回跳转地址（内部参数由适配层从源库解析补齐），演示模式不返回；前端详情面板展示「跳转」入口并新窗口打开；单元测试覆盖模板填充与演示模式不返回

## 4. 集成与演示模式回归

- [ ] 4.1 演示模式全量回归：`npm run db:init`（验证幂等迁移）、`npm run db:seed -- --reset`、`npm run sync`，单元与集成测试通过，搜索样例结果与基线一致
- [ ] 4.2 真实模式联调：对 `10.8.84.41`（少量数据）与 `10.8.31.28`（真实量级：约 4500 患者、4500 诊断、4700 申请单、5300 定位/复位单、1200 治疗单等合计约 2 万条）各执行一次全量同步，核对命中数量与源库一致、缺陷清单与已知缺陷吻合、抽样回查原始记录字段与链路、按单据类型筛选验证定位/复位/一站式/检查预约/治疗单归类正确
- [ ] 4.3 验证真实库零写入：确认同步、详情、测试全程仅 SELECT

## 5. 文档同步

- [ ] 5.1 更新 `docs/data-model.md`（关联表与真实源字段映射）、`docs/design.md`、`docs/requirements.md`、`docs/interaction-flows.md`（申请单关联诊断列表与「跳转」入口的交互）、`docs/integration-guidelines.md`（首批范围落地状态，以及回源跳转会话问题的两个集成阶段候选方案与技术依据）、`README.md`（数据源模式配置与真实源联调步骤）
- [ ] 5.2 更新 `docs/test-cases.md`：真实模式场景与演示多关联样例的预期结果，浏览器场景补充真实源验收步骤
