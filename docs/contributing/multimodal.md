# 多模态与供应商规范

本文件由根 [AGENTS.md](../../AGENTS.md) 按能力加载，维护模型能力、附件输入、Provider 映射和持久化边界。请求校验与 JSON 传输约定同时遵守[请求与事件协议](../transport.md)

## 能力与包归属

- `@elmino/llm` 持有统一消息、请求、流式事件、用量和模型配置契约；`@elmino/llm-openai` 实现 Chat Completions / Responses，`@elmino/llm-anthropic` 实现 Anthropic Messages。原生 SDK 类型、字段差异、认证和请求转换留在对应适配器
- 模型接入按具体模型和协议确认能力，不按 Provider 名称推断其全部型号支持图片、思考、工具、缓存或原生 JSON Schema。修改供应商策略前重新核对官方文档，现有适配分支和旧资料不替代当前能力证据
- 可持久化配置以 [ModelTurnConfig](../../packages/llm/src/provider/model.ts) 为准：`apiFormat` 目前只有 `anthropic-messages`、`chat-completions`、`responses`；`inputModalities` 目前只声明额外的 `image`，文本输入默认存在
- `ModelTurnConfig` 不保存密钥、认证 Header、原生客户端或可执行对象。Turn 保存非敏感配置快照，恢复时由宿主按原快照重新装配模型，不读取新的默认配置来覆盖已冻结的执行语义
- 框架没有产品模型目录、价格表或账号级模型设置。规格和默认模型由宿主配置，不在规范中另行维护型号名单、价格、上下文大小和供应商上传限额
- 当前公共接口不声明原生视频、音频生成或图片生成能力；不得因原生 SDK 存在相应类型就声称框架已接入

## 统一消息与工具身份

- 消息和片段以 [llm 消息类型](../../packages/llm/src/message/types.ts) 为准，完整响应保留 Provider 原始片段顺序。适配器负责映射统一角色、结束原因、用量、工具调用和推理片段，不把供应商响应直接传给 Engine、Store 或 SDK
- 内部工具调用统一使用 `args: Record<string, unknown>`；Anthropic `input`、Chat Completions `function.arguments`、Responses `arguments` 等原生字段只在适配器边界转换，不将其传播成另一套公共参数结构
- Provider 原生工具调用 ID 原样保存在 `ToolCallPart.id`，工具结果通过 `callId` 引用，审批通过同一个 `callId` 匹配。不能对这些 ID 套用框架 UUID 格式或在回放时重新生成；Thread、Turn、Message 等框架自身身份仍按领域规则生成与校验
- 流式工具参数草稿使用 `argsText`，最终参数不是合法 JSON 对象时保留 `invalidArgs`。不得把解析失败静默当作成功的空对象，也不能在参数尚未结束时执行工具。统一解析入口见 [llm 适配辅助函数](../../packages/llm/src/adapter/message.ts)
- 原生 `metadata` 仅用于 Provider 诊断和协议回放所需信息，不能成为保存文件名、附件引用、工具执行状态或用户展示事实的私有旁路
- 工具输出区分 Provider 消费的 `result` 和本地 transcript 的 `output`。跨协议转换或多模态工具结果处理不得从展示文本反向重建原始结果

## 远程附件输入与宿主预处理

- HTTP 新 Turn 使用 `input: ThreadInputContent[]`，至少包含一项输入；高层 `run` 接受的字符串由框架转换为文本输入。字段以 [ThreadInputContent](../../packages/thread/src/input/types.ts) 和 [API 输入 Schema](../../packages/api/src/turn/schema.ts) 为准，不沿用老项目的 `content` 字段或旧 `message` 字段
- 远程输入联合目前包含 `text`、`mention`、`image`、`document`。`mention` 只提供引用结构，其资源解析归宿主；存在 `pluginId` 字段不表示框架已迁入插件系统、资源市场或引用 UI
- 图片和文档 `data` 必须是不含 Data URL 前缀的标准 Base64。远程图片 MIME 只接受 JPEG、PNG、GIF、WebP；文件名、扩展名和 `compress` 也是输入的一部分。不要把底层 `llm.ImagePart` 更宽的 URL / Data URL 类型当作 HTTP 上传能力
- 严格结构校验位于 HTTP、文件持久化等外部入口，内部 Engine / Loop 调用复用已校验领域类型，避免每层重复解析同一份输入。消息正文不自动裁剪空白；配置字段需要归一化时在所属入口明确处理
- MIME 声明、Base64 语法和文件内容识别属于不同校验。宿主接收不可信附件时应在预处理入口检查真实内容、限制资源消耗，并按部署及具体模型要求设置大小、数量和超时边界；当前 API Schema 没有统一的附件总字节数或图片数量上限
- `ElminoOptions.prepareInput` 是附件预处理边界，接收公共输入并返回 [TurnInputPart](../../packages/engine/src/turn/input.ts)。需要图片压缩、文档解析、资源引用展开时由宿主实现，不把文件解析器、压缩库或产品策略写入 `llm` 与 Provider
- 当前 Core 默认直接传递文本、引用和图片，不执行图片压缩；`compress` 表示调用者允许宿主压缩，不保证默认实现会处理。未提供 `prepareInput` 时文档输入明确报错，见 [Core 执行装配](../../packages/core/src/elmino/elmino.ts)
- 文档在远程 API 中是待解析附件；交给 Engine 时必须已转换为 `artifactId` 与 `modelText`。宿主负责保留解析全文，并构造首段文本与续读说明。文档不加入 `inputModalities`，不得把适配器底层 `DocumentPart` 能力等同于框架已支持任意 PDF、Office 或其他格式解析

