## Why

全局搜索将组合查询中的年龄误识别为身高，导致实际符合条件的患者没有显示。需要把年龄与其他患者条件一起执行，并让结果说明反映实际命中。

## What Changes

- 支持年龄与其他已支持的患者字段通过「且」或「并且」组合。
- 条件未完整识别时提示改写。

## Capabilities

### Modified Capabilities

- `ois-global-search`：组合年龄和患者字段筛选。

## Impact

全局搜索接口和结果页。
