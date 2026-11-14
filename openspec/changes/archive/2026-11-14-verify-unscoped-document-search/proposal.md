## Why

省略单据类型时，模型可能因上下文变化截短取值。需要用目录和索引复核，提高同一查询在所有适用单据中的一致性。

## What Changes

- 复核候选查询的取值，区分值里提到的单据类型与筛选范围。
- 仅输入完整单据字段名时执行关键词搜索。

## Capabilities

### Modified Capabilities

- `ois-global-search`

## Impact

单据字段筛选。
