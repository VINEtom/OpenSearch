## ADDED Requirements

### Requirement: 模型识别完整诊断名称
全局搜索 SHALL 支持由诊断模型提取完整标题并精确筛选诊断记录。

#### Scenario: 指定完整诊断名称
- **WHEN** 模型从明确查询中提取完整诊断标题
- **THEN** 返回标题相同的诊断记录，并高亮标题
