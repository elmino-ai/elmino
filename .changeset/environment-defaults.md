---
'@elmino/server': minor
'@elmino/store-sqlite': minor
---

使用 env-core 在各自入口读取环境配置。Server 默认读取访问凭据、浏览器来源与监听地址，SQLite 目录支持省略并读取 ELMINO_DATA_DIR；显式参数优先，未配置时采用默认值。实例保留独立配置快照，不自动加载环境文件。

框架环境变量统一使用 ELMINO_ 前缀，不再读取通用的应用环境变量，避免与宿主配置冲突。
