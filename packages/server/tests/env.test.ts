import type { ServerOptions } from '../src/server/types'
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { serverStartEnvironment } from '../src/env/env'
import * as nodeTransport from '../src/node/listen'
import { createEmptyServer } from './support/server'

beforeEach(() => {
  for (const name of ['ELMINO_SERVER_KEY', 'ELMINO_HOST', 'ELMINO_PORT', 'ELMINO_CORS_ORIGINS'])
    vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** 无需工作区和模型即可观察配置对 HTTP 授权与响应头的影响 */
function server(options: Omit<ServerOptions, 'elmino'> = {}) {
  const value = createEmptyServer({ apiKey: undefined, corsOrigins: undefined, ...options })
  onTestFinished(() => value.close())
  return value
}

/** 健康接口与业务接口经过相同的内置鉴权和 CORS */
function health(apiKey?: string, origin?: string) {
  const headers = new Headers()
  if (apiKey)
    headers.set('authorization', `Bearer ${apiKey}`)
  if (origin)
    headers.set('origin', origin)
  return new Request('http://elmino.test/api/health', { headers })
}

test('缺少环境配置时不启用鉴权或 CORS，监听默认本机 3000', async () => {
  const listen = vi.spyOn(nodeTransport, 'listen').mockResolvedValue({
    url: 'http://127.0.0.1:3000',
    close: async () => {},
  })
  const app = server()
  const response = await app.fetch(health(undefined, 'http://localhost:5173'))
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
  await expect(app.start({ shutdownSignals: false })).resolves.toBe('http://127.0.0.1:3000')
  expect(listen).toHaveBeenCalledWith({ server: app, port: 3000, hostname: '127.0.0.1' })
})

test('其他应用的通用变量不影响授权、跨域或监听配置', async () => {
  vi.stubEnv('SERVER_KEY', 'another-application-key')
  vi.stubEnv('CORS_ORIGINS', 'another-application-origin')
  vi.stubEnv('HOST', 'another-application-host')
  vi.stubEnv('PORT', 'another-application-port')
  expect((await server().fetch(health())).status).toBe(200)
  expect(serverStartEnvironment({})).toMatchObject({ ELMINO_HOST: '127.0.0.1', ELMINO_PORT: 3000 })
})

test('定义时捕获各实例自己的凭据和来源，不读取无关监听参数', async () => {
  vi.stubEnv('ELMINO_SERVER_KEY', ' first-key ')
  vi.stubEnv('ELMINO_CORS_ORIGINS', ' http://localhost:5173, https://example.test ')
  vi.stubEnv('ELMINO_PORT', 'invalid-unused-port')
  const first = server()
  vi.stubEnv('ELMINO_SERVER_KEY', 'second-key')
  vi.stubEnv('ELMINO_CORS_ORIGINS', 'https://second.test')
  const second = server()
  expect((await first.fetch(health())).status).toBe(401)
  const response = await first.fetch(health('first-key', 'https://example.test'))
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBe('https://example.test')
  expect((await first.fetch(health('second-key'))).status).toBe(401)
  expect((await second.fetch(health('second-key'))).status).toBe(200)
  expect((await second.fetch(health('first-key'))).status).toBe(401)
})

test('显式凭据与来源覆盖环境配置，空来源数组明确禁用 CORS', async () => {
  vi.stubEnv('ELMINO_SERVER_KEY', 'environment-key')
  vi.stubEnv('ELMINO_CORS_ORIGINS', 'not-an-origin')
  const app = server({ apiKey: 'explicit-key', corsOrigins: [] })
  expect((await app.fetch(health('environment-key'))).status).toBe(401)
  const response = await app.fetch(health('explicit-key', 'http://localhost:5173'))
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
  const withOrigin = server({ corsOrigins: ['https://explicit.test'] })
  expect((await withOrigin.fetch(health('environment-key', 'https://explicit.test'))).headers.get('access-control-allow-origin')).toBe('https://explicit.test')
})

test('null 明确禁用环境凭据，仍保留宿主 authorize 检查', async () => {
  vi.stubEnv('ELMINO_SERVER_KEY', 'environment-key')
  expect((await server({ apiKey: null }).fetch(health())).status).toBe(200)
  expect((await server({ apiKey: null, authorize: () => false }).fetch(health())).status).toBe(401)
})

test.each(['', '   '])('空环境配置 %j 使用默认值且不修改 process.env', async (empty) => {
  for (const name of ['ELMINO_SERVER_KEY', 'ELMINO_HOST', 'ELMINO_PORT', 'ELMINO_CORS_ORIGINS'])
    vi.stubEnv(name, empty)
  const app = server()
  expect((await app.fetch(health())).status).toBe(200)
  expect(serverStartEnvironment({})).toMatchObject({ ELMINO_HOST: '127.0.0.1', ELMINO_PORT: 3000 })
  expect(process.env.ELMINO_SERVER_KEY).toBe(empty)
  expect(process.env.ELMINO_PORT).toBe(empty)
})

test.each(['', '   '])('显式空凭据 %j 沿用原有错误，不回退环境变量', (apiKey) => {
  vi.stubEnv('ELMINO_SERVER_KEY', 'environment-key')
  expect(() => server({ apiKey })).toThrow('apiKey 不能为空')
})

test('首次启动读取最新 ELMINO_HOST 和 ELMINO_PORT，重复启动不重读或校验新环境', async () => {
  const listen = vi.spyOn(nodeTransport, 'listen').mockResolvedValue({
    url: 'http://localhost:3100',
    close: async () => {},
  })
  const app = server()
  vi.stubEnv('ELMINO_HOST', ' localhost ')
  vi.stubEnv('ELMINO_PORT', ' 3100 ')
  await expect(app.start({ shutdownSignals: false })).resolves.toBe('http://localhost:3100')
  vi.stubEnv('ELMINO_HOST', '')
  vi.stubEnv('ELMINO_PORT', 'invalid')
  await expect(app.start({ port: -1 })).resolves.toBe('http://localhost:3100')
  expect(listen).toHaveBeenCalledExactlyOnceWith({ server: app, port: 3100, hostname: 'localhost' })
})

test('显式启动参数覆盖无效环境，端口 0 交给系统选择', async () => {
  vi.stubEnv('ELMINO_HOST', 'invalid-host')
  vi.stubEnv('ELMINO_PORT', 'invalid-port')
  const app = server()
  const url = await app.start({ hostname: '127.0.0.1', port: 0, shutdownSignals: false })
  expect(new URL(url).hostname).toBe('127.0.0.1')
  expect(Number(new URL(url).port)).toBeGreaterThan(0)
  expect((await fetch(`${url}/api/health`)).status).toBe(200)
})

test.each(['NaN', '-1', '65536', '3.14'])('无效环境端口 %s 在 start 时报错', async (port) => {
  vi.stubEnv('ELMINO_PORT', port)
  await expect(server().start({ shutdownSignals: false })).rejects.toThrow('ELMINO_PORT')
})

test.each(['*', 'https://example.test/path', 'https://example.test/', 'https://user:pass@example.test', 'file:///tmp/demo', 'null'])('无效环境 Origin %s 在定义时拒绝', (origin) => {
  vi.stubEnv('ELMINO_CORS_ORIGINS', origin)
  expect(() => server()).toThrow('CORS')
})

test('显式无效 Origin 不能依靠逗号拆分变成合法来源列表', () => {
  expect(() => server({ corsOrigins: ['https://a.test,https://b.test'] })).toThrow()
})
