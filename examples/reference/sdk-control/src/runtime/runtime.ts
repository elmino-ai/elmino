import { createEnv, resolveLocalShell } from '@elmino/local'
import { defineRuntime } from '@elmino/runtime/local'
import { LocalSandbox } from '@elmino/sandbox-local'

/** Runtime 与其他教程相同；本例工具只等待或回显，不执行 Shell 和文件写入 */
/** 使用本轮实际执行位置创建沙箱，工作目录由 Elmino 工作区提供 */
export const runtime = defineRuntime(({ location }) => {
  // 每个 Runtime 捕获环境快照，后续进程环境变化不会影响已创建的沙箱
  const env = createEnv(process.env)
  return LocalSandbox.create({
    cwd: location.cwd,
    env,
    shell: resolveLocalShell({ env, accountShell: null }),
  })
})
