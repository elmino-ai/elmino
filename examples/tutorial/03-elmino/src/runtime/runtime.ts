/**
 * 运行环境：定义每个线程怎样取得它自己的 Sandbox
 *
 * defineRuntime 只保存创建规则，真正执行时才根据 location 创建资源
 * location.cwd 来自运行入口的工作区；工具通过 sandbox 访问该目录
 * Elmino 管理 Engine；关闭应用时一并释放线程 Runtime 与配置借出的 Store
 */
import { createEnv, resolveLocalShell } from '@elmino/local'
import { defineRuntime } from '@elmino/runtime/local'
import { LocalSandbox } from '@elmino/sandbox-local'

/** 每个线程创建独立 Sandbox，位置由运行请求提供 */
export const runtime = defineRuntime(({ location }) => {
  // 在创建时冻结当前环境，避免运行到一半时随宿主环境变化
  const env = createEnv(process.env)
  return LocalSandbox.create({
    cwd: location.cwd,
    env,
    // null 表示跳过系统用户的登录 Shell 来源，示例使用环境与平台回退选择
    shell: resolveLocalShell({ env, accountShell: null }),
  })
})
