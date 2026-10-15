import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listen } from '@elmino/server/node'
import { createId, throwSettledErrors } from '@elmino/shared'
import { runRemoteTask } from '../client/run'
import { createModel } from '../model/deepseek'
import { createServer } from '../server/create'
import { createStorage } from '../storage/storage'

/** 一个进程启动真实端口与独立 SDK 客户端，演示完整远程调用 */
export async function runExample() {
  const model = createModel()
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-server-sdk-'))
  const workspaceRoot = path.join(dataDir, 'workspace')
  await mkdir(workspaceRoot)
  const store = await createStorage(dataDir)
  const key = process.env.SERVER_KEY || createId('example')
  const server = createServer(model, store, workspaceRoot, key)
  let http: Awaited<ReturnType<typeof listen>> | undefined
  try {
    http = await listen({ server })
    console.log('Server 地址：', http.url)
    await runRemoteTask(http.url, key)
    console.log('示例数据目录：', dataDir)
  }
  finally {
    const execution = await Promise.allSettled([server.close()])
    const transport = await Promise.allSettled([http?.close()])
    const storage = await Promise.allSettled([store.close()])
    throwSettledErrors([...execution, ...transport, ...storage], '关闭远程示例失败', true)
  }
}
