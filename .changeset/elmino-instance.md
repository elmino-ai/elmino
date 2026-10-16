---
'@elmino/core': minor
'@elmino/agent': patch
'@elmino/server': minor
---

新增 defineElmino 应用实例，统一注册 Agent、模型、工作区与执行资源，支持本地调用和多个 Server 共享。Agent 可选择默认模型，Server 改为显式接收 elmino，关闭 HTTP 不再关闭共享 Engine 或存储租约。
