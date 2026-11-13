## Why

明确的患者和单据条件会因模型意图识别错误、取值被拆分，或诊断模型提前拦截而无法执行。

## What Changes

- 补训患者和单据模型，复测原有明确条件与普通关键词。
- 允许可核实的患者单条件通过诊断模型的改写提示。

## Capabilities

### Modified Capabilities

- `ois-global-search`：明确单条件搜索。

## Impact

搜索后端、模型权重和离线回归。
