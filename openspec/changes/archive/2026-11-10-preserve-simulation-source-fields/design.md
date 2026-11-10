## Context

EMR 查询已读取五列，组装单据时将它们合并到正文。快照导出读取 OpenSearch 文档的完整 `_source`。

## Goals / Non-Goals

在同步和导出过程中保留五列原值，兼容旧快照和现有查询。

## Decisions

- 仅在实际来源的定位申请单中增加 `simulationSourceFields`。五列各自保存，源值缺失时保留 `null`。
- OpenSearch 保存对象但不索引其内容。正文继续使用现有合并方式。
- 保持导出格式和命令，旧快照仍可导入。

## Risks / Trade-offs

旧索引不会自动补齐字段。完成一次实际来源同步后再导出。
