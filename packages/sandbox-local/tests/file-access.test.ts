import type * as FsPromises from 'node:fs/promises'
import { LocalSandboxFiles, LocalSandboxPermissions } from '@elmino/sandbox-local'
import { expect, test, vi } from 'vitest'

const { access } = vi.hoisted(() => ({ access: vi.fn() }))

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof FsPromises>(),
  access,
}))

test('file existence reports known missing paths and preserves filesystem failures', async () => {
  const cwd = process.cwd()
  const files = LocalSandboxFiles.create(LocalSandboxPermissions.create(cwd, [cwd], []), cwd, {})

  for (const code of ['ENOENT', 'ENOTDIR']) {
    access.mockRejectedValueOnce(Object.assign(new Error('missing'), { code }))
    expect(await files.exists('missing')).toBe(false)
  }
  for (const code of ['EACCES', 'EIO']) {
    const error = Object.assign(new Error('storage failure'), { code })

    access.mockRejectedValueOnce(error)
    await expect(files.exists('unavailable')).rejects.toBe(error)
  }
})
