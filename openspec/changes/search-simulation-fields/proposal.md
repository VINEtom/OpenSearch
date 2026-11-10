## Why

成像方式和定位部位混在单据正文中，用户无法按字段准确查找定位申请单。

## What Changes

- 在全局搜索框支持按成像方式、定位部位查定位申请单，两个条件可组合。
- 在结果页显示识别出的条件。旧批次缺少字段时提示重新同步。

## Capabilities

### Modified Capabilities

- `ois-global-search`：按定位申请单字段查找。

## Impact

EMR 搜索投影、OpenSearch 批次、搜索接口和结果页。
