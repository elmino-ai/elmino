/**
 * 验收模型配置恢复：修改环境默认值后，原 Turn 仍使用冻结的模型配置
 * 这里只构造适配器，不发送真实请求；使用测试凭据，不加载本地 .env
 */
import { afterEach, expect, test, vi } from 'vitest'
import { createModel } from '../src/model/deepseek'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('恢复保留完整冻结模型配置，新任务使用当前环境默认值', () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fake-model-test-key')
  vi.stubEnv('DEEPSEEK_MODEL', 'original-model')
  vi.stubEnv('DEEPSEEK_BASE_URL', 'https://original.example.test/anthropic')
  const original = createModel()
  const frozenConfig = structuredClone(original.config)

  vi.stubEnv('DEEPSEEK_MODEL', 'changed-model')
  vi.stubEnv('DEEPSEEK_BASE_URL', 'https://changed.example.test/anthropic')
  const restored = createModel({ ...frozenConfig })
  expect(restored.config).toStrictEqual(frozenConfig)
  expect(restored.adapter.model).toBe('original-model')

  const fresh = createModel()
  expect(fresh.config).toMatchObject({
    name: 'changed-model',
    baseURL: 'https://changed.example.test/anthropic',
  })
  expect(fresh.adapter.model).toBe('changed-model')
  expect(fresh.config.id).not.toBe(frozenConfig.id)
  expect(fresh.config.providerId).not.toBe(frozenConfig.providerId)
})
