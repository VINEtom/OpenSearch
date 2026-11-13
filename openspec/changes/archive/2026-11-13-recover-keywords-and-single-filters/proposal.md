## Why

模型会拦截已收录的普通关键词，也会把部分单条件的值提取不完整，导致索引中已经存在相关记录时，用户仍看到查询失败、空结果或与条件不符的记录。

## What Changes

- 使用当前索引验证普通关键词与字段条件。
- 用原有用例复测误拦和错筛。

## Capabilities

### Modified Capabilities

- `ois-global-search`：关键词与单条件筛选。

## Impact

搜索后端和回归验收。
