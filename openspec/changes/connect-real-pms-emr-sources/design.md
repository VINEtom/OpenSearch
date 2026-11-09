## Context

原型当前从三个演示库（`pms_demo`、`emr_demo`、`rvs_demo`）全量读取固定表结构，校验后生成 OpenSearch 记录索引，详情按库、表、主键回查。读取层 `server/data.ts` 硬性校验只连接演示库名，同步入口 `scripts/sync.ts` 固定使用演示库。

真实源为开发服务器 PostgreSQL：`10.8.84.41:5432`（`RTCloudPmsDB` / `RTCloudEmrDBVNext`）与 `10.8.31.28:5432`（同库，含真实量级数据：PMS 患者 4479、EMR 患者 4555、诊断 4504、处方 4706）。连接信息只存本地 `.env`。

代码级调研与真实数据核查确认的口径（均与业务确认）：

- 真实 EMR 无诊断确认状态枚举；有确诊日期（`definite_diagnosis_date`，覆盖 4500/4504）视为已确诊，否则按未知。
- 处方分次数：主表 `emr_prescription.plan_treatment_count` 在真实数据中 100% 为空，弃用；取靶区子表 `emr_prescription_target_doses.equation_fraction`（列注释「分次数」，75.6% 存活处方有值）的最大值。
- 一张处方可关联多条诊断（真实数据：4715 张单关联 1 条，7 张关联 2–4 条），原型支持多对多。
- PMS `patient_name`、`birthdate` 为加密存储（真实值带 `^` 填充），姓名使用明文检索列 `patient_name_for_search`。
- PMS 与 EMR 患者主键同一 UUID（PMS 同步建档），EMR 另有 98 名 HL7 本地患者不在 PMS 中（名下仅 3 条诊断）；99 张存活处方无诊断关联，其中 51 张属于没有任何「完成」诊断的患者——源系统创建申请单时默认关联患者最新完成诊断，无可用诊断时不建关联，因此无关联是源系统允许的状态而非损坏数据。两者为可隔离缺陷，隔离不阻断。
- EMR 单据管理树的真实存储：计划/后装/全身放疗申请单同在 `emr_prescription`（`prescription_type` 0/1/2，真实数据 4305/370/31，部署库枚举比本地源码多全身放疗成员）；定位申请单与复位申请单同在 `emr_sim_order`（存活 5026，其中 70 张为复位单，由 `emr_re_setup_order_rx_relation` 关联计划申请单）；一站式申请单 `emr_one_stop_order`（104）；检查预约单 `emr_exam_appointment`（45）；治疗单 `emr_treatment_order`（1176，无名称与删除标记，挂接 `prescription_id`）。「已中止单据」为工作流中止状态的过滤视图，中止不等于作废。

## Goals / Non-Goals

**Goals:**

- 同步与详情读取支持选择数据源模式（`demo` 或 `real`），两种模式互不干扰。
- 真实源只读适配层完成字段映射，产出与演示库相同的快照结构，复用现有校验、投影、发布和查询管线。
- 申请单与诊断改为多对多关联，演示库表结构同步调整，组合筛选按每条关联诊断分别聚合分次数。
- 真实源缺失字段按明确规则推导，不使用虚构值；可隔离缺陷记清单不阻断，结构性坏引用阻断发布。

**Non-Goals:**

- 不接入 RVS 治疗计划（真实源后续批次按集成守则接入）。
- 不接入自定义单据、历史病历、智能单据等其他页签的记录（本批覆盖单据管理树中的申请单与治疗单）。
- 不实现增量同步、权限过滤和实时变更传播；沿用手动全量同步。
- 不在真实库建表、写数据或创建只读账号（应用账号由环境方另行提供）。

## Decisions

### 1. 数据源模式：配置选择 + 独立连接信息

