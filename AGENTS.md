<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# AGENTS.md

<!-- cspell:ignore diaoyan -->

## 必读规范

以下文档承接从本文件迁出的详细规范，与本文件具有同等约束力，并非可选参考。
修改相关领域前必须读取对应文档；共同约束只维护一份，不在能力包或示例目录重复复制。

| 任务范围 | 必须读取 |
| --- | --- |
| 环境配置、开发命令、测试运行与 npm 交付 | [开发指南](docs/contributing.md) |
| 任意源码、配置或测试修改 | [代码、注释、目录与检查规范](docs/contributing/code.md) |
| Agent 执行、线程状态、持久化、事件或 SDK 控制 | [Agent 架构约定](docs/contributing/agent.md) |
| 附件、模型能力或 Provider 输入输出 | [多模态与供应商规范](docs/contributing/multimodal.md) |

共用代码依据实际消费方提取；运行时、持久化和网络接入规则依据所使用的能力加载，不按示例名称新增分支或例外。

## 回复语言

- 默认使用中文回复

## 界面文案

- 用户界面的标题、按钮、说明、提示等文案结尾不写标点符号
- 面向用户的标题、说明、状态、错误和操作文案优先描述用户目标、可获得的能力、实际影响和下一步操作，尽量不暴露内部实现细节
- 除非诊断问题、安全确认或高级配置确有必要，不在用户文案中直接使用进程、PATH、注册表、RPC、数据库、轮询、协议、内部工具或内部目录结构等实现概念
- 必须说明技术边界时，将实现约束转换成用户可理解的结果，不要求使用者先理解框架内部结构

## Git 提交日志

- 提交格式遵守 conventional commits，例如 `feat: 中文描述`、`fix: 中文描述`；
  type/scope 用英文约定，冒号后的主题默认中文
- 提交前不手工执行 `eslint --fix`、`pnpm lint --fix` 或同义自动修复命令；`.husky/pre-commit`
  由 `lint-staged` 对已暂存的 JavaScript / TypeScript 文件执行 `eslint --cache --fix`，不使用 `--no-verify` 绕过 Hook
- 默认保持未提交，用户 Review 后明确要求才提交，计划中的提交步骤不视为最终提交授权
- 未经用户明确要求，不 amend、rebase、reset 或改写已有提交；不自行创建远程、推送或发布 npm 包
- 同一文件同时存在已暂存与未暂存改动时，提交前分别核对 index 和工作区；`lint-staged`
  会临时隐藏未暂存内容，提交后必须确认这些内容已恢复，不能把无关改动带入提交或造成丢失

## 项目环境与命令

- 当前仓库使用 Node.js 24 与 pnpm 11 workspace，依赖版本统一由根 workspace catalog 维护，同名直接依赖优先保持一致；工程命令从根目录 `package.json` 执行，
  不新增 `npm`、`yarn` 相关锁文件或脚本说明
- 不手工修改 pnpm 锁文件；依赖声明变化后从根目录执行 `pnpm install` 更新解析结果
- 工作区结构、环境与命令统一见[开发指南](docs/contributing.md)，跨 Workspace 从包入口导入
- 根 `tsconfig.base.json` 维护公共编译策略，`tsconfig.build.base.json` 维护产物配置；各包薄继承，不复制整套配置或用源码路径别名绕过 workspace 边界
- TypeScript 相对导入省略后缀；JavaScript 与类型声明产物由公共 tsdown 配置补齐 `.js`，仓库外消费者继续按严格 NodeNext 验收
- 创建独立 Git 工作区后，默认将主工作区中被 Git 忽略的本地环境文件按原相对路径同步过去，校验内容一致且目标仍被 Git 忽略；
  不输出敏感内容，不将这些文件加入提交
- 环境文件由各运行入口加载，框架模块不自动查找 `.env`；框架环境变量使用 `ELMINO_` 前缀，供应商已有前缀保持原样，显式配置优先于环境值
- Codex / OpenCode 调研源码默认位于当前仓库父目录下的 `diaoyan/codex` 和 `diaoyan/opencode`；
  如果目录不存在，先把对应项目源码 clone 到上述位置再继续调研
- Codex 公开源码不包含桌面 App 的 UI 与 Electron / macOS 窗口宿主实现；桌面交互只能作为实机产品参考，
  不把观察到的 UI 行为表述成 Codex 源码结论，也不从缺失源码猜测其窗口生命周期实现
