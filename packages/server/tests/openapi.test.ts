import type { ThreadState } from '@elmino/thread'
import type { ServerAuthorization } from '../src/index'
import { parseRuntimeEventCursor } from '@elmino/protocol'
import { isPlainRecord } from '@elmino/shared'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createModel, response } from '../../engine/tests/support/model'
import { AgentServer } from '../src/index'
import { createServerHarness, threadTarget } from './support/server'

/** 沿文档内部引用检查真实领域 Schema，不绑定生成器的组件命名 */
function resolveSchema(document: unknown, value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value))
    throw new Error('文档缺少结构化 Schema')
  if (typeof value.$ref !== 'string')
    return value
  if (!value.$ref.startsWith('#/'))
    throw new Error('验收需要可独立读取的文档内部引用')
  let resolved: unknown = document
  for (const key of value.$ref.slice(2).split('/')) {
    if (!isPlainRecord(resolved))
      throw new Error(`Schema 引用无法解析：${value.$ref}`)
    resolved = resolved[key.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return resolveSchema(document, resolved)
}

/** Fetch 测试走完整 HTTP handler，查询编码与正文保持真实客户端形状 */
function apiRequest(path: string, init?: RequestInit) {
  return new Request(`https://elmino.test/api${path}`, init)
}

/** 只读取本次需要的 SSE 帧，后续由每个测试明确取消 reader */
async function readUntil(reader: ReadableStreamDefaultReader<string>, marker: string) {
  let text = ''
  while (!text.includes(marker)) {
    const next = await reader.read()
    if (next.done)
      throw new Error(`事件流提前结束，未收到 ${marker}`)
    text += next.value
  }
  return text
}

test('公开 Scalar 与完整 OpenAPI 文档不进入鉴权，不包含宿主凭据，关闭后拒绝读取', async () => {
  const key = 'fake-openapi-private-key'
  const authorize = vi.fn(({ request }: ServerAuthorization) => request.headers.get('authorization') === `Bearer ${key}`)
  const harness = await createServerHarness({ authorize })
  const docs = await harness.server.fetch(apiRequest('/docs'))
  expect(docs.status).toBe(200)
  expect(docs.headers.get('content-type')).toContain('text/html')
  const html = await docs.text()
  expect(html).toContain('Scalar.createApiReference')
  expect(html).not.toContain(key)

  const result = await harness.server.fetch(apiRequest('/spec.json'))
  expect(result.status).toBe(200)
  const document: unknown = await result.json()
  const spec = resolveSchema(document, document)
  expect(spec.openapi).toMatch(/^3\./)
  expect(JSON.stringify(document)).not.toContain(key)
  const paths = resolveSchema(document, spec.paths)
  const operations = [
    ['/health', 'get'],
    ['/agents', 'get'],
    ['/threads', 'get'],
    ['/threads/{threadId}', 'get'],
    ['/threads/{threadId}/turns', 'post'],
    ['/threads/{threadId}/turns/{turnId}/resume', 'post'],
    ['/threads/{threadId}/turns/{turnId}/interrupt', 'post'],
    ['/threads/{threadId}/turns/{turnId}/steer', 'post'],
    ['/events', 'get'],
  ]
  expect(Object.keys(paths)).toHaveLength(9)
  for (const [path, method] of operations) {
    const operation = resolveSchema(document, resolveSchema(document, paths[path!])[method!])
    expect(operation.security ?? spec.security).toContainEqual({ bearerAuth: [] })
  }
  const components = resolveSchema(document, spec.components)
  const schemes = resolveSchema(document, components.securitySchemes)
  expect(schemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })

  const getThread = resolveSchema(document, resolveSchema(document, paths['/threads/{threadId}']).get)
  const responses = resolveSchema(document, getThread.responses)
  const ok = resolveSchema(document, responses['200'])
  const content = resolveSchema(document, ok.content)
  const output = resolveSchema(document, resolveSchema(document, content['application/json']).schema)
  const properties = resolveSchema(document, output.properties)
  const message = resolveSchema(document, resolveSchema(document, properties.messages).items)
  const messageProperties = resolveSchema(document, message.properties)
  const part = resolveSchema(document, resolveSchema(document, messageProperties.parts).items)
  const partVariants = part.oneOf ?? part.anyOf
  if (!Array.isArray(partVariants))
    throw new Error('消息片段必须保留领域联合 Schema')
  const partProperties = partVariants.map(variant => resolveSchema(document, resolveSchema(document, variant).properties))
  expect(partProperties).toContainEqual(expect.objectContaining({
    type: expect.objectContaining({ const: 'text' }),
    text: expect.objectContaining({ type: 'string' }),
    messageId: expect.objectContaining({ type: 'string' }),
  }))
  expect(partProperties).toContainEqual(expect.objectContaining({
    type: expect.objectContaining({ const: 'tool' }),
    toolName: expect.objectContaining({ type: 'string' }),
    output: expect.objectContaining({ type: 'string' }),
  }))
  const runtime = resolveSchema(document, resolveSchema(document, properties.runtime).properties)
  const interrupt = resolveSchema(document, runtime.interrupt)
  const interruptVariants = interrupt.oneOf ?? interrupt.anyOf
  const interruptProperties = (Array.isArray(interruptVariants) ? interruptVariants : [interrupt])
    .map(variant => resolveSchema(document, resolveSchema(document, variant).properties))
  expect(interruptProperties).toContainEqual(expect.objectContaining({
    id: expect.objectContaining({ type: 'string' }),
    turnId: expect.objectContaining({ type: 'string' }),
    interaction: expect.objectContaining({ type: 'string' }),
    resumableWith: expect.objectContaining({ type: 'array' }),
    payload: expect.any(Object),
  }))
  const resume = resolveSchema(document, resolveSchema(document, paths['/threads/{threadId}/turns/{turnId}/resume']).post)
  const requestBody = resolveSchema(document, resume.requestBody)
  const bodyContent = resolveSchema(document, requestBody.content)
  const body = resolveSchema(document, resolveSchema(document, bodyContent['application/json']).schema)
  const json = resolveSchema(document, resolveSchema(document, body.properties).response)
  const jsonVariants = json.oneOf ?? json.anyOf
  const jsonTypes = Array.isArray(jsonVariants)
    ? jsonVariants.map(variant => resolveSchema(document, variant).type)
    : json.type
  expect(jsonTypes)
    .toEqual(expect.arrayContaining(['string', 'number', 'boolean', 'null', 'array', 'object']))
  expect(authorize).not.toHaveBeenCalled()

  await harness.server.close()
  for (const endpoint of ['/docs', '/spec.json']) {
    const closed = await harness.server.fetch(apiRequest(endpoint))
    expect(closed.status).toBe(503)
    expect(await closed.text()).not.toContain(key)
  }
  expect(authorize).not.toHaveBeenCalled()
})

