## Why

用户会在同一句话里描述单据字段和正文线索，例如指定 CT 并查找趴着摆位的备注。单靠正文关键词会漏掉用「俯卧」描述的相关片段。

## What Changes

- 用本地 BERT 提取组合查询中的候选条件，再按字段规则核对。
- 用本地 BGE 对候选单据重排，展示得分最高的原文片段。
- 模型不可用时保留基础搜索。

## Capabilities

### Modified Capabilities

- `ois-global-search`：支持结合定位字段和正文线索搜索。

## Impact

搜索后端增加可选的本地 Python 推理进程和模型文件配置。网页展示相关片段。
