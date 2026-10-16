# 开发约定

## 沟通与范围

- 默认使用中文回复
- elmino 是可复用开发框架，首阶段只提取模型适配和 Agent 内核
- 当前继续提取请求、协议、API、Server 与纯客户端 SDK；UI、插件体系与产品业务留待后续明确需求落地
- 对可从源码确认的事实先主动调研；产品意图或高影响架构选择无法确定时及时沟通

## 工程环境

- 使用 Node.js 24、pnpm 11 workspace、TypeScript 和 ESM
- 依赖版本由根 `pnpm-workspace.yaml` catalog 维护
- 工程命令从根目录执行，依赖声明变化后使用 `pnpm install` 更新锁文件
- 不手工修改锁文件，不新增 npm 或 yarn 锁文件
- 公共编译策略在 `tsconfig.base.json` 维护，发布包输出可直接被 Node.js 消费的 JavaScript 和类型声明
- TypeScript 相对导入省略文件后缀；各包共用 `tsdown.config.mjs` 保留模块目录，并为 ESM 产物与类型声明补齐 `.js`，仓库外验收继续使用严格 NodeNext
- 能力包位于 `packages/<能力>`，公开包名使用 `@elmino/*`，跨包通过公开入口导入
- 文档随内容增长归根 `docs`，包根不重复维护工程文档

## 能力边界

- `llm` 只持有模型协议、公共消息处理与通用请求约束，不依赖 Agent、存储、UI、厂商 SDK 或产品配置
- `llm-openai` 与 `llm-anthropic` 分别持有对应消息协议的适配器和厂商差异
- Provider 原生字段只留在适配器边界，内部工具调用统一使用 `args`
- `shared` 持有实际跨包复用的纯工具和通用类型，领域类型留在实际拥有该能力的包，不整包复制产品共用代码
- `schema` 是仅依赖 Zod 的通用字段规则叶子包，不设置环境默认值或加载配置；领域 ID Schema 归 protocol，接口结构与文档说明归 api，不为共用校验把 shared 基础工具绑定到 Zod
- `local` 持有本机环境快照、登录环境加载、程序探测与 Shell 选择，复用 `sandbox` 的环境契约；目录、认证、模型配置和应用控制数据归宿主。命令与环境加载共用进程清理，环境刷新不改变已创建 Runtime 的快照
- `store` 持有 RuntimeStore、BlobStore、运行记录和持久化线程数据契约；本地 BlobStore 从 `/local` 引入，默认使用 Node 文件系统，也可注入 BlobFiles；基础入口不加载 Node 实现
- `store-sqlite` 持有 SqliteStore、Drizzle 仓储与运行数据库迁移，提供 `sqliteStore()` 延迟配置，目录优先显式 dataDir，其次 ELMINO_DATA_DIR，再次定义时 cwd 下的 .elmino，默认在其下使用 database 与 blobs；不持有产品 control.db、工作区控制目录或 UI 默认文案
- `engine` 持有 Agent 调度与执行生命周期，执行实体按 `Thread -> Turn -> Step -> ToolInvocation` 组织；`loop` 持有单轮执行，`agent` 装配工具、Hooks、Loop、Thread 和 Runtime，插件体系暂不迁入
- 模型解析、持久化、运行环境与事件处理通过实际能力契约注入，避免内核依赖具体应用
- `request` 持有通用 Fetch 与独立 oRPC 子入口；`protocol` 持有跨端 Schema、事件 JSON 和游标语法，复用 `thread` / `store` 的领域类型，事件定义与工厂仍归 `thread/events`；连接、回放队列和重连分别归 Server / SDK
- `core` 通过 defineElmino 装配 Agent、模型、工作区与共享 Engine，持有执行和配置 Store 租约；`api` 持有远程契约，`server` 借用 Elmino，只拥有 HTTP 与自己的回放和订阅，`sdk` 持有纯客户端调用与重连。关闭 Server 不关闭 Elmino；创建方分别关闭两者。Elmino 在 Engine 和观察结束后释放租约，直接传入或动态工作区返回的 Store 仍由宿主关闭；账号、产品模型目录、工作区管理及 React 状态不迁入
- Server 的 HTTP 路由、中间件、CORS 与错误响应使用 Hono，协议和逐项授权仍归 oRPC；宿主通过 `http(app)` 同步扩展中间件与自定义路由，所有请求共用关闭门禁与请求结算
- Server 与 SQLite 在各自配置入口使用 `@t3-oss/env-core` 读取所属环境变量，框架变量统一使用 `ELMINO_` 前缀，供应商已有前缀（如 `DEEPSEEK_`）保留；显式参数优先，空环境值按缺省处理；读取使用独立快照，不修改 process.env、不自动加载环境文件；Core 和浏览器 SDK 不承担服务端环境配置
- 产品预设、品牌、账号、市场、遥测上报和 UI 不进入内核
- elmino 不反向依赖宿主应用；应用通过公开包接入框架，接入后清理自身重复实现
- 不为目录对称预建空包、空文件、一次性封装、重复状态或薄转发层
- 新增抽象以实际消费和稳定生命周期为依据，逐步迁移并保留每一批次可独立验收的边界

