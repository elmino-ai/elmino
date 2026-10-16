---
'@elmino/sdk': minor
'@elmino/thread': minor
'@elmino/protocol': minor
'@elmino/api': minor
'@elmino/core': minor
'@elmino/server': minor
---

统一 SDK 会话快照与执行控制，新建、恢复和审批立即返回可控制的运行句柄，通过 accepted 和 completed 分别等待接纳与终态。新增无框架 Composer 草稿与队列，以及独立、可选的 React Hook 和 oRPC Query 子入口，基础 SDK 安装不引入前端依赖。

新增持久运行记录查询与按完整 Turn 分页的会话历史，保留冻结配置身份、失败原因和交互事实。统一流式投影、重连校准与观察资源所有权，防止重复输出、观察者互相清除正文锚点及删除后的迟到响应恢复旧状态。
