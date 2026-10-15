import { fork } from 'node:child_process'
import { once } from 'node:events'
import { Client } from '@elmino/sdk'
import { expect, onTestFinished, test, vi } from 'vitest'
import * as nodeTransport from '../src/node/listen'
import { createEmptyServer, createGatedModel, createServerHarness } from './support/server'

test('start 直接提供 HTTP、SDK 与文档，重复启动复用端口，close 释放监听', async () => {
  const server = createEmptyServer()
  onTestFinished(() => server.close())
  const before = process.listenerCount('SIGTERM')
  const [url, repeated] = await Promise.all([
    server.start({ port: 0, shutdownSignals: false }),
    server.start({ port: 1 }),
  ])
  expect(repeated).toBe(url)
  expect(process.listenerCount('SIGTERM')).toBe(before)
  const client = Client.create({ baseUrl: url })
  await expect(client.rpc.meta.health({})).resolves.toEqual({ status: 'ok' })
  expect((await fetch(`${url}/api/docs`)).status).toBe(200)
  const closing = server.close()
  expect(server.close()).toBe(closing)
  await closing
  await expect(fetch(`${url}/api/health`)).rejects.toThrow()
  await expect(server.start({ port: 0 })).rejects.toThrow('Server 已关闭')
  const next = createEmptyServer()
  onTestFinished(() => next.close())
  const rebound = await next.start({ port: Number(new URL(url).port), shutdownSignals: false })
  await expect(Client.create({ baseUrl: rebound }).rpc.meta.health({})).resolves.toEqual({ status: 'ok' })
})

test('监听失败保留 EADDRINUSE，失败的服务自动关闭且不影响端口原所有者', async () => {
  const owner = createEmptyServer()
  const server = createEmptyServer()
  onTestFinished(async () => {
    await Promise.all([owner.close(), server.close()])
  })
  const url = await owner.start({ port: 0, shutdownSignals: false })
  await expect(server.start({ port: Number(new URL(url).port) })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  await expect(server.start()).rejects.toThrow('Server 已关闭')
  expect((await server.fetch(new Request('http://elmino.test/api/health'))).status).toBe(503)
  await expect(Client.create({ baseUrl: url }).rpc.meta.health({})).resolves.toEqual({ status: 'ok' })
})

test('启动前即可关闭 Fetch 服务，不注册退出信号或后台端口', async () => {
  const server = createEmptyServer()
  const before = process.listenerCount('SIGINT')
  await expect(server.fetch(new Request('http://elmino.test/api/health'))).resolves.toHaveProperty('status', 200)
  await server.close()
  await expect(server.start()).rejects.toThrow('Server 已关闭')
  expect(process.listenerCount('SIGINT')).toBe(before)
})

test('start 与 close 并发时取消启动，不等待自己的关闭 Promise', async () => {
  const server = createEmptyServer()
  const before = process.listenerCount('SIGTERM')
  const starting = expect(server.start({ port: 0 })).rejects.toThrow('Server 已关闭')
  await server.close()
  await starting
  expect(process.listenerCount('SIGTERM')).toBe(before)
})

test('关闭会等待迟到的监听并释放端口，不在关闭期间补注册退出信号', async () => {
  const server = createEmptyServer()
  const opened = Promise.withResolvers<string>()
  const gate = Promise.withResolvers<void>()
  const listen = nodeTransport.listen
  const transport = vi.spyOn(nodeTransport, 'listen').mockImplementation(async (options) => {
    const listener = await listen(options)
    opened.resolve(listener.url)
    await gate.promise
    return listener
  })
  onTestFinished(async () => {
    gate.resolve()
    transport.mockRestore()
    await server.close()
  })
  const before = process.listenerCount('SIGTERM')
  const starting = expect(server.start({ port: 0 })).rejects.toThrow('Server 已关闭')
  const url = await opened.promise
  const closing = server.close()
  expect((await fetch(`${url}/api/health`)).status).toBe(503)
  gate.resolve()
  await Promise.all([closing, starting])
  expect(process.listenerCount('SIGTERM')).toBe(before)
  await expect(fetch(`${url}/api/health`)).rejects.toThrow()
})

test('默认退出信号只注册一次，手动关闭后撤销所有监听', async () => {
  const server = createEmptyServer()
  onTestFinished(() => server.close())
  const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))
  await server.start({ port: 0 })
  await server.start()
  for (const [index, signal] of ['SIGINT', 'SIGTERM'].entries())
    expect(process.listenerCount(signal)).toBe(before[index]! + 1)
  await server.close()
  for (const [index, signal] of ['SIGINT', 'SIGTERM'].entries())
    expect(process.listenerCount(signal)).toBe(before[index])
})

test('统一关闭会取消活跃模型、落下中断事实并关闭 HTTP，外部 Store 仍可读取', async () => {
  const harness = await createServerHarness()
  const model = createGatedModel()
  harness.models.push(model.model)
  const url = await harness.server.start({ port: 0, shutdownSignals: false })
  const client = Client.create({ baseUrl: url })
  const request = harness.request()
  await client.rpc.turn.create(request)
  await model.entered
  await harness.server.close()
  expect(model.signal?.aborted).toBe(true)
  expect((await harness.stores.primary.store.turns.read(request.turnId))?.status).toBe('interrupted')
  await expect(fetch(`${url}/api/health`)).rejects.toThrow()
  // 已接纳执行的取消仍经原有 onError 出口报告，关闭本身应成功且不产生其他错误
  expect(harness.errors).toEqual([expect.objectContaining({ message: model.signal?.reason })])
})

test.each(['SIGINT', 'SIGTERM'] as const)('独立进程收到 %s 后正常退出，启动不需要额外宿主信号代码', async (signal) => {
  const child = fork(new URL('./support/server-process.mjs', import.meta.url), { silent: true, execArgv: [] })
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exited = once(child, 'exit')
  const [message] = await once(child, 'message')
  const { url } = message as { url: string }
  expect((await fetch(`${url}/api/health`)).status).toBe(200)
  child.kill(signal)
  expect(await exited).toEqual([0, null])
  expect(stderr).toBe('')
  await expect(fetch(`${url}/api/health`)).rejects.toThrow()
})
