---
'@elmino/engine': minor
---

新增 runAgent 单次任务入口，自动生成线程与 Turn 身份、计算项目执行位置、接收文本或结构化输入并在执行后释放 Engine。返回持久化状态与结果，Store 继续由宿主关闭。简化基础 Agent 示例并保留 AgentEngine 的会话和恢复能力
