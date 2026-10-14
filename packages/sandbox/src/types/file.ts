/** -------------------- 类型 -------------------- */
/** 沙箱文件动作类型 */
export type SandboxFileAction = 'read' | 'list' | 'write' | 'remove' | 'edit' | 'glob' | 'grep'

/** 沙箱文件元信息 */
export interface SandboxFileInfo {
  /** 文件路径 */
  path: string
  /** 是否目录 */
  isDir: boolean
  /** 是否符号链接 */
  isSymbolicLink: boolean
  /** 文件大小 */
  size?: number
  /** 最近修改时间 */
  modifiedAt?: string
}

/** 沙箱文本读取结果 */
export interface SandboxReadResult {
  /** 失败时的错误信息 */
  error?: string
  /** 成功时的文本内容 */
  content?: string
  /** 实际返回的首行行号，从 1 开始 */
  lineStart?: number
  /** 实际返回的末行行号，从 1 开始 */
  lineEnd?: number
  /** 文件总行数 */
  totalLines?: number
  /** 是否仍有内容未返回 */
  truncated?: boolean
}

/** 沙箱列表结果 */
export interface SandboxListResult {
  /** 失败时的错误信息 */
  error?: string
  /** 成功时的文件列表 */
  files?: SandboxFileInfo[]
  /** 结果是否因数量限制被截断 */
  truncated?: boolean
}

/** 沙箱写入结果 */
export interface SandboxWriteResult {
  /** 预期版本不匹配时不写入文件 */
  conflict?: boolean
  /** 失败时的错误信息 */
  error?: string
  /** 成功写入的文件路径 */
  path?: string
  /** 成功写入或冲突时的当前内容版本 */
  revision?: string
}

/** 沙箱删除结果 */
export interface SandboxRemoveResult {
  /** 失败时的错误信息 */
  error?: string
  /** 删除的文件路径 */
  path?: string
}

/** 沙箱替换结果 */
export interface SandboxEditResult {
  /** 失败时的错误信息 */
  error?: string
  /** 成功编辑的文件路径 */
  path?: string
  /** 替换次数 */
  occurrences?: number
}

/** 沙箱文件操作通用选项 */
export interface SandboxFileOperationOptions {
  /** 文件操作超时时间，单位秒 */
  timeout?: number
  /** 外部运行取消信号 */
  signal?: AbortSignal
  /** 是否跟随最终路径的符号链接，默认跟随 */
  followLeaf?: boolean
}

/** 沙箱文件删除选项 */
export interface SandboxRemoveOptions extends SandboxFileOperationOptions {
  /** 是否移入系统回收站，默认永久删除 */
  trash?: boolean
}

/** 沙箱文件搜索选项 */
export interface SandboxGlobOptions extends SandboxFileOperationOptions {
  /** 最大返回条数，默认 100，null 表示返回完整结果 */
  limit?: number | null
  /** 从搜索结果中排除的 glob 模式 */
  exclude?: string[]
  /** 是否忽略 glob 模式大小写 */
  ignoreCase?: boolean
}

/** 沙箱文件写入选项 */
export interface SandboxWriteOptions extends SandboxFileOperationOptions {
  /** 仅在当前文件内容版本匹配时写入 */
  expectedRevision?: string
}

/** 沙箱替换选项 */
export interface SandboxEditOptions extends SandboxFileOperationOptions {
  /** 是否替换全部匹配项；默认只允许唯一匹配 */
  replaceAll?: boolean
}

/** 沙箱 grep 命中行 */
export interface SandboxGrepMatch {
  /** 命中文件路径 */
  path: string
  /** 命中行号 */
  line: number
  /** 命中行文本 */
  text: string
}

/** 沙箱 grep 结果 */
export interface SandboxGrepResult {
  /** 失败时的错误信息 */
  error?: string
  /** 成功时的命中列表 */
  matches?: SandboxGrepMatch[]
  /** 结果是否因数量限制被截断 */
  truncated?: boolean
}

/** 文件动作审批预检输入 */
export interface SandboxFileReviewInput {
  /** 沙箱动作类型 */
  kind: 'file'
  /** 文件动作类型 */
  action: SandboxFileAction
  /** 文件路径或搜索目录 */
  filePath?: string
}

/** 沙箱文件系统能力 */
export interface SandboxFiles {
  /** 判断文件或目录是否存在 */
  exists: (filePath: string) => Promise<boolean>
  /** 列出目录下一级文件 */
  list: (
    filePath: string,
    options?: SandboxFileOperationOptions,
  ) => Promise<SandboxListResult>
  /** 读取文本文件 */
  read: (
    filePath: string,
    offset?: number,
    limit?: number,
    options?: SandboxFileOperationOptions,
  ) => Promise<SandboxReadResult>
  /** 读取二进制文件 */
  readBytes: (
    filePath: string,
    options?: SandboxFileOperationOptions,
  ) => Promise<Uint8Array>
  /** 写入文本文件 */
  write: (
    filePath: string,
    content: string,
    options?: SandboxWriteOptions,
  ) => Promise<SandboxWriteResult>
  /** 写入二进制文件 */
  writeBytes: (
    filePath: string,
    content: Uint8Array,
    options?: SandboxWriteOptions,
  ) => Promise<SandboxWriteResult>
  /** 在允许写入范围内移动文件或目录，不覆盖已有目标 */
  move: (
    source: string,
    target: string,
    options?: SandboxFileOperationOptions,
  ) => Promise<SandboxWriteResult>
  /** 删除文件或目录，可显式移入回收站 */
  remove: (
    filePath: string,
    options?: SandboxRemoveOptions,
  ) => Promise<SandboxRemoveResult>
  /** 替换文本文件中的内容 */
  edit: (
    filePath: string,
    oldText: string,
    newText: string,
    options?: SandboxEditOptions,
  ) => Promise<SandboxEditResult>
  /** 按 glob 搜索文件 */
  glob: (
    pattern: string,
    filePath?: string,
    options?: SandboxGlobOptions,
  ) => Promise<SandboxListResult>
  /** 搜索文件内容 */
  grep: (
    pattern: string,
    filePath?: string,
    include?: string,
    options?: SandboxFileOperationOptions,
  ) => Promise<SandboxGrepResult>
}
