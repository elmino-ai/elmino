import type { ParseEntry } from 'shell-quote'
import type { ShellCommandAssessment, ShellReviewContext } from '../policy/types.js'
import type { ShellReviewer } from './types.js'
import { parse } from 'shell-quote'
import { assessShellCommand, isPermittedShellAssessment } from '../policy/index.js'
import { dangerous, unknown } from './shared.js'

/** -------------------- 核心类 -------------------- */
/**
 * 解析 POSIX Shell 并交给统一命令策略评估
 */
export class PosixShellReviewer implements ShellReviewer {
  /** 全局 POSIX Shell 评审器 */
  private static _instance?: PosixShellReviewer

  /** -------------------- 核心方法 -------------------- */
  /**
   * 返回全局 POSIX Shell 评审器
   */
  public static getInstance() {
    return this._instance ??= new PosixShellReviewer()
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
      return unknown('POSIX Shell 命令为空')

    if (/(?:^|[^\\])(?:\$\(|`)/.test(source))
      return dangerous('POSIX Shell 命令包含命令替换')

    if (/(?:^|[^\\])\$/.test(source))
      return unknown('POSIX Shell 命令包含变量展开')

    try {
      for (const line of source.split(/\r?\n/)) {
        if (!line.trim())
          continue

        const assessment = this._assessLine(parse(line), context)

        if (!isPermittedShellAssessment(assessment))
          return assessment
      }

      return { category: 'query' }
    }
    catch {
      return unknown('POSIX Shell 命令无法解析')
    }
  }

  /** -------------------- 辅助方法 -------------------- */
  /**
   * 按 shell token 流逐段评估命令
   */
  private _assessLine(entries: ParseEntry[], context: ShellReviewContext): ShellCommandAssessment {
    let args: string[] = []
    let lastOperator = ''

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!

      if (typeof entry === 'string') {
        args.push(entry)
        lastOperator = ''
        continue
      }

      if ('comment' in entry)
        break

      if (!('op' in entry))
        return unknown('POSIX Shell 命令解析结果无法识别')

      if (entry.op === 'glob') {
        args.push(entry.pattern)
        lastOperator = ''
        continue
      }

      if (
        (entry.op === '>' || entry.op === '>>')
        && entries[index + 1] === '/dev/null'
      ) {
        index++
        lastOperator = ''
        continue
      }

      if (!['&&', '||', ';', '|'].includes(entry.op)) {
        return entry.op === '&'
          ? dangerous('POSIX Shell 命令包含后台执行')
          : dangerous(['<', '>', '>>', '>&', '<&', '<<<', '<('].includes(entry.op)
              ? 'POSIX Shell 命令包含重定向'
              : `POSIX Shell 命令包含 ${entry.op} 控制结构`)
      }

      if (args.length === 0)
        return unknown('POSIX Shell 命令结构不完整')

      const assessment = assessShellCommand(args[0]!, args.slice(1), context)

      if (!isPermittedShellAssessment(assessment))
        return assessment

      args = []
      lastOperator = entry.op
    }

    if (args.length > 0)
      return assessShellCommand(args[0]!, args.slice(1), context)

    return lastOperator === '' || lastOperator === ';'
      ? { category: 'query' }
      : unknown('POSIX Shell 命令结构不完整')
  }
}
