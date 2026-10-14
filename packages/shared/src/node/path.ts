import path from 'node:path'

/** -------------------- 类型 -------------------- */
/** 跨平台路径判断所需的 Node path 最小接口 */
type PathPlatform = Pick<
  typeof path,
  'isAbsolute' | 'relative' | 'resolve' | 'sep'
>

/** -------------------- 核心函数 -------------------- */
/**
 * 判断目标路径是否位于指定根目录内
 */
export function isPathWithin(
  root: string,
  target: string,
  pathPlatform: PathPlatform = path,
) {
  const relative = pathPlatform.relative(
    pathPlatform.resolve(root),
    pathPlatform.resolve(target),
  )

  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${pathPlatform.sep}`)
    && !pathPlatform.isAbsolute(relative)
  )
}

/**
 * 把 Windows 路径转换为可稳定回传给工具的正斜杠格式
 */
export function normalizePathForDisplay(
  filePath: string,
  pathPlatform: PathPlatform = path,
) {
  return pathPlatform.sep === '\\'
    ? filePath.replaceAll('\\', '/')
    : filePath
}