## 持久化与 Provider 投影

- 同一份预处理输入先建立结构化 transcript，再派生标准 Provider 用户消息；实现见 [Engine 输入持久化与转换](../../packages/engine/src/engine/execution.ts)。Runtime 展示事实和 Canonical 模型上下文各自保留所属数据，不从一次供应商请求反推原始附件
- 图片 transcript 保留名称、MIME 和可展示内容；文档 transcript 保留名称、扩展名和 artifact 身份，模型消息使用宿主准备的 `modelText`；引用模型投影和资源展开策略以实际宿主实现为准，不能把引用标签当成已读取资源全文
- Canonical 消息用于恢复模型上下文，transcript 用于跨端展示。保存 Provider 必需的签名、工具关系和推理上下文时，不得破坏原始关联或把仅供模型回放的数据误投影给用户
- 内容存储归 RuntimeStore / BlobStore；数据库记录与内容 blob 的写入不是同一个事务。文档处理失败、事务回滚及附件清理遵守所属 Store 的引用与所有权边界，不删除宿主配置、源码或其他长期资产
- 新增预处理或清理能力时补充失败、恢复和重新读取验证，不仅验证一次 HTTP 请求能完成。不要在本规范中宣布尚未实现的格式白名单、压缩参数、分页规则或自动清理流程

## 思考与结构化输出

- 只输出模型实际提供且允许展示的 `reasoning`，不生成替代思考、不把普通正文任意标记成推理、不承诺供应商一定返回可见思考
- `ReasoningPart.signature` 和 Provider 元信息可能是多轮调用必需的上下文。`visibility: 'context-only'` 内容用于回放，不能作为普通 transcript 或 SDK 可见思考打印；原生加密、签名和隐藏内容不能为了展示而展开
- 供应商的 thinking、reasoning、缓存和工具 Schema 差异只在所属适配器策略中处理。修改策略需同时核对非流式、流式、历史回放、工具调用及结构化输出，不能只修正首个请求
- 原生 JSON Schema 能力由模型配置与适配器能力明确声明。即使服务返回 JSON，仍使用调用方 Schema 校验，不能把 `JSON.parse` 成功视为领域结构已合法
- 统一结构化解析使用 [parseObject](../../packages/llm/src/object/parse.ts)，兼容已实现的 JSON 文本提取并保留 `ObjectParseError` 中的完整模型响应与用量事实。新增 Provider 不复制另一套解析器，也不因解析失败丢掉已完成的模型执行记录
- 运行事件和扩展 JSON 的可传输值遵守[请求与事件协议](../transport.md#运行事件与-json)：不能依靠 JSON 序列化静默吞掉循环引用、函数、非有限数字或其他不支持值

## 验证与资料使用

- 修改公共消息或输入类型时，检查 API Schema、Provider 映射、Engine 持久化、事件投影与 SDK 消费者，使用真实公开包入口验证受影响调用链
- Provider 变更使用确定性响应和事件夹具覆盖工具原生 ID、参数草稿、错误参数、流式与非流式结果一致性、思考回放及模型不支持的能力；相关测试归 [llm](../../packages/llm/tests)、[llm-openai](../../packages/llm-openai/tests)、[llm-anthropic](../../packages/llm-anthropic/tests)，不调用真实模型或读取本地凭据
- 老项目的图片压缩参数、图片与文档解析库装配、文档格式白名单、读取分页、Sender 草稿和 Dashboard 模型目录均未作为框架默认能力迁入。后续接入时按真实宿主消费与测试建立边界，再同步规范
- 外部模型文档和参考项目会变化；本次迁移仅根据本地契约与实现核对边界，未重新核验供应商规格。旧资料链接只能作为后续查证入口，不能作为当前能力或限制的结论
