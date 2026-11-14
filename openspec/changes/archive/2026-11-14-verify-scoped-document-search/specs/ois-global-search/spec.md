## ADDED Requirements

### Requirement: 指定类型时保留完整单字段条件
搜索 SHALL 按指定单据类型执行已识别的完整单字段条件。

#### Scenario: 指定类型后仍使用完整值
- **WHEN** 用户指定类型且输入明确的单字段条件
- **THEN** 搜索按完整值和指定类型返回记录并展示命中字段
