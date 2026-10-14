import type {
  EnvVars,
  SandboxEditOptions,
  SandboxFileInfo,
  SandboxFileOperationOptions,
  SandboxFiles,
  SandboxGlobOptions,
  SandboxListResult,
  SandboxRemoveOptions,
  SandboxWriteOptions,
} from '@elmino/sandbox'
import type * as NodeChildProcess from 'node:child_process'
import type { Dirent } from 'node:fs'
import type { LocalSandboxPermissions } from './permissions.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  DEFAULT_SANDBOX_FILE_TIMEOUT_SECONDS,
  MAX_SANDBOX_FILE_TIMEOUT_SECONDS,
  SANDBOX_READ_MAX_BYTES,
  SANDBOX_READ_MAX_LINE_LENGTH,
  SANDBOX_READ_MAX_LINES,
} from '@elmino/sandbox'
import { KeyedMutex } from '@elmino/shared'
import { normalizePathForDisplay } from '@elmino/shared/node'
import { rgPath } from '@vscode/ripgrep'
import trash from 'trash'

/** -------------------- 类型 -------------------- */
/** 本地文件操作计时器 */
interface LocalOperationTimer {
  /** 超时秒数，用于错误提示 */
  timeoutSeconds: number
  /** 单调时钟截止时间 */
  deadline: number
  /** 外部运行取消信号 */
  signal?: AbortSignal
}

/** -------------------- 常量 -------------------- */
/** 通过 CommonJS 入口取得 Electron 注入 ASAR 重定向的子进程实现 */
const { execFile } = createRequire(import.meta.url)('node:child_process') as typeof NodeChildProcess
/** 单次文件搜索最大返回条数 */
const MAX_FILE_SEARCH_RESULTS = 100
/** 单次文件搜索最大缓冲区 */
const MAX_FILE_SEARCH_BUFFER_BYTES = 16 * 1024 * 1024
/**
 * 本地沙箱文件系统
 */
export class LocalSandboxFiles implements SandboxFiles {
  /** 跨 Sandbox 实例共享的文件写锁 */
  private static readonly _mutex = new KeyedMutex()

  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建本地文件系统
   */
  public static create(
    permissions: LocalSandboxPermissions,
    cwd: string,
    env: EnvVars,
  ) {
    return new LocalSandboxFiles(permissions, cwd, env)
  }

  /**
   * 保存文件写入边界
   */
  private constructor(
    private readonly _permissions: LocalSandboxPermissions,
    private readonly _cwd: string,
    private readonly _env: EnvVars,
  ) {}

  /**
   * 判断文件或目录是否存在
   */
  public async exists(filePath: string) {
    try {
      await access(this._resolve(filePath))
      return true
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (code === 'ENOENT' || code === 'ENOTDIR')
        return false
      throw error
    }
  }

  /**
   * 列出目录下一级文件
   */
  public list(filePath: string, options: SandboxFileOperationOptions = {}) {
    const timer = this._createFileTimer(options)

    try {
      return Promise.resolve(this._list(
        filePath,
        timer,
        options.followLeaf !== false,
      ))
    }
    catch (error) {
      return Promise.resolve({
        error: error instanceof Error
          ? error.message
          : String(error),
      })
    }
  }

  /**
   * 读取文本文件
   */
  public async read(
    filePath: string,
    offset = 0,
    limit?: number,
    options: SandboxFileOperationOptions = {},
  ) {
    const timer = this._createFileTimer(options)

    try {
      return await this._read(
        filePath,
        offset,
        limit,
        timer,
        options.followLeaf !== false,
      )
    }
    catch (error) {
      return {
        error: error instanceof Error
          ? error.message
          : String(error),
      }
    }
  }

  /**
   * 读取二进制文件
   */
  public readBytes(
    filePath: string,
    options: SandboxFileOperationOptions = {},
  ) {
    const resolved = this._resolve(filePath)
    const timer = this._createFileTimer(options)
    this._assertLeaf(resolved, filePath, options.followLeaf !== false)

    return this._withFileTimeout(readFile(resolved), timer)
  }

  /**
   * 写入文本文件
   */
  public write(
    filePath: string,
    content: string,
    options: SandboxWriteOptions = {},
  ) {
    return this.writeBytes(
      filePath,
      new TextEncoder().encode(content),
      options,
    )
  }

