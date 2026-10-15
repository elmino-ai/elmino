---
'@elmino/store': minor
'@elmino/store-sqlite': minor
'@elmino/engine': minor
'@elmino/server': minor
---

支持通过 sqliteStore({ dataDir }) 延迟配置存储，默认装配 SQLite 与本地 BlobStore。同一配置共享存储租约，最后一个调用释放后关闭；runAgent 和 Server 固定工作区负责释放配置租约，直接传入的 Store 仍由宿主关闭。LocalBlobStore 提供默认 Node.js 文件能力并保留自定义注入，两个示例不再手动装配存储
