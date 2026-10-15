/**
 * Tutorial 01 · 最简单的 Agent · 从这里开始阅读
 *
 * 本例要讲：用 5 个必填参数完成一次真实模型与工具调用
 * 运行命令：pnpm example:basic-agent
 * 预期结果：执行结束后打印模型回复，便签保存在终端给出的数据目录中
 * 模型凭据通过环境变量读取；启动命令可加载当前示例根目录的 .env
 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runAgent } from '@elmino/engine'
import { extractText } from '@elmino/llm'
import { sqliteStore } from '@elmino/store-sqlite'
import { writer } from '../agent/agent'
import { createModel } from '../model/deepseek'

/** 最简单的调用只传必填参数，等待任务结束后展示回复 */
export async function runExample() {
  // 第 1 步：准备本次任务的工作区；临时目录让示例不会覆盖已有项目文件
  const dataDir = await mkdtemp(path.join(tmpdir(), 'elmino-basic-agent-'))
  const rootDir = path.join(dataDir, 'workspace')
  await mkdir(rootDir)
  // 第 2 步：只传必填参数，runAgent 会创建新线程并管理 Engine 的创建与释放
  const result = await runAgent({
    agent: writer,
    model: createModel(),
    // 这里只定义存储配置，首次运行时才打开，任务退出前自动释放
    store: sqliteStore({ dataDir }),
    // id 是稳定工作区身份；rootDir 是工具相对路径的基准，不是数据库目录
    workspace: { id: 'example', rootDir },
    input: '请使用 write_note 将 Hello from elmino 写入 result.txt',
  })
  // 第 3 步：Promise 返回不一定表示成功；模型失败或等待交互也有持久化状态
  if (result.status !== 'completed')
    throw new Error(result.errorMessage ?? '任务尚未完成')
  // 最简单的用法只等最终结果，不订阅增量；思考和实时输出见 Full 教程
  console.log('回复：', result.message ? extractText(result.message) : '')
  console.log('示例数据目录：', dataDir)
}
