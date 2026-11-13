## ADDED Requirements

### Requirement: 核实单条件的连续取值
搜索 SHALL 核实同一单条件的多个值片段是否对应同一索引值。

#### Scenario: 模型将单一字段值拆段
- **WHEN** 模型识别为单条件，且同字段片段可唯一定位并得到索引核实
- **THEN** 按核实后的值筛选
