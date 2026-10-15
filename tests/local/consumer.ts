/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import type { EnvVars, LocalShell, LocalShellResolver } from '@elmino/sandbox'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEnv,
  findEnvExecutable,
  findEnvExecutableSync,
  listLocalShells,
  loadUserEnv,
  LocalEnv,
  resolveLocalShell,
  resolvePathKey,
  runEnvCommand,
} from '@elmino/local'
import { LocalSandbox } from '@elmino/sandbox-local'

const root = await mkdtemp(join(tmpdir(), 'elmino-local-fixture-'))
const bin = join(root, 'bin')
await mkdir(bin)
const isWindows = process.platform === 'win32'
const probeName = isWindows ? 'elmino-env-probe.exe' : 'elmino-env-probe'
const probe = join(bin, probeName)
if (isWindows) {
  await copyFile(process.execPath, probe)
}
else {
  await writeFile(probe, '#!/bin/sh\nprintf "%s:%s" "$ELMINO_VALUE" "$1"\n', { mode: 0o755 })
  // 沙箱会传入 -lc；测试 Shell 将其转为非登录 /bin/sh，避免读取系统和用户初始化文件
  await writeFile(join(bin, 'sh'), [
    '#!/bin/sh',
    'case "$1" in -lc|-c) shift ;; esac',
    'exec /bin/sh -c "$1"',
    '',
  ].join('\n'), { mode: 0o755 })
}
const appBin = '/elmino-fixture/bin'

const source = { PATH: '/bin', ELMINO_VALUE: 'shell', ABSENT: undefined }
const copied: EnvVars = createEnv(source)
source.ELMINO_VALUE = 'mutated'
assert.equal(copied.ELMINO_VALUE, 'shell')
assert.equal('ABSENT' in copied, false)
assert.equal(Object.isFrozen(copied), true)

let shellEnv: EnvVars = copied
const environment = LocalEnv.create({
  shell: copied,
  launch: { LAUNCH: 'launch' },
  loadShell: () => Promise.resolve(shellEnv),
  platform: 'linux',
})
const before = environment.snapshot()
environment.setApplicationLayer({
  variables: { ELMINO_VALUE: 'application', LAUNCH: 'application' },
  prependPath: [appBin, appBin],
  appendPath: ['/bin'],
})
const initial = environment.snapshot()
assert.notEqual(initial, before)
assert.equal(initial.PATH, `${appBin}:/bin`)
assert.equal(initial.ELMINO_VALUE, 'application')
assert.equal(initial.LAUNCH, 'launch')
assert.equal(Object.isFrozen(initial), true)
assert.equal(before.ELMINO_VALUE, 'shell')
shellEnv = createEnv({ PATH: '/usr/bin:/bin', REFRESHED: 'yes', ELMINO_VALUE: 'refreshed' })
const refreshed = await environment.refresh()
assert.equal(refreshed.PATH, `${appBin}:/usr/bin:/bin`)
assert.equal(refreshed.REFRESHED, 'yes')
assert.equal(refreshed.ELMINO_VALUE, 'application')
assert.equal(initial.REFRESHED, undefined)
environment.setApplicationLayer({ variables: { ELMINO_VALUE: 'replacement' }, prependPath: [appBin] })
assert.equal(environment.snapshot().LAUNCH, 'launch')
assert.equal(environment.snapshot().ELMINO_VALUE, 'replacement')
const staticEnvironment = LocalEnv.create({ shell: copied })
assert.equal(await staticEnvironment.refresh(), staticEnvironment.snapshot())

const windows = LocalEnv.create({ shell: { Path: 'C:\\Tools;c:\\tools;C:\\Windows' }, platform: 'win32' })
windows.setApplicationLayer({ prependPath: ['C:\\Tools'], appendPath: ['C:\\Extra'] })
assert.equal(windows.snapshot().Path, 'C:\\Tools;C:\\Windows;C:\\Extra')
assert.equal(resolvePathKey(windows.snapshot(), 'win32'), 'Path')
assert.equal(resolvePathKey({ Path: 'ignored' }, 'linux'), 'PATH')
assert.equal(Object.keys(windows.snapshot()).filter(key => key.toLowerCase() === 'path').length, 1)
const launched = LocalEnv.create({
  shell: { Path: 'C:\\Tools' },
  launch: { PATH: 'C:\\Launch' },
  platform: 'win32',
})
assert.equal(launched.snapshot().Path, 'C:\\Launch')
assert.equal(launched.snapshot().PATH, undefined)
const loaded = await loadUserEnv({ env: { Path: 'C:\\Explicit', VALUE: 'explicit' }, platform: 'win32' })
assert.deepEqual(loaded, { Path: 'C:\\Explicit', VALUE: 'explicit' })
assert.equal(Object.isFrozen(loaded), true)

