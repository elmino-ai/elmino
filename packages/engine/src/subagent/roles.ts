import type { SubagentRole } from '@elmino/store'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_SUBAGENT_ROLE_MARKDOWN,
  EXPLORER_SUBAGENT_ROLE_MARKDOWN,
  WORKER_SUBAGENT_ROLE_MARKDOWN,
} from '../prompts/constants/templates.js'
import { parseSubagentRole } from './parse.js'

/** -------------------- 常量 -------------------- */
/** 按展示顺序固定的内置角色资产 */
const BUILTIN_SUBAGENT_ROLE_MARKDOWN = [
  ['default', DEFAULT_SUBAGENT_ROLE_MARKDOWN],
  ['explorer', EXPLORER_SUBAGENT_ROLE_MARKDOWN],
  ['worker', WORKER_SUBAGENT_ROLE_MARKDOWN],
] as const

/** -------------------- 核心函数 -------------------- */
/**
 * 读取独立解析的内置角色，调用方修改不会改变下一次解析的目录
 */
export function getBuiltinSubagentRoles(): SubagentRole[] {
  return BUILTIN_SUBAGENT_ROLE_MARKDOWN.map(([id, markdown]) => parseSubagentRole(id, markdown))
}

/** -------------------- 核心类 -------------------- */
/**
 * 初始化并解析本地内置和用户子智能体角色
 */
export class LocalSubagentRoles {
  /**
   * 创建本地角色存储
   */
  public static create({ dir }: {
    /** 用户自定义角色目录 */
    dir: string
  }) {
    return new LocalSubagentRoles(dir)
  }

  /**
   * 保存用户角色目录
   */
  private constructor(private readonly _dir: string) {}

  /**
   * 创建用户角色目录并补齐缺失的内置角色文件
   */
  public async initialize() {
    await mkdir(this._dir, { recursive: true })

    for (const [id, markdown] of BUILTIN_SUBAGENT_ROLE_MARKDOWN) {
      try {
        await writeFile(path.join(this._dir, `${id}.md`), markdown, {
          encoding: 'utf8',
          flag: 'wx',
        })
      }
      catch (error) {
        // 排他创建确保并发初始化和用户保存都不会覆盖已经存在的角色文件
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw error
      }
    }
  }

  /**
   * 解析内置和用户 Markdown 合并后的当前角色目录
   */
  public async resolve() {
    const roles = new Map(getBuiltinSubagentRoles().map(role => [role.id, role]))
    let entries: string[]

    try {
      entries = (await readdir(this._dir))
        .filter(file => file.endsWith('.md'))
        .sort((left, right) => left.localeCompare(right))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return [...roles.values()]

      throw error
    }

    for (const file of entries) {
      const id = path.basename(file, '.md')

      try {
        const markdown = await readFile(path.join(this._dir, file), 'utf8')
        roles.set(id, parseSubagentRole(id, markdown))
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`已忽略无效子智能体角色 ${file}: ${message}`)
      }
    }

    return [...roles.values()]
  }
}
