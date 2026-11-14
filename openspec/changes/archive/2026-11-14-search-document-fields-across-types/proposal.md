## Why

用户省略单据类型时，明确的单字段查询需要覆盖目录中包含该字段的单据。普通关键词应找得到关联患者姓名的记录。

## What Changes

- 根据目录搜索含有指定字段的单据类型。
- 验证关键词能够匹配各类记录的患者姓名。

## Capabilities

### Modified Capabilities

- `ois-global-search`

## Impact

单据查询解析、搜索接口和筛选条件展示。
