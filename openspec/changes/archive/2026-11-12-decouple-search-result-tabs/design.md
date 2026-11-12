## Context
患者模型的调用目前取决于结果分类。分类计数与结果列表已经在同一次 OpenSearch 查询中计算。

## Goals / Non-Goals
- 保持查询解释独立于结果分类。

## Decisions
模型调用继续使用输入文字和数据来源。结果分类继续通过 OpenSearch 的 post_filter 作用于列表，各分类计数基于同一组匹配条件。
