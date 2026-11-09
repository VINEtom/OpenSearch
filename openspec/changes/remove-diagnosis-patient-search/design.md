## Context

「按诊断找患者」是顶部导航中的独立页面，查询已发布索引里的确诊诊断，再按患者合并。全局搜索继续覆盖患者、诊断、申请单、治疗计划和单据。

## Goals / Non-Goals

**Goals:**

- 页面只保留全局搜索。
- 删除该入口使用的查询接口。

**Non-Goals:**

- 不改变全局搜索的关键词、范围、来源、类型和组合条件。

## Decisions

删除导航项、页面组件、`findPatientsByDiagnosis` 和 `/api/prototype/diagnosis-patients`。详情仍从全局搜索结果打开。

## Risks / Trade-offs

- 不能再按完整诊断名称得到「一位患者一行」的列表。全局搜索会列出命中的诊断记录。
