## Why

字段内包含查询按分词匹配会漏掉词内连续字符。例如搜索 ddd 时遗漏字段值 dddd。

## What Changes

- 对索引中的字段值按连续原文匹配。
- 使用虚构记录补齐缺样本回归。

## Capabilities

### Modified Capabilities

- `ois-global-search`

## Impact

单据字段内文字筛选和验收。
