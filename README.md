# elmino

elmino 是面向应用开发的可复用 Agent 框架，首阶段聚焦模型适配与 Agent 内核

当前已落地模型公共协议与两个独立适配器包，Agent 内核尚待迁入，qygent 暂时继续使用原实现

## 首阶段边界

| 包 | 目录与状态 | 职责 |
| --- | --- | --- |
| `@elmino/llm` | [packages/llm](packages/llm) | 统一请求、消息、流事件、工具调用、用量、结构化解析和 Provider 契约 |
| `@elmino/llm-openai` | [packages/llm-openai](packages/llm-openai) | OpenAI SDK 及 Chat Completions、Responses 和兼容服务差异 |
| `@elmino/llm-anthropic` | [packages/llm-anthropic](packages/llm-anthropic) | Anthropic SDK 及 Messages 和兼容服务差异 |
| `@elmino/core` | 待迁入 | Agent 装配，以及 Thread、Turn、Step、工具执行、插件和中断恢复的生命周期 |

模型适配层独立于执行内核。Provider 包依赖 `llm` 契约和各自 SDK，`llm` 与 `core` 不依赖具体 Provider 包。执行内核通过宿主注入模型、存储、运行环境和事件处理能力

产品身份、账号、模型目录管理、内置产品插件、HTTP 服务、客户端 SDK 与 UI 由应用或后续阶段承载

只为实际能力创建包目录；`core` 尚未创建，不用空实现占位

## npm 包组织与交付

仓库使用 pnpm monorepo，每个公开能力包拥有自己的 `package.json`、版本、构建脚本和公开入口。根项目负责开发组织，保持 `private: true`；实际发布的是 `@elmino/*` 能力包

独立包隔离安装依赖和发布边界；包内需要细分 API 时，通过明确的 `exports` 子路径提供。消费方按需要安装包，再从包根或已声明的子路径导入

- 产物使用 ESM JavaScript 和 TypeScript 类型声明，公开入口指向 `dist` 中的实际文件
- `tsconfig.base.json` 维护检查规则，`tsconfig.build.base.json` 提供产物配置；各包声明自身 `rootDir`、`outDir` 与源码范围
- 各包使用 `files` 白名单交付 `dist` 与映射所需的 `src`，不包含测试、开发配置或本地环境文件；公开入口始终指向编译产物
- workspace 依赖在打包时转换为发布版本范围，产物不依赖仓库别名、源码目录或本地路径
- 模型适配器按 SDK 依赖独立交付，安装 OpenAI 适配器时无需安装 Anthropic SDK
- 已接入 Changesets，首批三个包的 minor 变更记录在 `.changeset`；当前开发版本为 `0.0.0`，尚未发布到 npm

`pnpm verify:packages` 为三个包生成 tarball，检查公开入口、类型声明、映射源码和依赖版本，再分别安装到仓库外临时目录，执行类型检查、SDK 请求投影和依赖隔离检查。尚未发布的 `@elmino/llm` 由消费项目的 pnpm overrides 指向同批 tarball，打包文件中的正常版本声明保持不变。临时目录保留供失败诊断，不读取用户模型配置，不调用真实模型服务

tarball 输出到 `dist/packs`，根项目不参与打包。qygent 的接入与旧实现删除作为后续独立批次执行

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

根脚本提供实际包的构建、检查与交付验证：

```sh
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm verify:packages
```

测试从公开入口消费构建产物；定向运行包级测试前先执行 `pnpm build`。日常只检查修改文件，完整检查用于交付前或用户明确要求的场景

使用 `pnpm changeset` 记录后续变更，`pnpm version:packages` 生成正式版本与变更日志并更新内部依赖，之后执行 `pnpm install` 更新锁文件。发布动作单独授权

## 模型包使用

从 OpenAI 包根导入两类适配器，或只引用需要的公开子路径；安装 Anthropic 包时不依赖 OpenAI SDK

```ts
import { ResponsesProvider } from '@elmino/llm-openai/responses'

const provider = ResponsesProvider.create({
  model: 'your-model',
  credential: process.env.MODEL_API_KEY,
})
const result = await provider.generate({
  system: [{ type: 'text', text: '用中文回答' }],
  messages: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }],
  maxOutputTokens: 1024,
})
```

Chat Completions 使用 `@elmino/llm-openai/chat-completions` 的 `ChatCompletionsProvider`；Anthropic 使用 `@elmino/llm-anthropic` 的 `AnthropicMessagesProvider`，三者共用 `Request`、`Result` 和 `Event` 契约

公共协议按 `message`、`request`、`stream`、`usage`、`object`、`cache`、`provider` 和 `adapter` 提供子路径。`baseURL` 指定兼容服务地址，`providerName` 选择厂商差异；免认证接口设置 `apiKeyRequired: false`，不发送保存的凭据。适配器实例保存自身配置，Responses 续接状态属于该实例，建议按会话或 Turn 创建实例

## 迁移顺序

1. **P0 仓库初始化**：建立本地仓库、开发工具和职责边界
2. **P1 模型适配**：从 qygent 提取 `llm` 契约和独立 Provider 包，消除产品依赖，验证构建、打包、仓库外安装与类型消费
3. **P2 Agent 内核**：保留现有执行语义，提取生命周期及必要契约，验证工具执行、审批、中断、恢复和子智能体路径，并验证内核发布产物

每个批次完成后分别验证；qygent 在对应能力可独立消费后切换依赖并删除旧实现

开发约定见 [AGENTS.md](AGENTS.md)