  /**
   * 写入二进制文件
   */
  public writeBytes(
    filePath: string,
    content: Uint8Array,
    options: SandboxWriteOptions = {},
  ) {
    const timer = this._createFileTimer(options)

    return LocalSandboxFiles._mutex.runExclusive(this._lockKey(filePath), async () => {
      try {
        const followLeaf = options.followLeaf !== false

        if (options.expectedRevision) {
          const resolved = this._resolveWrite(filePath, followLeaf)

          this._assertFileTimer(timer)
          this._assertLeaf(resolved, filePath, followLeaf)

          if (!existsSync(resolved))
            return { conflict: true }

          const current = await this._withFileTimeout(readFile(resolved), timer)
          const revision = this._revision(current)

          if (revision !== options.expectedRevision)
            return { conflict: true, revision }
        }

        const result = await this._writeBytes(
          filePath,
          content,
          timer,
          followLeaf,
        )

        return { ...result, revision: this._revision(content) }
      }
      catch (error) {
        return {
          error: error instanceof Error
            ? error.message
            : String(error),
        }
      }
    })
  }

  /**
   * 校验源与目标的写入边界并整体移动，已有目标始终保留
   */
  public move(
    source: string,
    target: string,
    options: SandboxFileOperationOptions = {},
  ) {
    const timer = this._createFileTimer(options)
    const [first, second] = [this._lockKey(source), this._lockKey(target)].sort()
    if (first === second)
      return Promise.resolve({ error: '源路径和目标路径不能相同' })

    // 两个路径以固定顺序加锁，避免相反方向的并发移动互相等待
    return LocalSandboxFiles._mutex.runExclusive(first!, () => (
      LocalSandboxFiles._mutex.runExclusive(second!, async () => {
        try {
          const from = this._resolveWrite(source, false)
          const to = this._resolveWrite(target, false)
          this._assertFileTimer(timer)
          if (lstatSync(to, { throwIfNoEntry: false }))
            return { error: '目标文件或目录已存在' }
          await this._withFileTimeout(mkdir(path.dirname(to), { recursive: true }), timer)
          // 创建父目录后再次校验真实路径，不沿用创建前的权限结论
          this._resolveWrite(target, false)
          this._assertFileTimer(timer)
          // rename 不支持取消，开始后等待真实结果，避免超时返回失败但目录随后已移动
          await rename(from, to)
          return { path: to }
        }
        catch (error) {
          return {
            error: error instanceof Error
              ? error.message
              : String(error),
          }
        }
      })
    ))
  }

