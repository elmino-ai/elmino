---
'@elmino/server': minor
---

公开创建入口统一为 defineServer，AgentServer 仅作为实例类型导出，移除 AgentServer.create。支持固定工作区的 id、rootDir、store 简写与固定 apiKey，并保留动态资源和自定义鉴权回调。同步示例、文档和仓库外交付验收
