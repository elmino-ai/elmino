import type { EnvVars } from '@elmino/sandbox'
import type { EnvLayer, EnvLoader, LocalEnvOptions } from './types'
import path from 'node:path'
import { objectEntries, objectFromEntries, objectKeys } from '@elmino/shared'

/** -------------------- 核心类 -------------------- */
/**
 * 组合用户 Shell、应用配置和启动覆盖并发布不可变快照
 */
export class LocalEnv {
  /** 命令行启动最终覆盖层 */
  private readonly _launch: EnvVars
  /** 用户 Shell 环境重新加载入口 */
  private readonly _loadShell?: EnvLoader
  /** 当前运行平台 */
  private readonly _platform: NodeJS.Platform
  /** 用户 Shell 基础环境 */
  private _shell: EnvVars
  /** 应用管理的运行时环境层 */
  private _application: EnvLayer = {}
  /** 当前不可变执行环境 */
  private _env: EnvVars
  /** 并发刷新共享当前加载，避免迟到结果覆盖新环境 */
  private _refresh?: Promise<EnvVars>

  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建独立的本地环境作用域
   */
  public static create(options: LocalEnvOptions) {
    return new LocalEnv(options)
  }

  /**
   * 返回当前环境快照
   */
  public snapshot() {
    return this._env
  }

  /**
   * 替换应用运行时环境层并发布新快照
   */
  public setApplicationLayer(layer: EnvLayer) {
    this._application = freezeLayer(layer)
    this._env = this._compose()
  }

  /**
   * 重新读取用户 Shell 环境并保留应用与启动覆盖层
   */
  public refresh(): Promise<EnvVars> {
    const loadShell = this._loadShell

    if (!loadShell)
      return Promise.resolve(this._env)

    this._refresh ??= Promise.resolve().then(loadShell).then((shell) => {
      this._shell = createEnv(shell)
      this._env = this._compose()
      return this._env
    }).finally(() => {
      this._refresh = undefined
    })
    return this._refresh
  }

  /**
   * 保存三个固定环境层并创建首个快照
   */
  private constructor(options: LocalEnvOptions) {
    const { launch = {}, loadShell, platform = process.platform, shell } = options

    this._launch = createEnv(launch)
    this._loadShell = loadShell
    this._platform = platform
    this._shell = createEnv(shell)
    this._env = this._compose()
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 按固定层级生成完整环境变量
   */
  private _compose() {
    const applicationVariables = createEnv(this._application.variables ?? {})
    const variables = mergeVariables(Object.create(null) as Record<string, string>, this._shell, this._platform)

    mergeVariables(variables, applicationVariables, this._platform)
    const pathKey = resolvePathKey(variables, this._platform)
    const pathValue = variables[pathKey] ?? ''

    variables[pathKey] = composePath(
      pathValue,
      this._application.prependPath ?? [],
      this._application.appendPath ?? [],
      this._platform,
    )

    mergeVariables(variables, this._launch, this._platform)
    return createEnv(variables)
  }
}

/** -------------------- 工具函数 -------------------- */
/**
 * 冻结去除 undefined 的环境变量副本
 */
export function createEnv(
  env: NodeJS.ProcessEnv | EnvVars,
): EnvVars {
  return Object.freeze(objectFromEntries(
    objectEntries(env).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  ))
}

/**
 * 复制并冻结单个应用环境层
 */
function freezeLayer(layer: EnvLayer): EnvLayer {
  return Object.freeze({
    appendPath: Object.freeze([...(layer.appendPath ?? [])]),
    prependPath: Object.freeze([...(layer.prependPath ?? [])]),
    variables: createEnv(layer.variables ?? {}),
  })
}

/**
 * 合并 PATH 目录并按平台规则去重
 */
function composePath(
  value: string,
  prepend: readonly string[],
  append: readonly string[],
  platform: NodeJS.Platform,
) {
  const delimiter = platform === 'win32' ? ';' : ':'
  const pathPlatform = platform === 'win32' ? path.win32 : path.posix
  const insensitive = platform === 'win32'
  const seen = new Set<string>()

  return [
    ...prepend,
    ...value.split(delimiter),
    ...append,
  ].filter(Boolean).filter((item) => {
    const normalized = pathPlatform.normalize(item)
    const key = insensitive ? normalized.toLowerCase() : normalized

    if (seen.has(key))
      return false

    seen.add(key)
    return true
  }).join(delimiter)
}

/**
 * 解析当前平台实际使用的 PATH 键名
 */
export function resolvePathKey(
  env: NodeJS.ProcessEnv | EnvVars,
  platform: NodeJS.Platform,
) {
  if (platform !== 'win32')
    return 'PATH'

  return objectKeys(env).find(name => name.toLowerCase() === 'path') ?? 'Path'
}

/**
 * 合并环境变量，Windows 上同名键不区分大小写
 */
function mergeVariables(
  target: Record<string, string>,
  source: EnvVars,
  platform: NodeJS.Platform,
) {
  if (platform !== 'win32') {
    Object.assign(target, source)
    return target
  }

  for (const [name, value] of objectEntries(source)) {
    const key = objectKeys(target).find(existing => existing.toLowerCase() === name.toLowerCase()) ?? name

    for (const existing of objectKeys(target)) {
      if (existing !== key && existing.toLowerCase() === name.toLowerCase())
        delete target[existing]
    }
    target[key] = value
  }

  return target
}
