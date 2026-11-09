## Why

页面同时提供全局搜索和按诊断找患者。后者是另一套患者列表，和全局搜索回答的问题不同，当前只需要保留全局搜索。

## What Changes

- **BREAKING**：删除顶部「按诊断找患者」入口、对应页面和 `/api/prototype/diagnosis-patients`。
- 全局搜索保持不变，包括按确诊日期和处方分次数找患者。

## Capabilities

### New Capabilities

### Modified Capabilities

- `ois-global-search`：不再提供按诊断找患者。

## Impact

- 前端导航与 `DiagnosisPatientSearch`。
- `server/diagnosis-search.ts` 及对应集成测试。
- 需求、交互、设计和测试文档中的该入口说明。
