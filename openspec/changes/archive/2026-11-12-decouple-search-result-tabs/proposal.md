## Why
切换结果分类会改变患者字段查询的执行方式。同一句查询应保留相同的匹配条件，让分类标签只决定当前列表显示哪些记录。

## What Changes
- 切换结果分类时保留原搜索条件和各分类计数，并按所选分类分页。

## Capabilities
### Modified Capabilities
- `ois-global-search`

## Impact
影响全局搜索的患者查询解析与结果分类。
