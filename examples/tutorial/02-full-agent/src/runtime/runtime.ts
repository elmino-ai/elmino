import { createEnv, resolveLocalShell } from '@elmino/local'
import { defineRuntime } from '@elmino/runtime/local'
import { LocalSandbox } from '@elmino/sandbox-local'

/** 每个线程创建独立 Sandbox，位置由运行请求提供 */
export const runtime = defineRuntime(({ location }) => {
  const env = createEnv(process.env)
  return LocalSandbox.create({
    cwd: location.cwd,
    env,
    shell: resolveLocalShell({ env, accountShell: null }),
  })
})
