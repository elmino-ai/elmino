# 开发指南

框架边界与包导航见 [README](../README.md)，源码、数据与发布约定见 [AGENTS.md](../AGENTS.md)。工程命令在仓库根目录执行

## 环境与依赖

使用 [.node-version](../.node-version) 中的 Node.js 24，以及根 [package.json](../package.json) `packageManager` 固定的 pnpm 11 版本。TypeScript 和直接依赖版本由 [workspace catalog](../pnpm-workspace.yaml) 统一维护

```sh
pnpm install
```

新增或调整依赖后执行 `pnpm install` 更新锁文件，不手工编辑解析结果。CI 使用 `pnpm install --frozen-lockfile`，发现声明与锁文件不一致时直接失败

依赖采用 `trustPolicy: no-downgrade`。ESLint 的 Babel 链仍要求 `semver@6.3.1`；该版本发布于 2023 年，registry 完整性与锁文件一致，仅对这个精确版本记录例外。未来依赖链移除该版本时一并删除例外，不扩大到整个包或关闭策略。配置语义见 [pnpm 依赖信任策略](https://pnpm.io/settings/dependency-resolution#trustpolicy)

`prepare` 配置 Husky Git Hooks。本地环境文件和运行数据不进入 Git，测试使用参数注入的临时目录，不修改 `HOME`

## 代码导航

CodeGraph 是可选的本地代码导航工具，不加入框架运行依赖或 CI。安装 CLI 后，在仓库根初始化自己的索引：

```sh
codegraph init .
codegraph status
codegraph explore "defineServer"
```

源码更新后可执行 `codegraph sync` 增量同步。需要完整重建时执行 `codegraph index .`。已有索引时，智能体按 [开发约定](../AGENTS.md) 优先查询 CodeGraph，再补充文本搜索

`.codegraph/.gitignore` 跟随仓库保存，其余数据库、日志与后台服务文件只留在本机。新检出环境需要自行建立索引，不复制其他开发者的数据库

## 提交检查

[pre-commit](../.husky/pre-commit) 通过 lint-staged 对暂存的 JS、TS 文件执行 `eslint --cache --fix`；[commit-msg](../.husky/commit-msg) 通过 commitlint 校验 Conventional Commits

提交主题使用英文 type 与可选 scope，冒号后默认中文，例如 `feat(tool): 提取工具参数校验与审批契约`。日常检查不提前执行 `--fix`，不绕过 Hook，不自行改写已有提交

同一文件存在暂存与未暂存修改时，提交前分别核对两份内容，提交后确认未暂存修改仍然保留。检查工具和 Hook 不替代提交范围审查

## 构建、检查与缓存

[Turbo 配置](../turbo.json) 按包依赖安排构建，`typecheck` 和 `test` 会先构建本包及其依赖。跨包从公开入口消费 `dist`，不使用源码路径别名

各包共用 [tsdown 配置](../tsdown.config.mjs)，采用 `unbundle` 模式保留 `src` 到 `dist` 的模块目录。TypeScript 源码使用无后缀的相对导入；JavaScript 和类型声明产物自动补齐 `.js`，消费项目继续按 NodeNext 检查，不需要特殊加载器。源码检查使用 `moduleResolution: Bundler`，类型检查由 TypeScript 执行

构建时重建各包的 `dist` 产物，避免删除或移动源码后留下旧文件；Loop 与 Engine 的提示词资源随后复制到对应产物目录，SQLite 迁移继续由包的文件白名单交付。外部依赖保持独立，不内联其他能力包或供应商 SDK。构建行为见 [tsdown unbundle 文档](https://tsdown.dev/options/unbundle)

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm spellcheck
```

日常只检查修改文件与受影响包，例如：

```sh
pnpm exec eslint packages/tool/src/define/define.ts
pnpm exec turbo run build --filter=@elmino/tool...
pnpm --filter @elmino/tool typecheck
pnpm --filter @elmino/tool exec vitest run tests/definitions.test.ts
```

直接运行包级命令不会自动执行 Turbo 的依赖图，所以先构建所需公开入口。公开类型或包出口变动时，同时检查真实调用方

Turbo 的本地缓存位于 `.turbo`，构建缓存包含 `dist`，检查结果按源码与依赖变化失效。公共 TypeScript 配置属于全局构建输入。缓存、产物、覆盖率和 ESLint 缓存均由 `.gitignore` 排除

需要重新执行构建时可使用 `pnpm exec turbo run build --force`。不把依赖本地环境或外部服务的结果当作稳定缓存；未来接入这些能力时，需要同步调整对应任务的输入、环境声明或缓存策略

[CSpell 配置](../cspell.json) 检查源码、测试、配置和文档中的技术拼写。词典仅收录当前源码实际使用的工具名、协议字段和命令参数，优先修正错误拼写，不为通过检查复制整个产品词典或忽略整块源码

## SQLite 迁移

运行事实 Schema 与迁移归 `@elmino/store-sqlite`，产品控制数据和用户目录装配归宿主

```sh
pnpm --filter @elmino/store-sqlite db:check
pnpm --filter @elmino/store-sqlite db:generate
```

`db:check` 在独立临时目录检查迁移图及当前 Schema 与最近快照的一致性，不连接用户数据库，也不修改发布资源。实际 Schema 变更通过 `db:generate` 生成版本化资源，再审查生成结果、执行相关测试并一起提交

不通过启动时自动清库解决不一致，不手改既有 SQL 或迁移快照。数据库事务只回滚数据库事实，外部 blob 写入保留自身存储生命周期

## 独立 npm 包交付

根项目保持私有，每个公开能力包独立声明版本、运行依赖、`exports`、产物白名单和公开发布配置。基础契约包不依赖具体模型、数据库或本地沙箱实现

可运行消费示例归 `examples/<分类>/<场景>`，使用 `@example/<场景>` 私有工作区名称，独立声明实际依赖，不参与 `@elmino/*` 的打包与发布。分类规则如下：

- `tutorial` 放上手教程，场景目录按学习顺序使用 `01-`、`02-` 等两位序号，从简单到复杂
- `reference` 按框架能力命名，例如 `agent-engine`，每个示例可独立查阅，不使用顺序编号
- `integration` 用于第三方框架、平台或服务接入，有实际示例时再创建目录

包名与根启动命令按场景命名，不携带目录序号。例如 `@example/basic-agent` 对应 `pnpm example:basic-agent`，调整教程排序不改变调用方式。`src/index.ts` 只负责启动，实现放在所属子目录。[Basic Agent 示例](basic-agent.md) 分成最少参数的 Basic 和展示单次运行可选配置的 Full，两者独立运行且各自维护模型环境变量；类型检查通过 Turbo 的依赖图先构建所需能力包

示例需要本地配置时，在自身根目录放置 `.env` 与不含密钥的 `.env.example`，通过自己的启动命令加载 `.env`。真实 `.env` 由根 `.gitignore` 忽略，不在源码中写入密钥，也不跨示例共享环境文件

[03-elmino](elmino-example.md) 讲本地应用实例：在 `examples/tutorial/03-elmino/.env` 配置模型，可选设置 `ELMINO_DATA_DIR`，从根目录执行 `pnpm example:elmino`。用 `defineElmino()` 注册 Agent、模型与工作区，再通过 `await elmino.run()` 在同一线程完成两轮，查询线程后在 `finally` 中关闭实例。私有工作区包名为 `@example/elmino`

[04-server](server-example.md) 只负责服务端：在 `examples/tutorial/04-server/.env` 填写 `DEEPSEEK_API_KEY`，可选配置 `ELMINO_SERVER_KEY`，从根目录执行 `pnpm example:server`。Server、SQLite 与模型在所属入口读取配置，默认监听 `127.0.0.1:3000`，启动不会调用模型；数据默认保存在示例自己的 `.elmino`。按 `Ctrl+C` 由示例宿主统一关闭 Server 与 Elmino，等待 Store 租约释放。私有工作区包名为 `@example/server`

[05-sdk](sdk-example.md) 只负责客户端：先保持 Server 运行，再配置 `examples/tutorial/05-sdk/.env` 中的 `ELMINO_SERVER_URL` 与可选 `ELMINO_SERVER_KEY`，从另一个终端执行 `pnpm example:sdk`。它不读取模型、监听或存储配置，任务完成后自行退出，Server 继续运行。私有工作区包名为 `@example/sdk`。依赖已构建时，两者也可在各自示例目录执行 `pnpm start`，各自加载自己的 `.env`

[AgentEngine](agent-engine.md) 归 `reference`，展示生命周期 API：同线程多轮、显式管理 Engine 和 Store、工具审批与同进程引擎重建后的恢复。运行命令为 `pnpm example:agent-engine`，模型配置来自自己的 `.env`。

其他 Reference 各自只展示一类能力：`agent-hooks` 展示上下文与工具策略，`turn-control` 展示运行中引导和中断，`subagents` 展示显式派生与等待。根命令分别为 `pnpm example:agent-hooks`、`pnpm example:turn-control` 和 `pnpm example:subagents`。完整入口导航见 [Agent 使用指南](agent.md)

示例源码需要能直接用于教学。每个启动入口和主流程文件先写清学习目标、启动命令、预期现象与阅读顺序；关键流程按真实执行步骤解释，参数旁说明默认值、选择原因和影响。涉及模型快照、任务身份、审批、事件去重或资源关闭时，就近说明输入来源、成功与失败分支以及资源所有权。测试应明确指出它验证哪条可观察路径，注释与实际断言保持一致

示例的测试只注入确定性模型，验证工具调用、持久化、断网回放与 Server 重建恢复，不读取 `.env`、不调用外部模型服务

使用 Changesets 记录公开行为与类型变化：

```sh
pnpm changeset
pnpm version:packages
pnpm install
pnpm verify:packages
```

`.changeset` 保存版本变更意图，需要提交 Git。版本生成和依赖解析分别执行，避免手工修改锁文件

`verify:packages` 先在 `dist/packs` 生成各能力包的 tarball，再由 [交付测试入口](../tests/runner/run.mjs) 检查入口、类型、资源、映射源码与依赖版本，并安装到仓库外临时目录验证公开 API 和安装边界

包自身的功能测试位于 `packages/<能力>/tests`；根目录交付测试直接按 `tests/<能力>/consumer.ts` 组织，领域内复用代码留在对应目录，执行入口归 `tests/runner`，跨领域验收辅助逻辑归 `tests/support`。消费程序使用真实 TypeScript 文件，通过公开包入口装配能力；复用包内测试夹具时使用明确的相对导入，执行器沿相对导入复制所需文件到独立消费项目，复制时为 NodeNext 补齐 `.js` 后缀，不拼接 TypeScript 源码字符串

根 `tests` 是 `@tests/delivery` 私有工作区，通过自身的依赖声明与 `tsconfig.json` 支持编辑器解析和类型检查，根 `pnpm typecheck` 会包含它并先构建依赖包。它不参与 `@elmino/*` 发布，不使用指向生产源码的路径别名；本地类型检查与仓库外 tarball 验收分别覆盖开发时导入和实际交付边界

尚未发布的同批内部依赖通过验收项目的 pnpm overrides 指向对应 tarball；发布内容本身必须保存正常版本声明，不能依赖 workspace 协议、仓库路径或宿主应用源码。验收临时目录保留供诊断，测试不读取用户模型配置、不调用真实模型服务

交付验收会在临时消费项目中生成并更新依赖清单，所以该项目使用 `pnpm install --ignore-scripts --no-frozen-lockfile`，允许同步生成锁文件。仓库自身在 CI 中仍使用 `pnpm install --frozen-lockfile`，两者的安装策略按各自的锁文件来源区分

发布 npm 需要独立授权。CI 执行交付验证，不上传或发布包

`schema`、`request`、`protocol`、`api` 与 `sdk` 的交付程序还会执行无 Node 类型的浏览器模式编译，并用浏览器条件完整打包，检查产物不含外部 Node 模块或隐式 polyfill，再用标准 Web API 执行该产物。这属于构建验收，不启动浏览器。请求、Schema 和恢复游标的边界见 [请求与事件协议](transport.md)

## 持续集成

[CI 工作流](../.github/workflows/ci.yml) 是 elmino 的独立框架验收入口

工作流在 push、pull request 和手动触发时运行，在 Ubuntu 与 macOS 上使用相同的 Node.js 24、pnpm 11 和冻结锁文件，覆盖构建、类型、包级测试、ESLint、拼写、SQLite 迁移及仓库外安装验收。pull request 额外检查提交信息

工作流通过 [setup-node](https://github.com/actions/setup-node) 读取 `.node-version`，通过 [pnpm/action-setup](https://github.com/pnpm/action-setup) 读取 `packageManager` 并缓存 pnpm store。两步独立安装 Node.js 与 pnpm，不把依赖缓存当作 `node_modules` 或交付产物

Git Hooks、Turbo 缓存和 CI 各自承担提交检查、任务调度和完整交付验证。核心重构仍需按命名与出口、依赖与所有权、完整生命周期分三轮复查