## npm 包与发布

- 每个对外能力包必须能独立安装、构建、打包和发布；仓库根保持 `private: true`，发布包声明自身名称、版本与公开发布配置
- 模型公共协议归 `llm`，厂商 SDK 与适配实现归独立模型适配器包；`llm` 和 `engine` 不依赖具体适配器包
- 独立包用于隔离安装依赖和发布边界，包内子路径用于细分公开 API；不按源码文件数量机械拆包
- `exports`、`types` 和运行入口指向构建产物，不让消费者依赖 TypeScript 源码、仓库路径别名或宿主应用目录
- 公共检查配置使用 `tsconfig.base.json`，公共产物配置使用 `tsconfig.build.base.json`；各包自行声明源码范围和输出目录
- 发布内容使用 `files` 白名单，包含实际入口、类型和运行所需资源；Prompt、迁移等资源由所属包交付
- 各包完整声明直接运行依赖；共享宿主实例的插件契约按真实要求声明 peer dependency，可选能力不进入基础包的安装依赖链
- 开发时使用 workspace 协议，打包后验证内部依赖已转换为正常版本范围，且不存在 workspace 协议或本地路径依赖
- 第一批真实包落地时接入 Changesets 管理版本、变更记录与受影响依赖；发布动作单独授权
- 包级验收必须覆盖构建、打包内容，以及在仓库外安装 tarball 后通过公开入口运行和检查类型；不能只验证 workspace 源码导入
- SQLite 版本化迁移随 `store-sqlite` 发布；迁入既有迁移文件保持内容一致，不手改 SQL 或启动时清库，后续 Schema 变化先接入所属包的迁移生成和一致性检查
- 同一数据目录共享 SqliteStore 的调用方必须共享同一个 BlobStore 实例，关闭后才允许更换装配；同一 sqliteStore 配置通过引用计数管理并发租约，最后释放时关闭；直接传入的实例由创建方关闭，事务回滚不回滚外部 blob 写入

## 源码与检查

- TypeScript 出口使用具名 `export` 和 `export type`，不使用星号导出
- 能力包的 `index.ts` 只聚合出口，实现按职责组织到所属模块；示例的 `src/index.ts` 只负责启动与入口错误处理
- 接口与字段说明职责，复杂流程就近解释生命周期、状态来源和失败边界
- 使用 `interface` 表达对象结构，联合与工具类型使用 `type`
- 类型检查、构建和测试脚本随真实源码与测试落地，不声明空测试命令
- 能力测试归所属包 `tests`；只运行本轮相关文件的 ESLint、类型检查和测试
- Server 与 SDK 教程分别归 examples/tutorial/03-server 和 examples/tutorial/04-sdk，各自以 src/index.ts 启动并维护自己的环境文件；SDK 教程生产代码仅连接已存在服务，模型和存储装配归 Server 教程
- 根目录交付测试按 `tests/<能力>/consumer.ts` 组织，入口归 `tests/runner`，跨领域验收辅助代码归 `tests/support`；消费样例使用真实 TypeScript 文件，不通过字符串生成源码
- 核心重构完成后按命名与出口、依赖与所有权、完整生命周期链路进行三轮复查
- 修复问题应定位设计源头，完成每批次后清理重复实现和残留入口
- 调整现有执行语义前核对源项目与参考实现的当前源码，不根据记忆猜测行为

## 数据与 Git

- 不复制或输出真实密钥、本地认证和运行数据；配置说明只引用示例文件
- 长期用户资产的结构变化通过迁移保留，不能用自动清库解决不一致
- 测试通过参数注入临时目录，不修改 `HOME`
- 删除、迁移和重命名目录前说明绝对路径与影响范围，再执行最小范围操作
- 默认保持未提交，用户明确要求后才提交；提交主题使用 conventional commits 和中文描述
- 提交通过 Husky 运行 lint-staged 与 commitlint；pre-commit 对已暂存 JS/TS 执行 ESLint 自动修复，不手工提前运行 `--fix`，不绕过 Hook
- 不在未授权时创建远程、推送或改写已有提交

<!-- CODEGRAPH_START -->
## CodeGraph

- 仓库存在 `.codegraph/` 时，理解或定位代码优先使用 CodeGraph，再按需使用 `rg` 或读取文件
- 在仓库根执行 `codegraph explore "<符号、文件或问题>"`，获取当前源码、调用链与影响范围；可用时也可使用 MCP 的 `codegraph_explore`
- 符号或文件查询不完整时再补充搜索；怀疑索引过期时先执行 `codegraph sync`，通过 `codegraph status` 检查状态
- 本地索引不提交 Git，首次检出后可运行 `codegraph init .`；没有索引时跳过 CodeGraph，不自动初始化

<!-- CODEGRAPH_END -->