`.env` 新增 `SOURCE_MODE`（`demo` | `real`，默认 `demo`）和真实源连接项（主机、端口、账号、两个库名）。演示库配置保持现名；真实源适配层启动时校验目标库名不等于演示库名，方向与现有 `assertPrototypeDatabases` 相反，防止两模式互相误连。`db:init`、`db:seed` 与演示集成测试维持只连演示库名的守则，天然不会触碰真实库。

### 2. 适配层位置与快照复用

新增 `server/sources/real.ts`：按字段映射查询真实库并产出与 `server/data.ts` 相同的 `Snapshot` 结构；`readSnapshot` 按 `SOURCE_MODE` 分派到演示读取或真实读取。快照进入现有校验、投影、发布流程，同步、查询、别名切换代码不感知模式。详情读取同样按模式分派：真实模式按真实库列名查询并映射回现有 `DetailResponse`。

未采用「为真实源另建一套管线」：会复制校验、投影和组合筛选逻辑，违背原型"单一管线"的验证目的。

### 3. 申请单-诊断多对多模型

- 演示库 `emr_demo` 新增关联表 `plan_request_diagnoses`（`id`、`plan_request_id`、`diagnosis_id`、`patient_id`），外键沿用 `(diagnosis_id, patient_id)` 联合引用保证同患者；`plan_requests.diagnosis_id` 列迁移后移除。`db:init` 幂等迁移：建表、按旧列回填关联行、再删旧列。
- 快照行 `PlanRequestRow` 以 `diagnosis_ids: string[]` 取代单个 `diagnosis_id`；投影中 `diagnosisId` 改为 `diagnosisIds`（keyword 数组）。每批次新建索引，无兼容负担。
- 真实源适配层由 `emr_prescription_diagnosis_relation` 生成关联；演示种子数据补一条多关联样例。
- 校验规则：每张申请单至少一条关联；关联诊断必须存在且属于同一患者；缺失或跨患者为坏引用，阻断发布（与既有坏引用处理一致）。

### 4. 组合筛选聚合

患者文档的 `diagnosisFilters` 仍以"每条确诊诊断"为单位；某诊断的直接关联有效申请单集合取所有关联到该诊断的申请单，取其中最高分次数。一张申请单关联多条诊断时，其分次数同时计入各关联诊断。规则语义与原型一致，仅关联集合的定义放宽。

### 5. 真实源字段映射

| 原型字段 | PMS `pms_patient` | 说明 |
| --- | --- | --- |
| `id` | `id` | 跨库一致 UUID |
| `radiotherapy_no` | `patient_id` | 放疗号，保留文本 |
| `name` | `patient_name_for_search` | 明文检索列；`patient_name` 为加密存储（带 `^` 填充），不直接使用 |
| `sex` | `sex` | 1→`male`，2→`female`，3→`other`，空→`unknown` |
| `birth_date` | `birthdate` | 文本日期（加密存储的明文格式）；无效或空→`NULL` |
| `created_at` / `updated_at` | `creation_time` / `coalesce(last_modification_time, creation_time)` | |
| 可用性 | `is_deleted = false` | SQL 层过滤 |

| 原型字段 | EMR `emr_diagnosis` | 说明 |
| --- | --- | --- |
| `patient_id` | `patient_index` | 与 EMR 患者表主键一致；正常为 PMS 患者 UUID |
| `diagnosis_name` | `name` | 规范名称（源系统创建时含 ICD 编码前缀） |
| `code` | `icd_code` | 真实模式放宽“编码成套”校验 |
| `code_version` | `emr_icd_template."Version"`，按 `icd_code` 对应 | 字典版本，如 ICD-10、ICD-11。诊断行上的 `version_number` 为空，不用 |
| `confirmation_status` | 由 `definite_diagnosis_date` 推导 | 有→`confirmed`，无→`unknown` |
| `diagnosed_on` | `definite_diagnosis_date` 的日期部分 | 源库时间为无时区时间戳，按存储值取日期 |
| `summary` | `clinical_description` + `remarks` + `method_description` + `family_history` + `other_tumor_history` + `additional_diagnosis` + `in_charge_doctor_name` + `attending_doctor_name` 按序非空拼接 | 临床描述、备注、诊断方法描述、家族史、本人其他肿瘤史、附加诊断、主管与主治医生姓名共同构成诊断正文 |
| 可用性 | `is_deleted = false` 且 `status <> 2`（Invalid 无效状态） | `DiagnosisState`：Invalid=2；当前真实数据 status 全为空，规则按枚举语义保留 |

