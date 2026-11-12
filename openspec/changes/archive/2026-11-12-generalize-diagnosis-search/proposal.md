## Why
明确确诊查询需要覆盖索引中的病种。同步后的诊断名称应能用于搜索，无需为每个病种增加句式或训练独立模型。

## What Changes
- 按索引中的标准诊断名称解析病种，复用已有确诊日期和患者查询。

## Capabilities
### Modified Capabilities
- `ois-global-search`

## Impact
涉及本地诊断模型和按批次读取的术语目录。
