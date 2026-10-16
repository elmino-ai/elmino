---
'@elmino/schema': minor
'@elmino/protocol': minor
'@elmino/api': patch
'@elmino/server': patch
'@elmino/store-sqlite': patch
---

提取无业务依赖的通用字段 Schema，配置入口复用字符串、HTTP 地址、来源和端口规则。协议层导出具名领域 ID Schema，API 共用校验并补充字段说明、示例及操作语义。OpenAPI 保留自定义领域结构的同时合并文档元数据，并根据真实固定凭据配置展示认证要求。
