import type { DecodeHttpErrorContext } from '../src/index'
import { expect, test, vi } from 'vitest'
import { createRequest, HttpError } from '../src/index'

test('rawFetch 保留非成功响应给协议适配器处理', async () => {
  const response = Response.json({ error: 'conflict' }, { status: 409 })
  const decodeError = vi.fn()
  const client = createRequest({
    baseUrl: 'https://service.example',
    system: 'example',
    decodeError,
    fetch: () => Promise.resolve(response),
  })

  expect(await client.rawFetch('/items')).toBe(response)
  expect(decodeError).not.toHaveBeenCalled()
  expect(response.bodyUsed).toBe(false)
  expect(await response.json()).toEqual({ error: 'conflict' })
})

test('结构化错误保留来源和业务信息，只接收完整的校验问题', async () => {
  const client = createRequest({
    baseUrl: 'https://service.example',
    system: 'example',
    fetch: () => Promise.resolve(Response.json({
      error: 'conflict',
      code: 'CONFLICT',
      details: { id: 'item' },
      issues: [
        { code: 'custom', message: 'invalid', path: 'name' },
        { code: 'custom', message: 'missing path' },
        null,
      ],
    }, { status: 409 })),
  })
  const pending = client.fetch('/items')

  await expect(pending).rejects.toBeInstanceOf(HttpError)
  await expect(pending).rejects.toMatchObject({
    name: 'HttpError',
    system: 'example',
    status: 409,
    message: 'conflict',
    code: 'CONFLICT',
    details: { id: 'item' },
    issues: [{ code: 'custom', message: 'invalid', path: 'name' }],
  })
})

test.each([
  { text: 'upstream unavailable', statusText: 'Bad Gateway', expected: 'upstream unavailable' },
  { text: '', statusText: 'Bad Gateway', expected: 'Bad Gateway' },
])('纯文本或空响应仍有可读错误 $expected', async ({ text, statusText, expected }) => {
  const client = createRequest({
    baseUrl: 'https://service.example',
    system: 'example',
    fetch: () => Promise.resolve(new Response(text, { status: 502, statusText })),
  })

  await expect(client.fetch('/items')).rejects.toMatchObject({ status: 502, message: expected })
})

test('自定义解析读取一次正文并覆盖选定字段，未覆盖字段保留默认解析', async () => {
  const body = { message: 'default message', code: 'DEFAULT', details: { source: 'server' } }
  const decodeError = vi.fn(({ system, response, text, body: parsed }: DecodeHttpErrorContext) => {
    expect(system).toBe('example')
    expect(response.status).toBe(422)
    expect(JSON.parse(text)).toEqual(body)
    expect(parsed).toEqual(body)
    return Promise.resolve({ message: 'custom message', code: 'CUSTOM' })
  })
  const client = createRequest({
    baseUrl: 'https://service.example',
    system: 'example',
    decodeError,
    fetch: () => Promise.resolve(Response.json(body, { status: 422 })),
  })

  await expect(client.fetch('/items')).rejects.toMatchObject({
    message: 'custom message',
    code: 'CUSTOM',
    details: body.details,
  })
  expect(decodeError).toHaveBeenCalledTimes(1)
})

test('错误解析器自身失败保持原错误归属', async () => {
  const reason = new Error('decoder failed')
  const client = createRequest({
    baseUrl: 'https://service.example',
    system: 'example',
    decodeError: () => Promise.reject(reason),
    fetch: () => Promise.resolve(new Response('invalid', { status: 400 })),
  })

  await expect(client.fetch('/items')).rejects.toBe(reason)
})
