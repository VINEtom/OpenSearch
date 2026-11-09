## Why

用户可在全局搜索输入「最近10个月确诊鼻咽癌」，从同时使用 ICD-10 和 ICD-11 的诊断中找到患者，并核对实际筛选条件。

## What Changes

- 支持仅按确诊日期与病种筛选患者。输入处方分次条件时继续按同一诊断核对。
- 用一个病种值集维护两套体系的编码范围。

## Capabilities

### Modified Capabilities

- `ois-global-search` 增加按日期和病种编码找患者。

## Impact

涉及快照发布、患者索引投影、全局搜索及结果展示。
