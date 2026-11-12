## Why
全局搜索需要按指定单据类型和字段筛选。现有发布流程只为定位申请单写入数值字段，其他单据的范围查询缺少可用数据。

## What Changes
- 发布时按单据类型生成可比较的数值字段。
- 启用单据字段查询时，按单据类型限制匹配，并显示命中条件和值。

## Capabilities
### Modified Capabilities
- `ois-global-search`：按单据类型和字段查询。

## Impact
索引发布、搜索接口和结果页。