test('文档标题与版本可配置，关闭文档入口仍保留受鉴权的 REST', async () => {
  const baseOptions = {
    agents: {},
    workspace: () => { throw new Error('文档和健康检查不应解析工作区') },
    model: () => { throw new Error('文档和健康检查不应解析模型') },
    authorize: ({ request }: ServerAuthorization) => request.headers.get('authorization') === 'Bearer fake-docs-key',
  }
  const customized = AgentServer.create({ ...baseOptions, apiReference: { title: 'Example API', version: '2.3.4' } })
  const disabled = AgentServer.create({ ...baseOptions, apiReference: false })
  onTestFinished(async () => {
    await customized.close()
    await disabled.close()
  })
  const spec = await customized.fetch(apiRequest('/spec.json'))
  expect(await spec.json()).toMatchObject({ info: { title: 'Example API', version: '2.3.4' } })
  expect(await (await customized.fetch(apiRequest('/docs'))).text()).toContain('Example API')
  for (const endpoint of ['/docs', '/spec.json'])
    expect((await disabled.fetch(apiRequest(endpoint))).status).toBe(404)
  expect((await disabled.fetch(apiRequest('/health'))).status).toBe(401)
  const health = await disabled.fetch(apiRequest('/health', { headers: { authorization: 'Bearer fake-docs-key' } }))
  expect(health.status).toBe(200)
  expect(await health.json()).toEqual({ status: 'ok' })
})

