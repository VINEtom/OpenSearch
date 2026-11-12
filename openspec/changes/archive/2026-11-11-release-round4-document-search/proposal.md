## Why
第四轮模型需要随待发布版本进入集成验收，支持明确的单条件单据查询，并验证指定单据类型、数值边界和模型不可用时的提示。

## What Changes
- 通过独立配置启用第四轮模型，校验单据类型、字段、比较方式和取值。
- 验收已有命中、拒绝歧义条件和模型不可用时的行为。

## Capabilities
### Modified Capabilities
- `ois-global-search`：明确的单条件单据查询。

## Impact
涉及全局搜索 API、模型配置和集成回归。
