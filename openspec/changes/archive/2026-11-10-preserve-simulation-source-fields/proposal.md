## Why

定位申请单的部分 EMR 字段目前只出现在合并正文中。导出后难以区分原字段和原始取值，无法据此判断哪些字段适合精确筛选。

## What Changes

- 同步和快照导出分别保留治疗部位、定位中心、技术、扫描备注和固定备注。
- 现有正文搜索和定位申请单筛选继续按原方式工作。

## Capabilities

### New Capabilities

### Modified Capabilities

- `ois-search-prototype-data`：定位申请单快照保留五项原字段值。

## Impact

影响 EMR 读取结果、搜索文档和快照内容。重新完成同步后可导出新字段。
