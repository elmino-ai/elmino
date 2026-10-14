/** -------------------- 类型 -------------------- */
/** Turn 宿主服务标识，泛型只用于约束绑定值和读取结果 */
export interface HostService<T> {
  /** 服务稳定 ID */
  id: string
  /** 服务类型占位，不参与运行时数据 */
  readonly value?: T
}

/** 单个 Turn 宿主服务绑定 */
export interface HostServiceBinding<T = unknown> {
  /** 服务标识 */
  service: HostService<T>
  /** 当前 Turn 宿主提供的服务实例 */
  value: T
}

/** 工具执行期间可读取的 Turn 宿主服务集合 */
export interface HostServices {
  /** 读取可选服务 */
  get: <T>(service: HostService<T>) => T | undefined
  /** 读取必需服务 */
  require: <T>(service: HostService<T>) => T
}

/** -------------------- 核心函数 -------------------- */
/**
 * 定义类型化 Turn 宿主服务标识
 */
export function defineHostService<T>(id: string): HostService<T> {
  return { id }
}

/**
 * 绑定 Turn 宿主提供的服务实例
 */
export function provideHostService<T>(
  service: HostService<T>,
  value: T,
): HostServiceBinding<T> {
  return { service, value }
}

/**
 * 创建当前 Turn 的宿主服务集合
 */
export function createHostServices(
  bindings: HostServiceBinding[] = [],
): HostServices {
  const values = new Map(
    bindings.map(binding => [binding.service.id, binding.value]),
  )

  /** 读取当前 Turn 注入的宿主服务 */
  const get = <T>(service: HostService<T>) => {
    return values.get(service.id) as T | undefined
  }
  /** 读取当前 Turn 必需的宿主服务 */
  const require = <T>(service: HostService<T>) => {
    const value = get(service)

    if (value === undefined)
      throw new Error(`宿主服务未注册: ${service.id}`)

    return value
  }

  return { get, require }
}
