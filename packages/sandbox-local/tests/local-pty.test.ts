import os from 'node:os'
import { LocalPtyHost } from '@elmino/sandbox-local'
import { expect, test, vi } from 'vitest'
import { TEST_ENV } from './support/sandbox'

/** -------------------- 测试 -------------------- */
test('LocalPtyHost 统一管理输入、尺寸、游标重放与退出', async () => {
  const host = LocalPtyHost.create()
  const env = {
    ...TEST_ENV,
    ELMINO_PTY_ENV: 'snapshot',
  }
  const terminal = await host.open({
    args: [
      '-e',
      'process.stdin.once("data", data => { process.stdout.write(process.env.ELMINO_PTY_ENV + ":" + data); process.exit(0) }); process.stdin.resume(); setTimeout(() => process.exit(1), 1000)',
    ],
    cols: 80,
    cwd: os.tmpdir(),
    env,
    program: process.execPath,
    rows: 24,
  })
  const live = vi.fn()
  const subscription = host.subscribe(terminal.id, 0, live)

  host.resize(terminal.id, { cols: 120, rows: 40 })
  host.write(terminal.id, 'hello\r')

  await expect(terminal.completion).resolves.toMatchObject({ code: 0 })
  const snapshot = host.snapshot(terminal.id)

  expect(snapshot.events.map(event => event.cursor)).toEqual(
    snapshot.events.map((_, index) => index + 1),
  )
  expect(snapshot.events.some(event => (
    event.type === 'output' && event.data.includes('snapshot:hello')
  ))).toBe(true)
  expect(snapshot.events.at(-1)).toMatchObject({ type: 'exit' })
  expect(live).toHaveBeenCalled()

  subscription.dispose()
  await host.close(terminal.id)
  expect(() => host.snapshot(terminal.id)).toThrow('PTY 会话不存在')
})