| 原型字段 | EMR `emr_prescription` + 关联表 + 靶区子表 | 说明 |
| --- | --- | --- |
| `patient_id` | `patient_guid` | |
| `title` | `prescription_name` | 计划单名称，名称本身含类型（如「后装计划单…」），计划、后装、全身放疗三种计划单一并接入，均归入计划申请单对象 |
| `request_no` | 无对应字段 → `NULL` | 编号按缺失处理，真实模式允许为空 |
| `body_text` | `description` + `supplementary_advice` + `other_description` + `technique` + `treatment_equipment` + `accelerator_room` + `plan_system` + `contouring_system` + `clinic_name` + `protector_name` + `sensitizer_name` + `brachy_therapy_mr_description` + `first_visit_mr_description` + 后装部位描述字段组（`TumorSiteDescription_*` 系列共 20 列）+ 靶区子表去重后的 `prescription_site_name`（治疗部位）与 `target_section`（靶区名）按序非空拼接 | 描述、补充医嘱、技术/设备/治疗室/计划系统、保护剂与增敏剂、后装 MR 描述与后装部位描述、治疗部位与靶区名共同构成申请单正文 |
| `requested_on` | 无明确申请日期 → `NULL` | 按未知处理 |
| `prescribed_fractions` | `max(emr_prescription_target_doses.equation_fraction)`（按 `"PrescriptionEntityId"` 关联） | 已验证 `plan_treatment_count` 100% 为空；无靶区或全空按缺失 |
| `diagnosis_ids` | `emr_prescription_diagnosis_relation.diagnosis_id` 全部行 | 无关联行按可隔离缺陷处理 |
| `created_at` / `updated_at` | `creation_time` / `coalesce(last_modification_time, creation_time)` | |
| 可用性 | `is_deleted = false` 且 `is_enabled = true`（`is_enabled=false` 为业务作废，真实数据 124 张） | `approval_status` 暂不参与 |

真实其他单据统一映射为原型的其他单据（`document`）行，`document_type` 使用源系统单据分类名称：

| 真实表 | `document_type` 判定 | `title` | `body_text`（按序非空拼接） | `document_on` | 可用性 |
| --- | --- | --- | --- | --- | --- |
| `emr_sim_order` | `id` 出现在 `emr_re_setup_order_rx_relation.re_setup_order_id` → 复位申请单；否则 → 定位申请单 | `title`（定位单名称） | `immobilize_description`（定位描述）、`scan_description`（其他要求）、`immobilization_remarks`（固定备注）、`scan_remarks`（扫描备注）、`past_history_list`（既往史）、`delineate_audit_fail_reason`（勾画审核回退原因）、`scan_site_list`（定位部位）、`treatment_site_name_list`（治疗部位名称数组）、`localization_center`（定位中心）、`mark`（标记点）、`technique`（技术类型）、`imaging_modality_key`（成像方式）、`mr_protocol`（MR扫描参数）、`mr_scan_info_other_protocol`（其他MR协议）、`contouring_system_list`（勾画系统）、`plan_system`（计划系统） | `open_finish_date_time`（开单确认时间）的日期部分 | `is_deleted = false` 且 `is_enabled = true`（作废，另有 `disable_date_time`） |
| `emr_one_stop_order` | 一站式申请单 | `title` | `description`（描述）、`immobilize_description`（定位描述）、`site_name`（病种）、`protocol_template_name`（一站式协议名）、`scan_site_list`（定位部位）、`ScanProtocolList`（扫描协议）、`position_tolerance_name`（摆位容差名）、`treatment_tolerance_name`（治疗容差名） | `open_finish_date_time`（开单完成时间）的日期部分 | `is_deleted` 为真时排除（该列可为空，空值视为未删除） |
| `emr_exam_appointment` | 检查预约单 | `title` | `appointment_type`（预约类型）、`remarks`（备注） | `appointment_date_time`（预约日期）的日期部分 | `is_deleted = false` |
| `emr_treatment_order` | 治疗单 | 关联 `emr_prescription.prescription_name`（治疗单无名称列，标题按关联计划申请单名称推导） | `remark`（备注） | `approve_date_time`（批准时间）的日期部分 | 无删除与作废机制，全量参与 |

