---
'@elmino/server': minor
---

为 defineServer 返回的服务增加 start()：默认监听本机 3000 端口并处理退出信号，close() 统一结算执行、订阅、存储租约与 HTTP 监听。启动失败自动清理，保留 Fetch 嵌入与独立 Node 适配器入口。
