## ADDED Requirements

### Requirement: 普通关键词的字段命中

普通关键词搜索 SHALL 支持患者性别的索引值和显示名称，并展示命中的拆分字段。

#### Scenario: 直接搜索性别编码
- **WHEN** 用户输入 unknown
- **THEN** 搜索结果包含性别编码为 unknown 的患者并显示性别命中
