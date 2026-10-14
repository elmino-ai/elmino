# elmino

elmino 是面向应用开发的可复用 Agent 框架，首阶段聚焦模型适配与 Agent 内核

当前已初始化本地 Git 仓库、pnpm workspace 和开发配置，尚未迁入框架实现

## 首阶段边界

| 计划包 | 职责 |
| --- | --- |
| `@elmino/llm` | 统一模型请求、消息、流事件、工具调用、用量和 Provider 契约 |
| `@elmino/core` | Agent 装配，以及 Thread、Turn、Step、工具执行、插件和中断恢复的生命周期 |
| `@elmino/provider-openai` | OpenAI SDK 及 Chat Completions、Responses 适配 |
| `@elmino/provider-anthropic` | Anthropic SDK 及 Messages 适配 |

模型适配层独立于执行内核。Provider 包依赖 `llm` 契约和各自 SDK，`llm` 与 `core` 不依赖具体 Provider 包。执行内核通过宿主注入模型、存储、运行环境和事件处理能力

产品身份、账号、模型目录管理、内置产品插件、HTTP 服务、客户端 SDK 与 UI 由应用或后续阶段承载

上述包名和职责是迁移目标；出现真实实现后再创建对应包目录与公开入口

## npm 包组织与交付

仓库使用 pnpm monorepo，每个公开能力包拥有自己的 `package.json`、版本、构建脚本和公开入口。根项目负责开发组织，保持 `private: true`；实际发布的是 `@elmino/*` 能力包

独立包隔离安装依赖和发布边界；包内需要细分 API 时，通过明确的 `exports` 子路径提供。消费方按需要安装包，再从包根或已声明的子路径导入

- 产物使用 ESM JavaScript 和 TypeScript 类型声明，公开入口指向 `dist` 中的实际文件
- `tsconfig.base.json` 维护检查规则，`tsconfig.build.base.json` 提供产物配置；各包声明自身 `rootDir`、`outDir` 与源码范围
- 各包使用 `files` 白名单交付产物和必要资源，保持真实依赖声明，不把其他公开包的整份实现复制或内嵌到产物中
- workspace 依赖在打包时转换为发布版本范围，产物不依赖仓库别名、源码目录或本地路径
- 模型适配器按 SDK 依赖独立交付，安装 OpenAI 适配器时无需安装 Anthropic SDK
- 第一批真实包落地时接入 Changesets，记录每个包的变更并更新受影响依赖的版本

每个包的验收顺序为：构建并检查类型、生成 tarball 并检查文件清单、在仓库外安装 tarball、验证公开入口及跨包依赖。首阶段同步补齐这些能力，再由 qygent 消费发布产物

组织方式参考 [Mastra workspace](https://github.com/mastra-ai/mastra/blob/main/pnpm-workspace.yaml)、[Core 的公开入口与产物清单](https://github.com/mastra-ai/mastra/blob/main/packages/core/package.json)、[LibSQL 独立包](https://github.com/mastra-ai/mastra/blob/main/stores/libsql/package.json) 和 [Changesets 配置](https://github.com/mastra-ai/mastra/blob/main/.changeset/config.json)。Mastra 同时使用独立包与包内子路径，并对部分紧密关联的包设置同步版本组；elmino 按实际依赖划分发布边界

## 开发环境

- Node.js 24.18.1
- pnpm 11.18.0
- TypeScript 6.0.3
- ESM，运行时使用标准 Node.js 模块解析

在仓库根目录安装依赖：

```sh
pnpm install
```

根脚本提供 ESLint 检查：

```sh
pnpm lint
```

类型检查、构建、测试和使用示例随实际能力包落地，不用空实现模拟框架能力

## 迁移顺序

1. **P0 仓库初始化**：建立本地仓库、开发工具和职责边界
2. **P1 模型适配**：从 qygent 提取 `llm` 契约和独立 Provider 包，消除产品依赖，验证构建、打包、仓库外安装与类型消费
3. **P2 Agent 内核**：保留现有执行语义，提取生命周期及必要契约，验证工具执行、审批、中断、恢复和子智能体路径，并验证内核发布产物

每个批次完成后分别验证；qygent 在对应能力可独立消费后切换依赖并删除旧实现

开发约定见 [AGENTS.md](AGENTS.md)
