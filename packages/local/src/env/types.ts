import type { EnvVars } from '@elmino/sandbox'
import type { spawn } from 'node:child_process'

/** 单层应用环境配置 */
export interface EnvLayer {
  /** 追加到 PATH 末尾的目录 */
  appendPath?: readonly string[]
  /** 前置到 PATH 开头的目录 */
  prependPath?: readonly string[]
  /** 当前层覆盖的普通环境变量 */
  variables?: NodeJS.ProcessEnv | EnvVars
}

/** 用户 Shell 环境重新加载入口 */
export type EnvLoader = () => Promise<EnvVars>

/** 本地环境作用域初始化参数 */
export interface LocalEnvOptions {
  /** 用户 Shell 提供的基础环境 */
  shell: NodeJS.ProcessEnv | EnvVars
  /** 重新读取用户 Shell 环境 */
  loadShell?: EnvLoader
  /** 命令行启动时提供的最终覆盖环境 */
  launch?: NodeJS.ProcessEnv | EnvVars
  /** 当前运行平台 */
  platform?: NodeJS.Platform
}

/** 用户 Shell 环境加载参数 */
export interface LoadUserEnvOptions {
  /** 启动登录 Shell 时保留的宿主环境 */
  env?: NodeJS.ProcessEnv
  /** 当前运行平台 */
  platform?: NodeJS.Platform
  /** 显式指定用户 Shell */
  shellPath?: string
  /** 覆盖 Shell 进程创建入口，供平台测试使用 */
  spawn?: typeof spawn
  /** Shell 环境读取超时 */
  timeoutMs?: number
}