拼接规则：同一对象内字段按表中顺序拼接，空值跳过，不做翻译或枚举转文字；JSON 数组字段（如定位部位、扫描协议、既往史）解析出元素并剥离 `枚举:` 形式的前缀后拼入，空数组跳过；GUID 数组类字段（部位 Id、技师 Id 等）不进入正文。各表 `created_at` / `updated_at` 均取 `creation_time` / `coalesce(last_modification_time, creation_time)`。治疗单挂接的处方不存在时按可隔离缺陷处理。`emr_prescription.tumor_site_str`、`radiotherapy_diagnosis`、`guide_plate_appointment_remarks` 无列注释、语义未确认，暂不进入正文。

### 6. 缺陷分层：隔离清单 vs 阻断

- 可隔离缺陷（记录级、不影响其他记录）：EMR 记录引用的患者不在真实 PMS 患者中（HL7 本地建档）、申请单无任何诊断关联。同步将记录标识与原因写入缺陷清单，受影响记录不参与搜索和组合筛选，本批次照常发布；下次同步源数据修复后自动恢复。清单保存在 `.runtime/sync-state.json`，与批次状态一起在页面展示。
- 结构性坏引用（破坏链路一致性）：申请单关联的诊断不存在或属于其他患者等，沿用原型规则记录原因并阻止本批次发布。

未采用「全部阻断」：真实库恒有少量脏数据（98 名本地患者、99 张无关联处方），阻断会使真实源永远无法发布，违背"不发布残缺数据但可隔离缺陷不扩大影响"的守则。

### 7. 缺失字段推导

- `revision`：真实源无版本号，恒为 `1`。副作用：`sourceRevision` 无法识别真实源记录变更，详情新鲜度依赖 `updatedAt` 与当前值比对。可接受，记录为限制。
- `voided_at`：真实系统用删除标记和业务作废状态表达失效（诊断 `status`、申请单 `is_enabled`），在 SQL 层过滤，映射行中恒为 `NULL`。
- 推导值只存在于索引投影，不回写真实库，不改变源记录含义。

### 8. OpenSearch 写入与索引设置

