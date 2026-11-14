## ADDED Requirements

### Requirement: 复核跨单据筛选的取值
搜索 SHALL 复核省略类型的单字段条件并保留完整取值。

#### Scenario: 省略类型时模型截短取值
- **WHEN** 同一字段的完整取值可从原输入及索引中核实
- **THEN** 搜索按完整值匹配适用单据

### Requirement: 字段名称可作为普通关键词
仅输入单据字段目录里的完整字段名称时，搜索 SHALL 执行普通关键词搜索。

#### Scenario: 只输入字段名称
- **WHEN** 用户只输入「固定说明」
- **THEN** 搜索返回关键词查询结果
