/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { Promisable, UnknownRecord } from '@elmino/shared'
import { writeFile } from 'node:fs/promises'
import { createPromptTemplate, deepEqual, isPlainRecord, KeyedMutex } from '@elmino/shared'
import { readPromptTemplate } from '@elmino/shared/node'

const record: UnknownRecord = { nested: { value: 1 }, items: ['ok'] }
const pending: Promisable<UnknownRecord> = Promise.resolve(record)
const resolved = await pending
if (!isPlainRecord(resolved) || isPlainRecord([]))
  throw new Error('对象判定无法消费')
if (!deepEqual(resolved, record) || deepEqual(resolved, { nested: { value: 2 } }))
  throw new Error('嵌套比较无法消费')
await writeFile('prompt.md', 'Hello {{name}}')
const prompt = createPromptTemplate({
  template: readPromptTemplate(new URL('./prompt.md', import.meta.url)),
  inputVariables: ['name'],
})
if (prompt.format({ name: 'Elmino' }) !== 'Hello Elmino')
  throw new Error('Node 模板入口无法消费')
const mutex = new KeyedMutex()
if (await mutex.runExclusive('consumer', () => 42) !== 42)
  throw new Error('并发工具入口不可用')