const env = LocalEnv.create({ shell: { PATH: bin, ELMINO_VALUE: 'replacement' } }).snapshot()
assert.equal(await findEnvExecutable(probeName, env), probe)
assert.equal(findEnvExecutableSync(probeName, env), probe)
assert.equal(await findEnvExecutable(probe, createEnv({})), probe)
assert.equal(await findEnvExecutable('elmino-nonexistent-program', env), undefined)
assert.equal(findEnvExecutableSync('elmino-nonexistent-program', env), undefined)
assert.equal(await findEnvExecutable(bin, env), undefined)
const args = isWindows
  ? ['-e', 'process.stdout.write(process.env.ELMINO_VALUE + ":" + process.argv[1])', 'literal argument']
  : ['literal argument']
const output = await runEnvCommand(probeName, args, { cwd: root, env })
assert.deepEqual(output, { stderr: '', stdout: 'replacement:literal argument' })
await assert.rejects(runEnvCommand(process.execPath, [
  '-e',
  'process.stderr.write("fixture-failure"); process.exitCode = 4',
], { env }), { message: /fixture-failure/ })
await assert.rejects(runEnvCommand(probe, [], { env, signal: AbortSignal.abort() }), { name: 'AbortError' })
assert.deepEqual(listLocalShells({ accountShell: null, env, platform: 'win32' }).map(item => item.kind), [
  'pwsh',
  'powershell',
  'cmd',
])

if (!isWindows) {
  const resolveShell: LocalShellResolver = (kind, snapshot) => resolveLocalShell({
    accountShell: null,
    env: snapshot,
    preference: kind,
  })
  const shell: LocalShell = resolveShell('sh', env)
  assert.equal(shell.kind, 'sh')
  assert.equal(shell.path, join(bin, 'sh'))
  assert.equal(Object.isFrozen(shell), true)
  assert.equal(listLocalShells({ accountShell: null, env }).some(item => (
    item.kind === shell.kind && item.path === shell.path
  )), true)
  const shellOutput = await runEnvCommand(shell.path, ['-c', 'printf "%s" "$ELMINO_VALUE"'], {
    cwd: root,
    env,
  })
  assert.equal(shellOutput.stdout, 'replacement')

  const sandboxEnvironment = LocalEnv.create({
    shell: { PATH: bin, ELMINO_VALUE: 'sandbox-before' },
    loadShell: () => Promise.resolve(createEnv({ PATH: bin, ELMINO_VALUE: 'sandbox-after' })),
  })
  const oldSnapshot = sandboxEnvironment.snapshot()
  const oldSandbox = LocalSandbox.create({
    cwd: root,
    env: oldSnapshot,
    shell: resolveShell('sh', oldSnapshot),
    resolveShell,
  })
  try {
    const newSnapshot = await sandboxEnvironment.refresh()
    const newSandbox = LocalSandbox.create({
      cwd: root,
      env: newSnapshot,
      shell: resolveShell('sh', newSnapshot),
      resolveShell,
    })
    try {
      const command = 'printf "%s" "$ELMINO_VALUE"'
      const oldResult = await oldSandbox.shell.run(command, { yield: 1 })
      const newResult = await newSandbox.shell.run(command, { yield: 1 })
      assert.equal(oldResult.status, 'exited')
      assert.equal(oldResult.exitCode, 0)
      assert.equal(oldResult.output, 'sandbox-before')
      assert.equal(newResult.status, 'exited')
      assert.equal(newResult.exitCode, 0)
      assert.equal(newResult.output, 'sandbox-after')
      assert.equal(oldSnapshot.ELMINO_VALUE, 'sandbox-before')
    }
    finally { await newSandbox.shell.dispose() }
  }
  finally { await oldSandbox.shell.dispose() }
}