test('REST 复用鉴权与真实执行，平铺查询和 JSON 正文可互通既有 SDK', async () => {
  const headers = { authorization: 'Bearer fake-rest-key' }
  const authorize = vi.fn(({ request }: ServerAuthorization) => request.headers.get('authorization') === headers.authorization)
  const harness = await createServerHarness({ authorize })
  for (const endpoint of ['/health', '/agents'])
    expect((await harness.server.fetch(apiRequest(endpoint))).status).toBe(401)
  const agents = await harness.server.fetch(apiRequest('/agents', { headers }))
  expect(agents.status).toBe(200)
  expect(await agents.json()).toEqual([
    { id: 'alpha', name: 'alpha', description: '' },
    { id: 'beta', name: 'beta', description: '' },
  ])

  const request = harness.request()
  harness.models.push(createModel([response([{ type: 'text', text: 'REST 完成' }])]).model)
  const { threadId, ...body } = request
  const denied = await harness.server.fetch(apiRequest(`/threads/${threadId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  expect(denied.status).toBe(401)
  expect(harness.modelRequests).toEqual([])
  expect(await harness.stores.primary.store.turns.read(request.turnId)).toBeUndefined()
  const accepted = await harness.server.fetch(apiRequest(`/threads/${threadId}/turns`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toMatchObject({ threadId })
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  const query = new URLSearchParams({ agentId: 'alpha', workspaceId: 'primary' })
  const state = await harness.server.fetch(apiRequest(`/threads/${threadId}?${query}`, { headers }))
  expect(state.status).toBe(200)
  const persisted: ThreadState = await state.json()
  expect(persisted.messages.flatMap(message => message.parts))
    .toContainEqual(expect.objectContaining({ type: 'text', text: 'REST 完成' }))
  const list = await harness.server.fetch(apiRequest(`/threads?${query}&limit=1&archived=false`, { headers }))
  expect(list.status).toBe(200)
  expect(await list.json()).toMatchObject({ items: [{ threadId }], hasMore: false })
  expect(await harness.client(headers).rpc.thread.get(threadTarget(request))).toEqual(persisted)
  expect(await harness.client(headers).rpc.meta.health({})).toEqual({ status: 'ok' })
  expect(harness.modelRequests).toHaveLength(1)
  expect(harness.errors).toEqual([])
})

test('REST SSE 支持作用域查询、游标回放与取消，取消观察不会执行或重复任务', async () => {
  const headers = { authorization: 'Bearer fake-openapi-events-key' }
  const harness = await createServerHarness({
    authorize: ({ request }) => request.headers.get('authorization') === headers.authorization,
  })
  const query = new URLSearchParams({ agentId: 'alpha', workspaceId: 'primary' })
  expect((await harness.server.fetch(apiRequest(`/events?${query}`))).status).toBe(401)
  const first = await harness.server.fetch(apiRequest(`/events?${query}`, { headers }))
  expect(first.status).toBe(200)
  expect(first.headers.get('content-type')).toContain('text/event-stream')
  const firstReader = first.body!.pipeThrough(new TextDecoderStream()).getReader()
  onTestFinished(() => firstReader.cancel())
  const opening = await readUntil(firstReader, '"type":"stream.reset"')
  const cursor = [...opening.matchAll(/^id:([^\r\n]*)/gm)].at(-1)?.[1]?.trim()
  expect(parseRuntimeEventCursor(cursor)).toBeDefined()
  await firstReader.cancel()

  harness.models.push(createModel([response([{ type: 'text', text: '观察离线期间完成' }])]).model)
  const request = harness.request()
  await harness.client(headers).rpc.turn.create(request)
  await vi.waitFor(async () => {
    expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('completed')
  })
  const resumed = await harness.server.fetch(apiRequest(`/events?${query}`, { headers: { ...headers, 'last-event-id': cursor! } }))
  expect(resumed.status).toBe(200)
  const resumedReader = resumed.body!.pipeThrough(new TextDecoderStream()).getReader()
  onTestFinished(() => resumedReader.cancel())
  const replay = await readUntil(resumedReader, '"type":"turn.completed"')
  expect(replay).not.toContain('"type":"stream.reset"')
  expect(replay).toContain(request.turnId)
  await resumedReader.cancel()
  expect(harness.modelRequests).toHaveLength(1)
  expect(harness.events.filter(event => event.type === 'turn.completed')).toHaveLength(1)
  expect(harness.errors).toEqual([])
})
