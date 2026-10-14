import path from 'node:path'
import { isPathWithin, normalizePathForDisplay } from '@elmino/shared/node'
import { expect, test } from 'vitest'

test('path containment follows Windows drive and UNC semantics', () => {
  const win = path.win32

  expect(isPathWithin('C:\\Repo', 'c:/repo/src/main.ts', win)).toBe(true)
  expect(isPathWithin('C:\\Repo\\src', 'c:/REPO/src', win)).toBe(true)
  expect(isPathWithin('C:\\Repo', 'C:\\Repository\\main.ts', win)).toBe(false)
  expect(isPathWithin('C:\\Repo', 'D:\\Repo\\main.ts', win)).toBe(false)
  expect(isPathWithin(
    '\\\\Server\\Share\\Repo',
    '\\\\server\\share\\repo\\src\\main.ts',
    win,
  )).toBe(true)
  expect(isPathWithin(
    '\\\\Server\\Share\\Repo',
    '\\\\server\\other\\repo\\src\\main.ts',
    win,
  )).toBe(false)
})

test('search paths normalize Windows ripgrep output without changing POSIX backslashes', () => {
  expect(normalizePathForDisplay('.\\.\\src\\main.ts', path.win32))
    .toBe('././src/main.ts')
  expect(normalizePathForDisplay('\\src\\main.ts', path.win32))
    .toBe('/src/main.ts')
  expect(normalizePathForDisplay('C:\\Repo\\src\\main.ts', path.win32))
    .toBe('C:/Repo/src/main.ts')
  expect(normalizePathForDisplay('./name\\with.ts', path.posix))
    .toBe('./name\\with.ts')
  expect(normalizePathForDisplay('name\\with.ts', path.posix))
    .toBe('name\\with.ts')
})
