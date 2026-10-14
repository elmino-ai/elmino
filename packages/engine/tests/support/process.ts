import { readFile } from 'node:fs/promises'
import { delay } from '@elmino/shared'

/** -------------------- 辅助函数 -------------------- */
/**
 * 读取 PID 文件中的稳定进程 ID
 */
export async function readProcessId(pidFile: string) {
  let processId: number | undefined

  for (let attempt = 0; attempt < 1_000; attempt++) {
    try {
      processId = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
      await delay(1)
    }
  }

  if (!processId || !Number.isInteger(processId))
    throw new Error(`未读取到有效进程 ID: ${pidFile}`)

  return processId
}

/**
 * 等待指定进程 ID 退出
 */
export async function waitForProcessIdExit(processId: number) {
  if (!Number.isInteger(processId) || processId <= 0)
    throw new Error(`无效进程 ID: ${processId}`)

  for (let attempt = 0; attempt < 1_000; attempt++) {
    try {
      process.kill(processId, 0)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        return
      throw error
    }

    await delay(1)
  }

  throw new Error(`等待进程退出超时: ${processId}`)
}

/**
 * 等待 PID 文件对应的进程退出
 */
export async function waitForProcessExit(pidFile: string) {
  return waitForProcessIdExit(await readProcessId(pidFile))
}
