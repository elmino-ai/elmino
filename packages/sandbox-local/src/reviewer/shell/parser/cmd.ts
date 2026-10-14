import type { ShellCommandAssessment, ShellReviewContext } from '../policy/types.js'
import type { ShellReviewer } from './types.js'
import { assessShellCommand, isPermittedShellAssessment } from '../policy/index.js'
import { dangerous, splitCommandSegments, splitShellWords, unknown } from './shared.js'

/** -------------------- 核心类 -------------------- */
/**
 * 解析 Cmd 并交给统一命令策略评估
 */
export class CmdReviewer implements ShellReviewer {
  /** 全局 Cmd 评审器 */
  private static _instance?: CmdReviewer

  /** -------------------- 核心方法 -------------------- */
  /**
   * 返回全局 Cmd 评审器
   */
  public static getInstance() {
    return this._instance ??= new CmdReviewer()
  }

  /**
   * 限制外部直接构造评审器
   */
  private constructor() {}

  /**
   * 解析命令并返回与审批模式无关的事实分类
   */
  public assess(command: string, context: ShellReviewContext): ShellCommandAssessment {
    const source = command.trim()

    if (!source)
      return unknown('Cmd 命令为空')

    if (/[<>]/.test(source))
      return dangerous('Cmd 命令包含重定向')

    if (/%[^%]+%|![^!]+!/.test(source))
      return unknown('Cmd 命令包含变量展开')

    const segments = splitCommandSegments(source, ['\r\n', '&&', '||', '\n', '\r', '&', '|'])

    if (!segments)
      return unknown('Cmd 命令无法解析')

    for (const segment of segments) {
      const args = splitShellWords(segment)

      if (!args || args.length === 0)
        return unknown('Cmd 命令结构不完整')

      const assessment = assessShellCommand(args[0]!, args.slice(1), context, true)

      if (!isPermittedShellAssessment(assessment))
        return assessment
    }

    return { category: 'query' }
  }
}
