/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者验证真实 HTTP 端口 */
import { Client } from '@elmino/sdk'
import { defineServer } from '@elmino/server'

/** 仓库外验收只读取交付需要的 OpenAPI 字段 */
interface ApiSpecification {
  /** OpenAPI 文档版本 */
  openapi?: string
  /** 宿主配置的静态说明 */
  info?: { title?: string, version?: string }
  /** REST 路径的公共挂载前缀 */
  servers?: { url: string }[]
  /** 本次验收需要确认存在的 GET operation */
  paths?: Record<string, { get?: {
    /** 生成的操作身份 */
    operationId?: string
    /** 当前操作覆盖的认证要求 */
    security?: Record<string, unknown>[]
  } }>
  /** 文档生成的安全方案 */
  components?: { securitySchemes?: Record<string, { type?: string, scheme?: string }> }
  /** 所有业务操作继承的认证要求 */
  security?: Record<string, unknown>[]
}

const server = defineServer({
  agents: {},
  apiReference: { title: 'Packaged Agent API', version: '1.2.3' },
  apiKey: 'fake-consumer-key',
  workspace: () => { throw new Error('健康检查不应打开工作区') },
  model: () => { throw new Error('健康检查不应装配模型') },
})
const url = await server.start({ port: 0, shutdownSignals: false })
try {
  const reference = await fetch(`${url}/api/docs`)
  const html = await reference.text()
  if (reference.status !== 200 || !reference.headers.get('content-type')?.includes('text/html')
    || !html.includes('Scalar.createApiReference') || !html.includes('Packaged Agent API')) {
    throw new Error('打包后的 Server 未交付可直接访问的 Scalar 文档')
  }
  const definition = await fetch(`${url}/api/spec.json`)
  const definitionText = await definition.text()
  if (definition.status !== 200 || !definition.headers.get('content-type')?.includes('application/json'))
    throw new Error('打包后的 Server 未交付可直接访问的 OpenAPI 定义')
  const specification = JSON.parse(definitionText) as ApiSpecification
  if (!specification.openapi?.startsWith('3.') || specification.info?.title !== 'Packaged Agent API'
    || specification.info.version !== '1.2.3' || definitionText.includes('fake-consumer-key')) {
    throw new Error('OpenAPI 定义未保留静态配置，或错误包含了运行凭据')
  }
  const bearer = Object.entries(specification.components?.securitySchemes ?? {})
    .find(([, scheme]) => scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer')?.[0]
  const basePath = specification.servers?.[0]?.url.replace(/\/$/u, '') ?? ''
  const health = Object.entries(specification.paths ?? {}).find(([pathname, methods]) => (
    new URL(`${basePath}${pathname}`, url).pathname === '/api/health' && methods.get !== undefined
  ))?.[1].get
  const security = health?.security ?? specification.security ?? []
  if (!bearer || !health?.operationId || !security.some(requirement => Object.hasOwn(requirement, bearer)))
    throw new Error('OpenAPI 定义缺少真实健康检查 operation 或 Bearer 认证要求')
  if ((await fetch(`${url}/api/health`)).status !== 401)
    throw new Error('REST 健康检查绕过了宿主鉴权')
  const rest = await fetch(`${url}/api/health`, {
    headers: { authorization: 'Bearer fake-consumer-key' },
  })
  if (rest.status !== 200 || (await rest.json() as { status?: string }).status !== 'ok')
    throw new Error('打包后的 REST 健康检查未使用正确路径或凭据')
  const client = Client.create({ baseUrl: url, apiKey: 'fake-consumer-key' })
  if ((await client.rpc.meta.health({})).status !== 'ok')
    throw new Error('打包后的 Server 无法通过真实 SDK 健康检查')
  let denied = false
  try {
    await Client.create({ baseUrl: url }).rpc.meta.health({})
  }
  catch (error) {
    denied = typeof error === 'object' && error !== null && 'status' in error && error.status === 401
  }
  if (!denied)
    throw new Error('真实网络请求绕过了宿主鉴权')
  await server.close()
  const response = await server.fetch(new Request(`${url}/api/health`))
  if (response.status !== 503)
    throw new Error('关闭后的 Fetch 服务仍接受请求')
  let disconnected = false
  try {
    await fetch(`${url}/api/health`)
  }
  catch {
    disconnected = true
  }
  if (!disconnected)
    throw new Error('统一关闭后 HTTP 端口仍然开放')
}
finally {
  await server.close()
}
