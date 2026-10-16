import { z } from 'zod'

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

/** -------------------- Schema -------------------- */
/** 事件标识，由内核生成带 event 前缀的 UUID v4 */
export const EventIdSchema = z.string()
  .regex(EVENT_ID_PATTERN)
  .describe('事件标识，由内核生成带 event 前缀的 UUID v4')
  .meta({ examples: ['event_123e4567-e89b-42d3-a456-426614174000'] })

/** 线程标识，由内核生成带 thread 前缀的 UUID v4 */
export const ThreadIdSchema = z.string()
  .regex(THREAD_ID_PATTERN)
  .describe('线程标识，由内核生成带 thread 前缀的 UUID v4')
  .meta({ examples: ['thread_123e4567-e89b-42d3-a456-426614174000'] })

/** 单次运行标识，由内核生成带 turn 前缀的 UUID v4 */
export const TurnIdSchema = z.string()
  .regex(TURN_ID_PATTERN)
  .describe('单次运行标识，由内核生成带 turn 前缀的 UUID v4')
  .meta({ examples: ['turn_123e4567-e89b-42d3-a456-426614174000'] })

/** 消息标识，由内核生成带 msg 前缀的 UUID v4 */
export const MessageIdSchema = z.string()
  .regex(MESSAGE_ID_PATTERN)
  .describe('消息标识，由内核生成带 msg 前缀的 UUID v4')
  .meta({ examples: ['msg_123e4567-e89b-42d3-a456-426614174000'] })

/** 持久化消息片段标识，由内核生成带 part 前缀的 UUID v4 */
export const PartIdSchema = z.string()
  .regex(PART_ID_PATTERN)
  .describe('持久化消息片段标识，由内核生成带 part 前缀的 UUID v4')
  .meta({ examples: ['part_123e4567-e89b-42d3-a456-426614174000'] })

/** 工具执行标识，由内核生成；模型供应商原生调用标识不受此约束 */
export const ToolCallIdSchema = z.string()
  .regex(TOOL_CALL_ID_PATTERN)
  .describe('工具执行标识，由内核生成；模型供应商原生调用标识不受此约束')
  .meta({ examples: ['tool_123e4567-e89b-42d3-a456-426614174000'] })

/** 中断标识，由内核生成带 interrupt 前缀的 UUID v4 */
export const InterruptIdSchema = z.string()
  .regex(INTERRUPT_ID_PATTERN)
  .describe('中断标识，由内核生成带 interrupt 前缀的 UUID v4')
  .meta({ examples: ['interrupt_123e4567-e89b-42d3-a456-426614174000'] })

/** 事件流标识，区分不同服务启动周期 */
export const StreamIdSchema = z.string()
  .regex(STREAM_ID_PATTERN)
  .describe('事件流标识，区分不同服务启动周期')
  .meta({ examples: ['stream_123e4567-e89b-42d3-a456-426614174000'] })

/** 线程消息片段标识，允许持久化标识、消息派生标识和插件命名空间标识 */
export const ThreadPartIdSchema = z.string()
  .regex(THREAD_PART_ID_PATTERN)
  .describe('线程消息片段标识，允许持久化标识、消息派生标识和插件命名空间标识')
  .meta({
    examples: [
      'part_123e4567-e89b-42d3-a456-426614174000',
      'msg_123e4567-e89b-42d3-a456-426614174000:reasoning',
      'msg_123e4567-e89b-42d3-a456-426614174000:tool:call_provider_1',
      'plugin:custom-note',
    ],
  })
