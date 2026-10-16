import { z } from 'zod'

/** 拒绝空白但保留原值，用于身份键和需要保真保存的文本 */
export const NonBlankStringSchema = z.string()
  .min(1)
  .refine(value => value.trim().length > 0, '不能仅包含空白字符')
  .describe('非空白字符串，保留原始内容')

/** 配置等明确允许归一化的输入；不用于需要保真的身份或消息 */
export const TrimmedStringSchema = z.string()
  .trim()
  .min(1)
  .describe('去除首尾空白后的非空字符串')
