## Why
全局搜索的结构化条件由模型提取。现阶段验收范围为明确单条件，未通过模型验收的筛选暂不开放。用户直接输入关键词时仍可查看匹配的业务记录。

## What Changes
- 从在线搜索移除手写句式解析。
- 单据模型和患者模型只执行通过字段目录校验的单条件。

## Capabilities
### Modified Capabilities
- `ois-global-search`

## Impact
涉及查询解析、模型路由和搜索回归。
