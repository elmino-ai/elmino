import type { BlobFiles } from '@elmino/store/local'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalBlobStore, sha256 } from '@elmino/store/local'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let rootDir: string
let files: BlobFiles

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'elmino-blob-'))
  files = {
    exists: async (filePath) => {
      try {
        await access(filePath)
        return true
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return false
        throw error
      }
    },
    readBytes: readFile,
    writeBytes: vi.fn(async (filePath, content) => {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content)
      return {}
    }),
  }
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

test('stores arbitrary binary bytes and reuses identical content across instances', async () => {
  const store = LocalBlobStore.create({ files, rootDir })
  const bytes = new Uint8Array([0, 255, 128, 13, 10])
  const first = await store.write(bytes)
  const second = await LocalBlobStore.create({ files, rootDir }).write(bytes)

  expect(first.sizeBytes).toBe(bytes.byteLength)
  expect(first.blobKey).toMatch(/^sha256\/[\da-f]{2}\/[\da-f]{64}$/)
  expect(second).toEqual(first)
  expect(files.writeBytes).toHaveBeenCalledOnce()
  expect(await store.exists(first.blobKey)).toBe(true)
  expect(new Uint8Array(await store.read(first.blobKey))).toEqual(bytes)
  expect(new Uint8Array(await readFile(path.join(rootDir, first.blobKey)))).toEqual(bytes)
})

test('encodes text as UTF-8 and shares its key with matching byte content', async () => {
  const store = LocalBlobStore.create({ files, rootDir })
  const content = '你好 👋'
  const bytes = new TextEncoder().encode(content)
  const written = await store.write(content)

  expect(written.sizeBytes).toBe(bytes.byteLength)
  expect(await store.write(bytes)).toEqual(written)
  expect(files.writeBytes).toHaveBeenCalledOnce()
  expect(new TextDecoder().decode(await store.read(written.blobKey))).toBe(content)
  expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('reports missing blobs without disguising failed reads', async () => {
  const store = LocalBlobStore.create({ files, rootDir })

  expect(await store.exists('sha256/missing')).toBe(false)
  await expect(store.read('sha256/missing')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rejects keys that escape the blob root before calling file capabilities', async () => {
  const exists = vi.spyOn(files, 'exists')
  const readBytes = vi.spyOn(files, 'readBytes')
  const store = LocalBlobStore.create({ files, rootDir })

  for (const key of ['../outside', path.join(path.dirname(rootDir), 'outside')]) {
    await expect(store.exists(key)).rejects.toThrow('Blob 键越过根目录')
    await expect(store.read(key)).rejects.toThrow('Blob 键越过根目录')
  }
  expect(exists).not.toHaveBeenCalled()
  expect(readBytes).not.toHaveBeenCalled()
})

test('propagates returned or rejected write errors and keeps the blob absent', async () => {
  const written = await LocalBlobStore.create({ files, rootDir }).write('stored')
  const writeBytes = vi.fn<BlobFiles['writeBytes']>()
  const store = LocalBlobStore.create({ files: { ...files, writeBytes }, rootDir })

  writeBytes.mockResolvedValueOnce({ error: 'disk full' })
  await expect(store.write('new')).rejects.toThrow('disk full')
  writeBytes.mockRejectedValueOnce(new Error('permission denied'))
  await expect(store.write('new')).rejects.toThrow('permission denied')
  expect(await store.exists(`sha256/${sha256('new').slice(0, 2)}/${sha256('new')}`)).toBe(false)
  expect(new Uint8Array(await store.read(written.blobKey))).toEqual(new TextEncoder().encode('stored'))
})

test('propagates file access failures rather than treating them as missing blobs', async () => {
  const failure = new Error('storage unavailable')
  const store = LocalBlobStore.create({
    rootDir,
    files: {
      ...files,
      exists: () => Promise.reject(failure),
      readBytes: () => { throw failure },
    },
  })

  await expect(store.exists('sha256/value')).rejects.toBe(failure)
  await expect(store.read('sha256/value')).rejects.toBe(failure)
  await expect(store.write('value')).rejects.toBe(failure)
})
