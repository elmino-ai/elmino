import type { ShellCommandAssessment, ShellReviewContext } from '../policy/types.js'
import type { ShellReviewer } from './types.js'
import { assessShellCommand, isPermittedShellAssessment } from '../policy/index.js'
import { dangerous, splitCommandSegments, splitShellWords, unknown } from './shared.js'

/** -------------------- 核心类 -------------------- */
/**
 * 解析 PowerShell 并交给统一命令策略评估
 */
export class PowershellReviewer implements ShellReviewer {
  /** 全局 PowerShell 评审器 */
  private static _instance?: PowershellReviewer

  /** -------------------- 核心方法 -------------------- */
  /**
   * 返回全局 PowerShell 评审器
   */
  public static getInstance() {
    return this._instance ??= new PowershellReviewer()
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
      return unknown('PowerShell 命令为空')

    if (/[<>]/.test(source))
      return dangerous('PowerShell 命令包含重定向')

    if (/[{}]/.test(source))
      return dangerous('PowerShell 命令包含脚本块')

    if (/(?:^|[^`])\$/.test(source))
      return unknown('PowerShell 命令包含变量或子表达式')

    if (source.includes('`'))
      return unknown('PowerShell 命令包含转义字符')

    const segments = splitCommandSegments(source, ['\r\n', '&&', '||', '\n', '\r', '&', '(', ')', ';', '|'])

    if (!segments)
      return unknown('PowerShell 命令无法解析')

    for (const segment of segments) {
      const args = splitShellWords(segment)

      if (!args || args.length === 0)
        return unknown('PowerShell 命令结构不完整')

      const assessment = assessShellCommand(args[0]!, args.slice(1), context, true)

      if (!isPermittedShellAssessment(assessment))
        return assessment
    }

    return { category: 'query' }
  }
}
