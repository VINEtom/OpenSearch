## Why

工作人员需要按正式诊断查找患者。一个患者可能有多条同病种诊断，患者列表应只显示一行，并提供可以打开的原始诊断作为命中依据。

## What Changes

- 增加「按诊断找患者」入口。
- 按正式诊断筛选患者，合并同一患者的匹配记录。

## Capabilities

### Modified Capabilities

- `ois-global-search`：按诊断找患者及打开命中的诊断。

## Impact

新增查询接口和页面入口，复用现有诊断索引及详情。
