import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { isPathWithin } from '@elmino/shared/node'

/** -------------------- 核心类 -------------------- */
/**
 * 判断本地沙箱文件是否允许写入
 */
export class LocalSandboxPermissions {
  /** 当前 Sandbox 的规范工作目录 */
  private readonly _cwd: string

  /** 允许直接写入的本地根目录 */
  private readonly _roots: string[]

  /** 本次临时写入授权路径 */
  private readonly _grants: string[]

  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建本地文件权限判断
   */
  public static create(cwd: string, roots: string[], grants: string[]) {
    return new LocalSandboxPermissions(cwd, roots, grants)
  }

  /**
   * 保存允许写入的根目录和临时授权
   */
  private constructor(cwd: string, roots: string[], grants: string[]) {
    this._cwd = this._resolveCanonicalPath(cwd)
    this._roots = roots.map(root => this._resolveCanonicalPath(root))
    this._grants = grants.map((filePath) => {
      try {
        return this._resolveCanonicalPath(filePath)
      }
      catch {
        // 无法解析的授权不能扩大真实写入范围，但保留路径供后续重新评审
        return path.resolve(filePath)
      }
    })
  }

  /**
   * 判断路径是否位于当前 Sandbox 的可信根目录内
   */
  public containsPath(filePath: string, followLeaf = true) {
    try {
      const resolved = this._resolveCanonicalPath(filePath, followLeaf)

      return this._roots.some(root => isPathWithin(root, resolved))
    }
    catch {
      return false
    }
  }

  /**
   * 判断路径是否位于允许写入的根目录或本次临时授权内
   */
  public canWrite(filePath: string, followLeaf = true) {
    try {
      const resolved = this._resolveCanonicalPath(filePath, followLeaf)

      return this._roots.some(root => isPathWithin(root, resolved))
        || this._grants.some(grant => path.relative(grant, resolved) === '')
    }
    catch {
      return false
    }
  }

  /**
   * 基于规范工作目录判断工具路径位于根本身、后代还是外部
   */
  public classifyWorkspacePath(filePath: string, followLeaf = true) {
    const resolved = path.resolve(this._cwd, filePath)

    try {
      const canonical = this._resolveCanonicalPath(resolved, followLeaf)
      const relation: 'root' | 'descendant' | 'outside'
        = path.relative(this._cwd, canonical) === ''
          ? 'root'
          : isPathWithin(this._cwd, canonical) ? 'descendant' : 'outside'

      return { relation, resolved }
    }
    catch {
      // 无法解析真实路径时保持外部路径的保守审批和临时授权行为
      return { relation: 'outside' as const, resolved }
    }
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 解析真实路径，并为尚未创建的尾部路径保留原始层级
   */
  private _resolveCanonicalPath(filePath: string, followLeaf = true) {
    const resolved = path.resolve(filePath)
    const suffix = followLeaf ? [] : [path.basename(resolved)]
    let existingPath = followLeaf ? resolved : path.dirname(resolved)

    while (!this._pathEntryExists(existingPath)) {
      const parent = path.dirname(existingPath)

      if (parent === existingPath)
        break

      suffix.unshift(path.basename(existingPath))
      existingPath = parent
    }

    try {
      return path.resolve(realpathSync.native(existingPath), ...suffix)
    }
    catch (error) {
      throw new Error(`无法解析文件真实路径: ${filePath}`, { cause: error })
    }
  }

  /**
   * 判断路径条目本身是否存在，不跟随最终符号链接
   */
  private _pathEntryExists(filePath: string) {
    try {
      lstatSync(filePath)
      return true
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (code === 'ENOENT' || code === 'ENOTDIR')
        return false

      throw error
    }
  }
}
