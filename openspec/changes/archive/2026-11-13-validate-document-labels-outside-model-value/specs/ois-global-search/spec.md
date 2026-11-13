## ADDED Requirements

### Requirement: 识别取值中的目录名称
单据搜索 SHALL 在验证明确单条件时区分模型识别的值和实际筛选字段。

#### Scenario: 字段值包含目录名称
- **WHEN** 模型识别一个单条件且其值内出现字段名或单据类型
- **THEN** 系统按值以外的明确单据类型和字段执行筛选
