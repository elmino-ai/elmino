---
"@elmino/request": minor
"@elmino/protocol": minor
"@elmino/thread": minor
---

提取通用 Fetch、HttpError 与独立 oRPC 入口；新增跨端事件、线程快照校验、严格 JSON 序列化与事件流游标。Thread 提供无 Node.js 实现依赖的 events 子入口，供传输层复用已有领域定义与载荷读取能力。

拒绝同时携带文本与工具输出的歧义增量，统一传输事件与线程投影的读取结果。
