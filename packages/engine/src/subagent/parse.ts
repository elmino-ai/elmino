import type { SubagentRole } from '@elmino/store'
import { parse } from 'yaml'

/** -------------------- 常量 -------------------- */
/** 角色 ID 使用稳定文件名，不是系统生成的运行实体 ID */
const roleIdPattern = /^[a-z0-9][a-z0-9_-]*$/
/** 角色允许的描述字段，不隐含工具或权限过滤 */
const fields = new Set(['name', 'description', 'icon'])
/** 持久化角色图标的实际语义 */
const icons = ['bot', 'compass', 'tool'] as const

/** -------------------- 核心函数 -------------------- */
/**
 * 解析并校验角色的 YAML frontmatter 与完整指令正文
 */
export function parseSubagentRole(id: string, markdown: string): SubagentRole {
  if (!roleIdPattern.test(id))
    throw new Error(`子智能体角色 ID 无效: ${id}`)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  const metadata: unknown = match ? parse(match[1] ?? '') : undefined
  const instructions = match ? markdown.slice(match[0].length).trim() : markdown.trim()

  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error(`子智能体角色缺少有效的 YAML frontmatter: ${id}`)
  const unknown = Object.keys(metadata).filter(key => !fields.has(key))

  if (unknown.length > 0)
    throw new Error(`子智能体角色包含未支持字段: ${unknown.join(', ')}`)
  const name = 'name' in metadata ? metadata.name : undefined
  const description = 'description' in metadata ? metadata.description : undefined
  const icon = icons.find(value => 'icon' in metadata && value === metadata.icon)

  if (
    typeof name !== 'string' || !name.trim() || typeof description !== 'string' || !description.trim()
    || !instructions
  ) {
    throw new Error(`子智能体角色缺少 name、description、icon 或正文: ${id}`)
  }
  if (!icon)
    throw new Error(`子智能体角色图标无效: ${'icon' in metadata ? String(metadata.icon) : ''}`)

  return { id, name, description, icon, instructions }
}
