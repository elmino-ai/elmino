import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createExampleClient } from '../src/client/client'

beforeEach(() => {
  for (const name of ['ELMINO_SERVER_URL', 'ELMINO_SERVER_KEY', 'ELMINO_HOST', 'ELMINO_PORT'])
    vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('客户端缺省连接本机 3000，ELMINO_SERVER_URL 可指定远程地址或 IPv6', () => {
  expect(createExampleClient().baseUrl).toBe('http://127.0.0.1:3000')
  vi.stubEnv('ELMINO_SERVER_URL', 'http://[::1]:3100')
  expect(createExampleClient().baseUrl).toBe('http://[::1]:3100')
})

test('客户端忽略其他应用的通用地址和凭据变量', async () => {
  vi.stubEnv('SERVER_URL', 'https://another-application.test')
  vi.stubEnv('SERVER_KEY', 'another-application-key')
  vi.stubEnv('HOST', 'another-application-host')
  vi.stubEnv('PORT', 'another-application-port')
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
  const client = createExampleClient()
  expect(client.baseUrl).toBe('http://127.0.0.1:3000')
  await client.transport('/host').rawFetch('http://127.0.0.1:3000/host/info')
  const [input, init] = request.mock.calls[0]!
  expect(new Request(input, init).headers.has('authorization')).toBe(false)
})

test('指定远程 URL 后不校验本机监听、存储、CORS 或模型配置', () => {
  vi.stubEnv('ELMINO_SERVER_URL', 'https://agent.example.test/prefix')
  vi.stubEnv('ELMINO_PORT', 'invalid-unused-port')
  vi.stubEnv('ELMINO_DATA_DIR', '')
  vi.stubEnv('ELMINO_CORS_ORIGINS', 'invalid-unused-origin')
  vi.stubEnv('DEEPSEEK_API_KEY', undefined)
  expect(createExampleClient().baseUrl).toBe('https://agent.example.test/prefix')
})

test('客户端捕获自己的凭据快照，之后改环境不改变现有请求身份', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubEnv('ELMINO_SERVER_KEY', ' first-key ')
  const first = createExampleClient()
  vi.stubEnv('ELMINO_SERVER_KEY', 'second-key')
  const second = createExampleClient()
  await first.transport('/host').rawFetch('http://127.0.0.1:3000/host/info')
  await second.transport('/host').rawFetch('http://127.0.0.1:3000/host/info')
  const authorizations = request.mock.calls.map(([input, init]) => new Request(input, init).headers.get('authorization'))
  expect(authorizations).toEqual(['Bearer first-key', 'Bearer second-key'])
})

test('空白配置采用缺省且不改变原始环境，错误配置不打印凭据', () => {
  for (const name of ['ELMINO_SERVER_URL', 'ELMINO_SERVER_KEY', 'ELMINO_HOST', 'ELMINO_PORT'])
    vi.stubEnv(name, '  ')
  expect(createExampleClient().baseUrl).toBe('http://127.0.0.1:3000')
  expect(process.env.ELMINO_SERVER_KEY).toBe('  ')
  vi.stubEnv('ELMINO_SERVER_KEY', 'fake-test-key')
  vi.stubEnv('ELMINO_SERVER_URL', 'invalid-server-url')
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(() => createExampleClient()).toThrow('ELMINO_SERVER_URL')
  expect(error).not.toHaveBeenCalled()
})
