## ADDED Requirements

### Requirement: 按连续字符查询单据字段

字段包含查询 SHALL 匹配指定字段索引值中的连续字符。

#### Scenario: 字段值包含查询片段
- **WHEN** 用户查询中止原因包含 ddd
- **THEN** 中止原因是 dddd 的同类单据也应返回
