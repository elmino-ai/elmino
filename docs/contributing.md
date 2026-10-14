# 开发指南

框架边界与包导航见 [README](../README.md)，源码、数据与发布约定见 [AGENTS.md](../AGENTS.md)。工程命令在仓库根目录执行

## 环境与依赖

使用 [.node-version](../.node-version) 中的 Node.js 24，以及根 [package.json](../package.json) `packageManager` 固定的 pnpm 11 版本。TypeScript 和直接依赖版本由 [workspace catalog](../pnpm-workspace.yaml) 统一维护

```sh
pnpm install
```

新增或调整依赖后执行 `pnpm install` 更新锁文件，不手工编辑解析结果。CI 使用 `pnpm install --frozen-lockfile`，发现声明与锁文件不一致时直接失败

`prepare` 配置 Husky Git Hooks。本地环境文件和运行数据不进入 Git，测试使用参数注入的临时目录，不修改 `HOME`

## 提交检查

[pre-commit](../.husky/pre-commit) 通过 lint-staged 对暂存的 JS、TS 文件执行 `eslint --cache --fix`；[commit-msg](../.husky/commit-msg) 通过 commitlint 校验 Conventional Commits

提交主题使用英文 type 与可选 scope，冒号后默认中文，例如 `feat(tool): 提取工具参数校验与审批契约`。日常检查不提前执行 `--fix`，不绕过 Hook，不自行改写已有提交

同一文件存在暂存与未暂存修改时，提交前分别核对两份内容，提交后确认未暂存修改仍然保留。检查工具和 Hook 不替代提交范围审查

## 构建、检查与缓存

[Turbo 配置](../turbo.json) 按包依赖安排构建，`typecheck` 和 `test` 会先构建本包及其依赖。跨包从公开入口消费 `dist`，不使用源码路径别名

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

使用 Changesets 记录公开行为与类型变化：

```sh
pnpm changeset
pnpm version:packages
pnpm install
pnpm verify:packages
```

`.changeset` 保存版本变更意图，需要提交 Git。版本生成和依赖解析分别执行，避免手工修改锁文件

`verify:packages` 先在 `dist/packs` 生成各能力包的 tarball，再由 [交付集成测试](../tests/packages/verify-packages.mjs) 检查入口、类型、资源、映射源码与依赖版本，并安装到仓库外临时目录验证公开 API 和安装边界

尚未发布的同批内部依赖通过验收项目的 pnpm overrides 指向对应 tarball；发布内容本身必须保存正常版本声明，不能依赖 workspace 协议、仓库路径或 qygent 源码。验收临时目录保留供诊断，测试不读取用户模型配置、不调用真实模型服务

发布 npm 需要独立授权。CI 执行交付验证，不上传或发布包

## 持续集成

旧 qygent 仓库没有 GitHub Actions 工作流；[CI 工作流](../.github/workflows/ci.yml) 是针对独立框架新增的验收入口

工作流在 push、pull request 和手动触发时运行，在 Ubuntu 与 macOS 上使用相同的 Node.js 24、pnpm 11 和冻结锁文件，覆盖构建、类型、包级测试、ESLint、拼写、SQLite 迁移及仓库外安装验收。pull request 额外检查提交信息

工作流通过 [setup-node](https://github.com/actions/setup-node) 读取 `.node-version`，通过 [pnpm/action-setup](https://github.com/pnpm/action-setup) 读取 `packageManager` 并缓存 pnpm store。两步独立安装 Node.js 与 pnpm，不把依赖缓存当作 `node_modules` 或交付产物

Git Hooks、Turbo 缓存和 CI 各自承担提交检查、任务调度和完整交付验证。核心重构仍需按命名与出口、依赖与所有权、完整生命周期分三轮复查