对照 [索引维护](https://docs.opensearch.org/latest/im-plugin/index-maintenance/)、[Bulk](https://docs.opensearch.org/latest/api-reference/document-apis/bulk/)、[别名](https://docs.opensearch.org/latest/im-plugin/index-alias/) 和 [nested](https://docs.opensearch.org/latest/mappings/supported-field-types/nested/)：

- 建索引时 `refresh_interval` 设为 `-1`，批量写入不带 `refresh=true`；校验前只执行一次 `_refresh`。官方说明频繁刷新会在装载期间不断生成小段。
- 批量按约 500 条一组。真实源约 2 万条，远低于需要拆分分片的体量。当前 OpenSearch 是单节点，保持 `number_of_shards: 1`、`number_of_replicas: 0`。副本在单节点上无法分配，设为 1 会让索引一直处于未分配状态。
- 别名切换成功后把新索引设为 `index.blocks.write: true`，已发布批次不再被写入。保留刚被替换的上一批索引作回退，删除更早的、且 `_meta.owner` 属于本原型的索引。
- `dynamic: strict`、文档 `_id` 为 `<source>:<recordType>:<sourceId>`、一次 `_aliases` 切换查询别名，沿用现有实现。
- 只有「同一对象内多个字段必须一起比较」才用 `nested`：已有的 `diagnosisFilters`，以及患者编号、电话（类型与值成对）。`diagnosisIds` 用 keyword 数组，不用 nested。
- 中文继续用内置 `cjk` 分析器。官方注明 ICU 分析器对中文分词可能更好，但需要额外插件；本原型不更换已验证的分析器。

### 9. 权限与凭据

连接信息只存本地 `.env`（不入 Git）。当前使用开发账号直连只读查询；集成环境应换成最小授权只读账号（集成守则要求），不阻塞本阶段。

### 10. 回源跳转：demo 级直链 + 集成阶段再解决会话

原型按 demo 定位简化：EMR/PMS 零改动，也不做浏览器扩展。搜索端从索引与源库解析出完整内部路由并按 `.env` 中按来源与对象类型配置的路由模板生成地址，详情提供「跳转」入口新窗口打开。已核实各对象路由参数均可从源库解析：申请单疗程读 `emr_prescription.course_id`，定位/复位单、一站式申请单、检查预约单的疗程分别读各自表的 `course_id`，治疗单路由使用关联处方标识（`vPId`）与治疗单标识（`trId`），不需要疗程。

已知限制（集成阶段处理，原型不解决）：旧 WebOIS 前端的登录令牌与患者上下文（`access_token`、`pGuid` 等）在 sessionStorage 中按标签页隔离，外部新标签页直链可能落在登录页或缺少患者上下文，演示时人工登录兜底。集成阶段的两个候选方案（浏览器跳转助手、源系统中转落地路由）连同技术依据记录在集成守则，届时二选一；搜索端的路由模板与参数解析结构不变。

## Risks / Trade-offs

- [当前使用超级用户账号连接] → 适配层只执行 SELECT；集成验收前替换最小授权只读账号。
- [靶区分次数取最大值在多靶区分次不同时的口径可能偏离临床习惯] → 真实样例中同单多靶区分次一致；如有异议按具体靶区规则再调整，映射集中在单处。
- [演示库关联模型迁移可能影响既有样例与测试] → `db:init` 幂等迁移回填旧列；更新种子、集成测试与测试文档；基线恢复命令沿用。
- [无增量游标，真实源每次全量读取] → 首批约 2 万条记录量级（患者、诊断、三种计划申请单与其他单据合计）可控；正式环境需评估读取边界与频率。
- [`timestamp without time zone` 取日期可能受写入时区影响] → 按存储值取日期部分，与源系统展示口径一致；如发现偏移再引入时区参数。

## Migration Plan

1. 演示库结构迁移与种子/测试适配（向后兼容：`db:init` 重复执行安全）。
2. 新增真实源适配层与模式分派，默认 `demo`，现网行为不变。
3. 真实模式联调：对 `10.8.84.41`（少量数据）与 `10.8.31.28`（真实量级）各执行一次全量同步，核对命中数量、缺陷清单与抽样回查。
4. 回滚：`SOURCE_MODE=demo` 即回到现状；演示库旧列已删除时由 `db:seed -- --reset` 恢复基线。

## Open Questions

- 靶区「追加分次数」（`equation_append_fraction`，真实数据仅 7 例）暂不并入分次数，如临床口径要求合并再调整。
- 处方批准状态（`approval_status`）暂不参与可用性判断；如业务要求只检索已批准申请单，在适配层加过滤条件即可。
- 诊断的部位类字段（原发部位、转移部位、治疗部位、治疗部位名称数组）在真实数据中覆盖率为 0，暂不进入正文；如后续业务开始填写再按同一拼接规则加入。
- `emr_sim_order` 的技师与制模技师列（`radiation_therapist_id` 等）实测为空且存储形态未确认（名称或 GUID），暂不进入正文；有数据后核实形态再定。
- 只读专用账号由环境方提供后替换凭据。