- 启动本地服务前若端口已有占用，先确认现有进程用途，再选择新的端口或复用现有服务，不直接结束未知进程

## 架构演进原则

- 调整 Agent 执行机制前，先调研 `diaoyan/opencode` 与 `diaoyan/codex` 的当前源码，
  以源码中的真实边界和生命周期语义为主要设计依据，再结合当前包依赖落地；历史经验只能辅助理解，
  不能替代源码证据，不根据记忆猜测接口、状态或执行流程
- 修复 Bug 必须定位设计源头或生命周期根因；现有架构无法支撑目标时直接重构，删除重复执行器、
  无效封装、旧兼容和残留分支，不通过新增 helper、兜底状态或旁路数据结构叠加补丁，整体代码量应尽量持平或减少
- 当前开发阶段以架构干净、职责单一和总代码量降低为最高优先级；当用户体验与核心结构冲突且无法
  低成本兼顾时，允许暂时简化部分体验，不为保留体验引入错误抽象和冗余状态
- 每轮功能完成后必须检查重复实现、无效封装、残留分支、薄转发层和可删除代码，发现后在本轮直接清理
- 积极与用户和开发者沟通：能从源码、配置和测试确认的事实先主动探索；发现更优方案时主动说明收益、
  代价和影响范围；涉及产品意图、架构取舍或高影响决策且无法从仓库确定时，及时询问用户并共同探索，
  不静默猜测或擅自切换到实质不同的实现
- 当前项目处于未发布开发阶段，内部架构变更默认不保留兼容：旧包导出、旧类型、旧状态字段和旧调用入口
  直接删除并同步全部调用方与测试；除非用户明确要求，不新增 deprecated 别名、适配层或迁移分支
