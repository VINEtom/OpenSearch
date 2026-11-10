## Context

EMR 的成像方式和扫描部位已进入正文。正文匹配无法确认命中来自哪个字段。

## Goals / Non-Goals

保留正文搜索；增加两个字段的精确筛选。

## Decisions

从 EMR 的 imaging_modality_key 和 scan_site_list 投影 keyword 字段，成像方式统一大写。扫描部位按列表成员匹配，统一 Head 与头部，不用治疗部位或正文补值。解析完整输入后使用 term 过滤；两个条件在同一文档取交集。网页显示 API 返回的识别条件。旧批次用发布元数据区分字段缺失和确实无结果。

## Risks / Trade-offs

真实来源需重新同步；旧快照无法补回已丢失的字段边界。
