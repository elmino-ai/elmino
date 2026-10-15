import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createId } from '@elmino/shared'
import * as z from 'zod'

/** 宿主持有当前会话的定位信息，运行事实和模型冻结配置仍由 RuntimeStore 持有 */
export interface ExampleSession {
  /** 当前线程 */
  threadId: string
  /** 当前运行 */
  turnId: string
  /** 当前工作区 */
  workspaceId: string
  /** 示例工具生成的二进制产物 */
  artifactId: string
}

const sessionSchema = z.strictObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  workspaceId: z.string().min(1),
  artifactId: z.string().min(1),
})

/** 为新会话创建指针，拒绝覆盖已有会话；示例数据目录由调用方明确提供 */
export async function createSession(dataDir: string): Promise<ExampleSession> {
  const session: ExampleSession = {
    threadId: createId('thread'),
    turnId: createId('turn'),
    workspaceId: createId('workspace'),
    artifactId: createId('artifact'),
  }
  await mkdir(dataDir, { recursive: true })
  try {
    await writeFile(path.join(dataDir, 'session.json'), JSON.stringify(session, null, 2), { flag: 'wx' })
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('该目录已有示例会话，请使用 inspect 或 resume')
    throw error
  }
  return session
}

/** 从宿主入口读取持久化会话指针，不生成新的 Thread 或 Turn */
export async function readSession(dataDir: string): Promise<ExampleSession> {
  return sessionSchema.parse(JSON.parse(await readFile(path.join(dataDir, 'session.json'), 'utf8')))
}