- 用户长期资产不适用内部非兼容政策，结构变化必须通过迁移保留旧数据；不恢复手写 baseline、
  Schema 不一致自动清库或重置迁移记录等机制，Drizzle Kit 无法安全表达的数据转换先重新设计；
  用户明确允许舍弃的数据按约定范围重建，具体规则见[数据兼容与迁移](docs/contributing/code.md#数据兼容与迁移)
- 系统生成的 opaque ID 统一通过 `@elmino/shared` 的 `createId(prefix)` 生成，格式为 `<prefix>_<UUID v4>`；
  协议层按领域导出校验规则，严格校验只放在 HTTP、配置、SSE、LLM 工具输入和文件持久化入口，
  不在 Server 到 Agent、Loop、Store 的内部调用链重复校验。Provider 原生工具调用 ID、宿主语义键和确定性派生的片段 ID 不机械改成 UUID
- 日常开发阶段只对本轮修改文件执行不带 `--fix` 的 ESLint 检查，并只运行与改动直接相关的测试文件；
  创建 commit 前不额外重复执行 ESLint 或全仓检查，提交阶段由 `.husky/pre-commit` 对已暂存文件自动修复
- 只有准备 push、合并或创建 PR，或用户明确要求时，才执行全仓 `pnpm lint`、`pnpm test`；
  `pnpm typecheck` 按公共类型、包出口和调用链的实际影响范围决定是否执行
- 注释、类型和目录规范以[代码规范](docs/contributing/code.md)为准；已有检查使用 ESLint Harness、ESLint 内置规则及第三方插件，
  函数与变量职责说明、复杂流程步骤和可读性仍需人工审查，不把规范全部描述成已有自动检查
- 包内能力测试归所属包 `tests`；有实际测试才声明包级测试命令，不为每个包生成空配置
- 可复用测试夹具跟随能力归属；跨领域夹具放所属 `tests/support`，单领域 helper 留在该领域，生产包不反向依赖测试代码
- 单个 `*.test.ts[x]` 不得超过 2000 行，包含注释与空行；超出时按行为和生命周期边界拆分并提取领域 support，
  禁止使用 `part-1`、`part-2` 这类无语义文件名，也不要复制整套 fixture 只为降低单文件行数
- 默认不启动或连接浏览器工具做页面验证；只有用户在当前任务中明确要求浏览器验证时才执行，
  不能因为以前的任务使用过浏览器，或当前改动涉及前端交互，就自行增加浏览器验证
- 重大架构调整或核心重构完成后必须至少进行三轮职责独立的复查：第一轮检查命名、文件名、目录、
  出口、Schema、SQL、测试和文案残留；第二轮检查包依赖、Context 所有权、重复能力、一次性 helper/class、
  薄转发层和空源码目录；第三轮按 Server、AgentEngine、Turn、Step、Tool、Store、Event、SDK 的完整
  链路检查中断、恢复、重启、重关联、子智能体和失败路径。每轮发现问题后先修复并重跑该轮，三轮均无新问题才算完成

## 安全边界

- `.env`、`.env.local` 等本地环境文件被 `.gitignore` 忽略，说明配置时只引用 `.env.example`；
  不把真实模型 API Key、`ELMINO_SERVER_KEY` 等密钥写进文档、提交信息或回复
- 清理运行数据、缓存、临时目录前必须先确认 `pwd`、目标绝对路径和目录内容，不能凭变量名或记忆直接删除
- 不使用宽泛的 `rm -rf` 清理数据；必须删除时只删除明确的叶子目录或文件，并优先先用 `ls` / `find` 展示目标
- `.elmino` 等运行数据目录和项目源码目录必须严格区分；清理运行数据不能触碰 `packages`、`examples`、
  `tests`、README、配置文件或其他源码内容
- 宿主的账号、认证、模型配置、工作区目录和其他长期资产不属于框架运行缓存，不能随 RuntimeStore 清理或示例重建一起删除
- 删除用户目录、项目目录、工作区根目录、`.elmino`、`examples`、`packages` 等高风险路径前，
  必须先向用户确认，不能把“清理数据”扩大成删除代码或工作区
- 涉及删除、迁移、重命名目录时，先说明目标路径和影响范围，再执行最小范围命令

## 检查入口

- 所有工作区统一使用 catalog 中的 TypeScript，通过根 `pnpm typecheck` 或所属包命令检查，不自行安装另一套编译器
- 修改公开类型、包出口和编译配置时覆盖受影响调用链；文档-only 修改检查相对链接与 `git diff --check`
- 测试不得修改 `HOME`；用户目录通过参数注入临时根目录。其他环境变量变更保存原值并在退出时恢复；外部服务或配置缺失应记录原因，不能弱化断言
- 包级交付必须覆盖构建、tarball 内容、仓库外安装、公开入口运行、严格类型检查与依赖隔离，不能只验证 workspace 源码导入
- 跨端能力同时验证浏览器条件编译与打包，不引入 Node 专属依赖或隐式 polyfill；这是交付检查，不启动浏览器页面
- 构建会重建 `dist`，不得与依赖同一产物的测试、类型检查或打包并发执行；按依赖顺序完成检查

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## 工作区与能力归属

- elmino 是可复用的 Agent 开发框架；能力包位于 `packages/<能力>`，对外使用 `@elmino/*`。当前范围是模型、Agent 执行、持久化、Server 与纯客户端 SDK，产品账号、市场、插件体系和 UI 按后续明确需求另行接入
- 通用纯工具使用 `@elmino/shared`，Node 工具使用 `@elmino/shared/node`，本机环境能力使用 `@elmino/local`；领域类型和状态归实际能力所有者，不整包复制旧产品的 shared 或 SDK
- 模型协议、执行、存储和网络接入按[Agent 架构约定](docs/contributing/agent.md)保持单一所有者；模型适配器、数据库和 Sandbox 实现通过所属契约接入，核心不反向依赖宿主应用
- 根目录不依赖内部业务包，依赖由消费它的工作区声明；公开包独立维护直接依赖、版本、`exports`、产物白名单与发布配置，根项目和示例保持私有
- 跨包通过公开入口导入；基础契约与浏览器入口不加载具体数据库、本机运行环境或供应商实现，可选能力不进入基础包的安装依赖链
- 示例位于 `examples/<分类>/<场景>`：Tutorial 按学习顺序编号，Reference 按能力独立查阅，Integration 用于真实第三方接入；`src/index.ts` 只负责启动和入口错误处理
- 说明文档统一归根 `docs`，不在包与示例中复制开发规范；根 README 负责导航，开发环境与命令归[开发指南](docs/contributing.md)，详细约束归本文件列出的必读规范
- 根交付测试按 `tests/<能力>/consumer.ts` 组织，入口归 `tests/runner`，跨领域辅助代码归 `tests/support`；消费程序使用真实 TypeScript 文件，不通过字符串生成源码
- Changesets 记录公开行为与类型变化，`.changeset` 随 Git 保存；开发时使用 workspace 协议，打包后必须转换为正常版本范围，不把仓库路径或未发布的本地链接交给消费者
