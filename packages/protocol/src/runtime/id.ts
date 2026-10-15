/** -------------------- 常量 -------------------- */
/** 内核生成的 opaque ID 在跨端入口保持 UUID v4 格式 */
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

/** 事件 ID */
export const EVENT_ID_PATTERN = new RegExp(`^event_${uuid}$`, 'u')
/** 线程 ID */
export const THREAD_ID_PATTERN = new RegExp(`^thread_${uuid}$`, 'u')
/** Turn ID */
export const TURN_ID_PATTERN = new RegExp(`^turn_${uuid}$`, 'u')
/** 消息 ID */
export const MESSAGE_ID_PATTERN = new RegExp(`^msg_${uuid}$`, 'u')
/** 消息片段 ID */
export const PART_ID_PATTERN = new RegExp(`^part_${uuid}$`, 'u')
/** 工具执行 ID，Provider 原生调用 ID 不使用此约束 */
export const TOOL_CALL_ID_PATTERN = new RegExp(`^tool_${uuid}$`, 'u')
/** 中断 ID */
export const INTERRUPT_ID_PATTERN = new RegExp(`^interrupt_${uuid}$`, 'u')
/** 每次服务启动创建的事件流 ID */
export const STREAM_ID_PATTERN = new RegExp(`^stream_${uuid}$`, 'u')
/** 片段允许持久化 ID、消息派生 ID 与插件命名空间 ID */
export const THREAD_PART_ID_PATTERN = new RegExp(`^(?:part_${uuid}|msg_${uuid}:(?:reasoning|tool:\\S+)|plugin:\\S+)$`, 'u')
