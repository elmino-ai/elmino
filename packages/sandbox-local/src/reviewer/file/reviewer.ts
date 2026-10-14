import type {
  SandboxApprovalReview,
  SandboxFileAction,
  SandboxFileReviewInput,
  SandboxScopeReview,
} from '@elmino/sandbox'

/** -------------------- 类型 -------------------- */
/** 文件写入权限边界 */
interface FileWritePermissions {
  /** 判断路径是否位于允许写入范围内 */
  canWrite: (filePath: string, followLeaf?: boolean) => boolean
  /** 判断工具路径与当前工作目录的真实位置关系 */
  classifyWorkspacePath: (
    filePath: string,
    followLeaf?: boolean,
  ) => {
    /** 路径与工作目录的关系 */
    relation: 'root' | 'descendant' | 'outside'
    /** 基于工作目录解析的绝对路径 */
    resolved: string
  }
}

/** -------------------- 常量 -------------------- */
/** 文件写入类动作到中文文案的映射 */
const WRITE_ACTION_TEXT: Partial<Record<SandboxFileAction, string>> = {
  edit: '编辑',
  remove: '删除',
  write: '写入',
}

/** -------------------- 核心类 -------------------- */
/**
 * 评审文件动作是否需要审批
 */
export class FileReviewer {
  /** -------------------- 核心方法 -------------------- */
  /**
   * 创建文件动作评审器
   */
  public static create(permissions: FileWritePermissions) {
    return new FileReviewer(permissions)
  }

  /**
   * 保存文件写入权限边界
   */
  private constructor(
    private readonly _permissions: FileWritePermissions,
  ) {}

  /**
   * 判断文件动作是否需要进入审批
   */
  public approval(input: SandboxFileReviewInput): SandboxApprovalReview {
    const actionText = WRITE_ACTION_TEXT[input.action]

    if (!actionText)
      return { decision: 'allow' }

    if (!input.filePath) {
      return {
        decision: 'ask',
        reason: `文件${actionText}需要用户确认`,
      }
    }

    const followLeaf = input.action !== 'remove'
    const { relation, resolved } = this._permissions.classifyWorkspacePath(
      input.filePath,
      followLeaf,
    )

    // 工作目录内的文件变更不扩大 Sandbox 权限；删除工作目录本身仍保留审批
    if (relation === 'descendant' || (relation === 'root' && input.action !== 'remove'))
      return { decision: 'allow' }

    return {
      decision: 'ask',
      reason: `文件${actionText}需要用户确认`,
      grants: !this._permissions.canWrite(
        resolved,
        followLeaf,
      )
        ? [resolved]
        : undefined,
    }
  }

  /**
   * 判断文件动作允许进入的受限作用范围
   */
  public scope(input: SandboxFileReviewInput): SandboxScopeReview {
    const actionText = WRITE_ACTION_TEXT[input.action]

    return actionText
      ? {
          scope: 'modify',
          reason: `文件${actionText}超出受限工具作用域`,
        }
      : { scope: 'inspect' }
  }
}
