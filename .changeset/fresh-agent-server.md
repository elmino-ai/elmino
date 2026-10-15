---
"@elmino/api": minor
"@elmino/server": minor
"@elmino/sdk": minor
"@elmino/protocol": minor
"@elmino/shared": patch
---

提取纯 API 契约、可注入宿主资源的 Agent Server 与浏览器兼容 SDK，接通任务提交、线程查询、审批恢复、中断引导及带游标回放的事件订阅。Node 监听器独立从 server/node 引入。

协议层复用轻量线程列表 Schema，允许领域输出中已声明的可选 undefined 字段按 JSON 省略，并拒绝稀疏数组等有损 JSON 数据。SDK 在处理成功后确认游标，支持背压、退避重连与主动取消清理。
