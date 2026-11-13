## Why
用户需要用完整诊断名称查找诊断记录。诊断模型应从查询中提取标题，并继续支持普通关键词、编码和确诊日期查询。

## What Changes
- 使用诊断 BERT 识别诊断名称单条件。

## Capabilities
### Modified Capabilities
- `ois-global-search`

## Impact
涉及本地诊断模型、查询与命中展示。
