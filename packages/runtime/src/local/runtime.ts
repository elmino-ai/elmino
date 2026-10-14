import type { Sandbox } from '@elmino/sandbox'
import type { Runtime, RuntimeCreateContext, RuntimeDefinition, ThreadLocation } from '../definition/types.js'

/** 本地 Runtime 装配参数 */
export interface LocalRuntimeOptions {
  /** 线程稳定作用域与执行位置 */
  location: ThreadLocation
  /** 当前 Runtime 独占并负责释放的执行能力 */
  sandbox: Sandbox
}

/**
 * 通过宿主提供的 Sandbox 工厂定义线程 Runtime
 */
export function defineRuntime(createSandbox: (context: RuntimeCreateContext) => Sandbox): RuntimeDefinition {
  return {
    create: context => LocalRuntime.create({
      location: context.location,
      sandbox: createSandbox(context),
    }),
  }
}

/**
 * 保存线程执行位置并管理注入执行环境的释放
 */
export class LocalRuntime implements Runtime {
  /** 当前线程稳定作用域与执行位置 */
  public readonly location: ThreadLocation
  /** Runtime 拥有的执行环境 */
  private readonly _sandbox: Sandbox
  /** 幂等资源释放任务 */
  private _closing?: Promise<void>

  /**
   * 组合宿主已创建的线程执行环境
   */
  public static create(options: LocalRuntimeOptions) {
    return new LocalRuntime(options)
  }

  /**
   * 冻结执行位置并接管 Sandbox 资源释放
   */
  private constructor(options: LocalRuntimeOptions) {
    this.location = Object.freeze({ ...options.location })
    this._sandbox = options.sandbox
  }

  /**
   * 读取注入的执行环境
   */
  public sandbox() {
    if (this._closing)
      throw new Error('Runtime 执行环境已经关闭')
    return this._sandbox
  }

  /**
   * 等待执行资源释放并拒绝之后的环境获取
   */
  public dispose() {
    this._closing ??= Promise.resolve().then(() => this._sandbox.shell.dispose())
    return this._closing
  }
}
