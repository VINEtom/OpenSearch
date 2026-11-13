## Why

模型可能把一个值标成多个片段，导致明确的单条件被拦截。索引可以核实这些片段是否属于同一个完整值。

## What Changes

- 复核同一字段的多个取值片段。

## Capabilities

### Modified Capabilities

- `ois-global-search`

## Impact

单条件取值验证。
