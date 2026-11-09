## Context

数据来源按钮包含全部来源、PMS、EMR、RVS。治疗计划只来自 RVS。真实同步不读取 RVS，该分类计数为 0。

## Goals / Non-Goals

**Goals:**

- 去掉 RVS 来源按钮。
- 记录分类不再单列治疗计划。全部记录合计患者、诊断、计划申请单和其他单据。

**Non-Goals:**

- 不改动已发布索引里的治疗计划文档。
- 不把其他单据再拆成定位、复位、治疗单等类型。

## Decisions

页面筛选项去掉 `rvs` 和 `treatment_plan`。已保存的 RVS 或治疗计划筛选恢复为全部。

## Risks / Trade-offs

- 演示数据中的治疗计划不再从搜索页分类进入。详情里已有的关联仍可打开。
