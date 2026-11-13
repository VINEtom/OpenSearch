## Why

明确单条件仍会因为取值截断或索引原值与字段声明不一致而被拦截，用户无法找到已收录的记录。

## What Changes

- 核验可补全的患者枚举及可执行的单据原值。
- 补训剩余条件的值边界并回归原用例。

## Capabilities

### Modified Capabilities

- `ois-global-search`：明确单条件检索。

## Impact

搜索后端、模型候选权重和回归。