  /**
   * 删除文件或目录
   */
  public remove(
    filePath: string,
    options: SandboxRemoveOptions = {},
  ) {
    const timer = this._createFileTimer(options)

    return LocalSandboxFiles._mutex.runExclusive(this._lockKey(filePath), async () => {
      try {
        // 删除最终链接时只校验其真实父目录，避免误删链接指向的目录
        const resolved = this._resolveWrite(filePath, false)
        this._assertFileTimer(timer)

        try {
          lstatSync(resolved)
        }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code

          if (code === 'ENOENT' || code === 'ENOTDIR')
            return { error: `文件或目录不存在: ${filePath}` }

          throw error
        }

        // 回收站失败直接返回错误，不降级为永久删除
        await this._withFileTimeout(
          options.trash
            ? trash(resolved, { glob: false })
            : rm(resolved, { force: false, recursive: true }),
          timer,
        )

        return { path: resolved }
      }
      catch (error) {
        return {
          error: error instanceof Error
            ? error.message
            : String(error),
        }
      }
    })
  }

  /**
   * 替换文本文件中的内容
   */
  public edit(
    filePath: string,
    oldText: string,
    newText: string,
    options: SandboxEditOptions = {},
  ) {
    if (!oldText)
      return Promise.resolve({ error: '要替换的文本不能为空' })

    const timer = this._createFileTimer(options)

    return LocalSandboxFiles._mutex.runExclusive(this._lockKey(filePath), async () => {
      try {
        const followLeaf = options.followLeaf !== false
        const read = await this._read(
          filePath,
          0,
          undefined,
          timer,
          followLeaf,
        )

        if (read.error || read.content === undefined)
          return { error: read.error ?? `文件不存在: ${filePath}` }

        const occurrences = read.content.split(oldText).length - 1

        if (occurrences === 0)
          return { error: `未找到要替换的文本: ${filePath}` }

        if (!options.replaceAll && occurrences > 1)
          return { error: `找到 ${occurrences} 处要替换的文本，请扩大 oldText 上下文或传 replaceAll: true` }

        const write = await this._writeBytes(
          filePath,
          new TextEncoder().encode(options.replaceAll
            ? read.content.replaceAll(oldText, newText)
            : read.content.replace(oldText, newText)),
          timer,
          followLeaf,
        )

        return {
          path: write.path,
          occurrences,
        }
      }
      catch (error) {
        return {
          error: error instanceof Error
            ? error.message
            : String(error),
        }
      }
    })
  }

  /**
   * 按 glob 搜索文件
   */
  public async glob(
    pattern: string,
    filePath = '.',
    options: SandboxGlobOptions = {},
  ) {
    const timer = this._createFileTimer(options)

    try {
      const base = this._resolve(filePath)
      const normalizedPattern = normalizePathForDisplay(pattern)

      if (!existsSync(base))
        return { error: `搜索路径不存在: ${filePath}` }
      if (!statSync(base).isDirectory())
        return { error: `搜索路径不是目录: ${filePath}` }

      const [allowedFiles, patternFiles] = await Promise.all([
        this._listRipgrepFiles(base, timer, undefined, options),
        this._listRipgrepFiles(base, timer, normalizedPattern, options),
      ])
      const allowed = new Set(allowedFiles)
      const matches = patternFiles.filter(file => allowed.has(file))
      const limit = options.limit === null
        ? undefined
        : options.limit ?? MAX_FILE_SEARCH_RESULTS

      return {
        files: matches
          .slice(0, limit)
          .map(file => ({
            path: path.resolve(base, file),
            isDir: false,
            isSymbolicLink: false,
          })),
        truncated: limit !== undefined && matches.length > limit,
      }
    }
    catch (error) {
      return {
        error: error instanceof Error
          ? error.message
          : String(error),
      }
    }
  }

  /**
   * 搜索文件内容
   */
  public async grep(
    pattern: string,
    filePath = '.',
    include?: string,
    options: SandboxFileOperationOptions = {},
  ) {
    const timer = this._createFileTimer(options)

    try {
      const base = this._resolve(filePath)
      const normalizedInclude = include
        ? normalizePathForDisplay(include)
        : undefined

      if (!existsSync(base))
        return { error: `搜索路径不存在: ${filePath}` }

      const dir = statSync(base).isDirectory()
        ? base
        : path.dirname(base)
      const target = dir === base
        ? '.'
        : path.basename(base)
      const [allowedFiles, output] = await Promise.all([
        normalizedInclude && dir === base
          ? this._listRipgrepFiles(dir, timer)
          : Promise.resolve(undefined),
        this._runRipgrep(
          dir,
          [
            '--no-config',
            '--json',
            '--hidden',
            '--no-messages',
            '--max-columns=2000',
            '--max-columns-preview',
            ...(normalizedInclude ? [`--glob=${normalizedInclude}`] : []),
            '--glob=!**/.git/**',
            '--',
            pattern,
            target,
          ],
          timer,
          pattern,
        ),
      ])
      const allowed = allowedFiles ? new Set(allowedFiles) : undefined
      const matches = output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        const record = JSON.parse(line) as {
          type?: string
          data?: {
            path?: { text?: string }
            lines?: { text?: string }
            line_number?: number
          }
        }

        if (record.type !== 'match')
          return []

        const file = record.data?.path?.text
        const lineNumber = record.data?.line_number
        const text = record.data?.lines?.text

        if (!file || !lineNumber || text === undefined)
          throw new Error('ripgrep 返回了无法识别的匹配结果')

        const normalizedFile = this._normalizeRelativeSearchPath(file)

        if (allowed && !allowed.has(normalizedFile))
          return []

        return [{
          path: path.resolve(dir, normalizedFile),
          line: lineNumber,
          text: text.replace(/\r?\n$/, ''),
        }]
      })

      return {
        matches: matches.slice(0, MAX_FILE_SEARCH_RESULTS),
        truncated: matches.length > MAX_FILE_SEARCH_RESULTS,
      }
    }
    catch (error) {
      return {
        error: error instanceof Error
          ? error.message
          : String(error),
      }
    }
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 读取目录下一级文件
   */
  private _list(
    filePath: string,
    timer: LocalOperationTimer,
    followLeaf: boolean,
  ): SandboxListResult {
    const dirPath = this._resolve(filePath)
    this._assertFileTimer(timer)

    if (!existsSync(dirPath))
      return { error: `目录不存在: ${filePath}` }

    this._assertLeaf(dirPath, filePath, followLeaf)

    if (!statSync(dirPath).isDirectory())
      return { error: `不是目录: ${filePath}` }

    return {
      files: readdirSync(dirPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => {
          this._assertFileTimer(timer)
          return this._fileInfo(dirPath, entry)
        }),
    }
  }

  /**
   * 读取文本文件
   */
  private async _read(
    filePath: string,
    offset: number,
    limit: number | undefined,
    timer: LocalOperationTimer,
    followLeaf: boolean,
  ) {
    const resolved = this._resolve(filePath)
    this._assertFileTimer(timer)

    if (!existsSync(resolved))
      return { error: `文件不存在: ${filePath}` }

    this._assertLeaf(resolved, filePath, followLeaf)

    if (statSync(resolved).isDirectory())
      return { error: `这是目录: ${filePath}` }

    const text = await this._withFileTimeout(readFile(resolved, 'utf8'), timer)

    const lines = text.split(/\r?\n/)
    const start = Math.max(0, offset)
    const maxLines = Math.min(limit ?? SANDBOX_READ_MAX_LINES, SANDBOX_READ_MAX_LINES)
    const selected: string[] = []
    let bytes = 0

    for (let index = start; index < lines.length && selected.length < maxLines; index += 1) {
      this._assertFileTimer(timer)

      const source = lines[index] ?? ''
      const line = source.length > SANDBOX_READ_MAX_LINE_LENGTH
        ? `${source.slice(0, SANDBOX_READ_MAX_LINE_LENGTH)}...（该行已截断）`
        : source
      const size = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0)

      if (bytes + size > SANDBOX_READ_MAX_BYTES)
        break

      selected.push(line)
      bytes += size
    }

    const lineStart = Math.min(start + 1, lines.length)
    const lineEnd = selected.length > 0 ? start + selected.length : start
    const content = selected.join('\n')
    const totalLines = lines.length
    const truncated = lineEnd < lines.length

    return { content, lineStart, lineEnd, totalLines, truncated }
  }

  /**
   * 写入二进制文件
   */
  private async _writeBytes(
    filePath: string,
    content: Uint8Array,
    timer: LocalOperationTimer,
    followLeaf: boolean,
  ) {
    const resolved = this._resolveWrite(filePath, followLeaf)
    this._assertFileTimer(timer)
    this._assertLeaf(resolved, filePath, followLeaf)

    await this._withFileTimeout(mkdir(path.dirname(resolved), { recursive: true }), timer)
    await this._withFileTimeout(writeFile(resolved, content), timer)

    return { path: resolved }
  }

  /**
   * 创建文件操作计时器
   */
  private _createFileTimer(options: SandboxFileOperationOptions) {
    const timeoutSeconds = typeof options.timeout !== 'number'
      || !Number.isFinite(options.timeout)
      || options.timeout <= 0
      ? DEFAULT_SANDBOX_FILE_TIMEOUT_SECONDS
      : Math.min(options.timeout, MAX_SANDBOX_FILE_TIMEOUT_SECONDS)

    return {
      timeoutSeconds,
      deadline: performance.now() + timeoutSeconds * 1000,
      signal: options.signal,
    }
  }

  /**
   * 检查文件操作是否已经超时
   */
  private _assertFileTimer(timer: LocalOperationTimer) {
    if (timer.signal?.aborted)
      throw new Error('文件操作已中断')

    if (performance.now() > timer.deadline)
      throw new Error(`文件操作超过 ${timer.timeoutSeconds} 秒`)
  }

  /**
   * 为异步文件操作套用剩余超时
   */
  private async _withFileTimeout<T>(
    promise: Promise<T>,
    timer: LocalOperationTimer,
  ) {
    this._assertFileTimer(timer)
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`文件操作超过 ${timer.timeoutSeconds} 秒`)),
            Math.max(0, timer.deadline - performance.now()),
          )
        }),
        new Promise<T>((_, reject) => {
          if (!timer.signal)
            return

          abort = () => reject(new Error('文件操作已中断'))
          timer.signal.addEventListener('abort', abort, { once: true })
        }),
      ])
    }
    finally {
      if (timeoutId)
        clearTimeout(timeoutId)
      if (abort)
        timer.signal?.removeEventListener('abort', abort)
    }
  }

  /**
   * 读取目录项对应的沙箱文件信息
   */
  private _fileInfo(
    dirPath: string,
    entry: Dirent,
  ): SandboxFileInfo {
    const childPath = path.join(dirPath, entry.name)
    const stat = lstatSync(childPath)
    const isDir = stat.isDirectory()

    return {
      path: isDir ? `${childPath}/` : childPath,
      isDir,
      isSymbolicLink: stat.isSymbolicLink(),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    }
  }

  /**
   * 在受保护操作中拒绝最终路径为符号链接
   */
  private _assertLeaf(
    resolved: string,
    filePath: string,
    followLeaf: boolean,
  ) {
    if (followLeaf)
      return

    try {
      if (lstatSync(resolved).isSymbolicLink())
        throw new Error(`不允许访问符号链接: ${filePath}`)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return

      throw error
    }
  }

  /**
   * 将输入路径解析为本地路径
   */
  private _resolve(filePath: string) {
    return path.resolve(this._cwd, filePath)
  }

  /**
   * 返回跨 Sandbox 实例稳定的文件锁键
   */
  private _lockKey(filePath: string) {
    return this._resolve(filePath)
  }

  /**
   * 将输入路径解析到允许写入的本地路径
   */
  private _resolveWrite(filePath: string, followLeaf = true) {
    const resolved = this._resolve(filePath)

    if (!this._permissions.canWrite(resolved, followLeaf))
      throw new Error(`文件路径不在沙箱允许写入范围内: ${filePath}`)

    return resolved
  }

  /**
   * 使用 ripgrep 列出匹配 glob 且未被忽略的相对文件路径
   */
  private async _listRipgrepFiles(
    cwd: string,
    timer: LocalOperationTimer,
    pattern?: string,
    options: SandboxGlobOptions = {},
  ) {
    const excludes = options.exclude ?? []
    const output = await this._runRipgrep(
      cwd,
      [
        '--no-config',
        '--files',
        '--hidden',
        '--no-require-git',
        ...(pattern
          ? [`${options.ignoreCase ? '--iglob' : '--glob'}=${pattern}`]
          : []),
        ...excludes.map(item => `--glob=!${normalizePathForDisplay(item)}`),
        '--glob=!**/.git/**',
        '.',
      ],
      timer,
    )

    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map(file => this._normalizeRelativeSearchPath(file))
  }

  /**
   * 计算文件内容的稳定版本
   */
  private _revision(content: Uint8Array) {
    return createHash('sha256').update(content).digest('hex')
  }

  /**
   * 归一化 ripgrep 返回的相对路径
   */
  private _normalizeRelativeSearchPath(filePath: string) {
    return normalizePathForDisplay(filePath)
      .replace(/^(?:\.\/)+/u, '')
      .replace(/^\/+/, '')
  }

  /**
   * 直接执行 ripgrep，不经过用户配置的 shell
   */
  private _runRipgrep(
    cwd: string,
    args: string[],
    timer: LocalOperationTimer,
    pattern?: string,
  ) {
    this._assertFileTimer(timer)
    return new Promise<string>((resolve, reject) => {
      execFile(rgPath, args, {
        cwd,
        encoding: 'utf8',
        env: this._env,
        maxBuffer: MAX_FILE_SEARCH_BUFFER_BYTES,
        signal: timer.signal,
        timeout: Math.max(1, Math.ceil(timer.deadline - performance.now())),
        windowsHide: process.platform === 'win32',
      }, (error, stdout, stderr) => {
        if (!error || error.code === 1) {
          resolve(stdout)
          return
        }

        if (timer.signal?.aborted) {
          reject(new Error('文件操作已中断'))
          return
        }

        if (error.killed) {
          reject(new Error(`文件操作超过 ${timer.timeoutSeconds} 秒`))
          return
        }

        const message = stderr.trim() || error.message

        if (error.code === 2 && pattern && /regex parse error|error parsing regex/i.test(message)) {
          reject(new Error(`搜索正则表达式无效: ${pattern}\n${message}`))
          return
        }

        reject(new Error(message))
      })
    })
  }
}
