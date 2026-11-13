## ADDED Requirements

### Requirement: 补全明确患者枚举值

患者搜索 SHALL 使用原输入中可唯一核实的完整枚举值补全模型提取的值片段。

#### Scenario: 放疗类型的值被截短
- **WHEN** 模型提取放疗类型及值片段，且原输入包含唯一对应的完整枚举值
- **THEN** 搜索按完整枚举值筛选患者
