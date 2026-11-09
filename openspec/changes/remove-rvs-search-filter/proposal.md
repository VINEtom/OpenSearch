## Why

搜索页的来源筛选项仍包含 RVS。当前接入的是 PMS 和 EMR，治疗计划没有对应来源，不适合继续作为页面分类。

## What Changes

- 数据来源只保留全部来源、PMS、EMR。
- 记录分类为全部记录、患者、诊断、计划申请单、其他单据。全部记录是这四类的合计。

## Capabilities

### New Capabilities

### Modified Capabilities

- `ois-global-search`：搜索页不再提供 RVS 来源和治疗计划分类。

## Impact

- 全局搜索页的来源按钮和记录分类。
- 交互说明中的筛选项。
