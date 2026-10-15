import type { Fetch, FetchInit, FetchInput, Promisable, UnknownRecord } from '@elmino/shared'
import type { HttpErrorIssue } from '../error/http-error'
import { isPlainRecord, jsonParse } from '@elmino/shared'
import { HttpError } from '../error/http-error'

/** -------------------- 类型 -------------------- */
/** 非成功 HTTP 响应的解析上下文 */
export interface DecodeHttpErrorContext {
  /** 后端系统稳定标识 */
  system: string
  /** 原始 HTTP 响应 */
  response: Response
  /** 响应文本 */
  text: string
  /** 尝试解析后的 JSON 正文 */
  body: unknown
}

/** 后端错误解析结果 */
export interface DecodedHttpError {
  /** 可读错误信息 */
  message?: string
  /** 稳定业务错误码 */
  code?: string
  /** 业务错误上下文 */
  details?: UnknownRecord
  /** 输入校验问题 */
  issues?: HttpErrorIssue[]
}

/** 创建 Request 的配置 */
export interface CreateRequestOptions {
  /** 后端系统稳定标识 */
  system: string
  /** 请求基础地址 */
  baseUrl: string
  /** 注入的底层 Fetch，默认使用全局 Fetch */
  fetch?: Fetch
  /** 每次请求动态读取的默认 Header */
  headers?: HeadersInit | (() => Promisable<HeadersInit>)
  /** 将当前系统的错误响应映射成统一错误字段 */
  decodeError?: (context: DecodeHttpErrorContext) => Promisable<DecodedHttpError>
}

/** 绑定基础地址的最小 Fetch 传输能力 */
export interface RequestTransport {
  /** 规范化后的请求基础地址 */
  readonly baseUrl: string
  /** 与原生服务地址分离的可选 oRPC endpoint */
  readonly rpcBaseUrl?: string
  /** 保留标准 Response 的 Fetch，供协议适配器和流式请求使用 */
  readonly fetch: Fetch
  /** 仅注入基础地址和鉴权 Header 的原始 Fetch */
  readonly rawFetch: Fetch
}

/** 单个后端系统的标准 Fetch 边界 */
export interface RequestClient extends RequestTransport {
  /** 后端系统稳定标识 */
  readonly system: string
  /** 复用当前系统策略并替换请求基础地址 */
  withBaseUrl: (baseUrl: string) => RequestClient
}

/** -------------------- 核心函数 -------------------- */
/**
 * 创建绑定单个后端系统的标准 Fetch 传输
 */
export function createRequest(options: CreateRequestOptions): RequestClient {
  const {
    decodeError,
    fetch: inputFetch,
    headers: inputHeaders,
    system,
  } = options
  const baseUrl = resolveBaseUrl(options.baseUrl)
  const baseOrigin = new URL(baseUrl).origin
  /** 底层 Fetch 始终从调用时的全局对象读取，便于浏览器、Node.js 和测试注入 */
  const runtimeFetch: Fetch = inputFetch ?? ((input, init) => globalThis.fetch(input, init))

  /** 使用当前系统的基础地址和动态 Header 发起原始 Fetch */
  const rawFetch: Fetch = async (input, init) => {
    const request = createRequestInput(baseUrl, input, init)
    const requestOrigin = new URL(request.url).origin
    const headers = requestOrigin === baseOrigin
      ? new Headers(await resolveHeaders(inputHeaders))
      : new Headers()

    // 跨域绝对地址不继承系统鉴权；调用点 Header 始终拥有最终覆盖权
    for (const [name, value] of request.headers)
      headers.set(name, value)

    return runtimeFetch(new Request(request, { headers }))
  }

  /** 使用当前系统错误协议发起标准 Fetch */
  const fetch: Fetch = async (input, init) => {
    const response = await rawFetch(input, init)

    await assertResponse(response, system, decodeError)
    return response
  }

  /** 复用同一系统的传输和动态策略，仅派生新的服务前缀 */
  const withBaseUrl = (nextBaseUrl: string) => createRequest({
    baseUrl: nextBaseUrl,
    system,
    fetch: runtimeFetch,
    headers: inputHeaders,
    decodeError,
  })

  return { system, baseUrl, fetch, rawFetch, withBaseUrl }
}

/** -------------------- 内部函数 -------------------- */
/**
 * 只将相对地址解析到系统基础地址，绝对地址保持标准 Fetch 语义
 */
function createRequestInput(
  baseUrl: string,
  input: FetchInput,
  init?: FetchInit,
) {
  if (typeof input === 'string' && !URL.canParse(input)) {
    const target = new URL(input.replace(/^\/+/, ''), `${baseUrl}/`)

    return new Request(target, init)
  }

  return new Request(input, init)
}

/**
 * 将静态 Header 和异步鉴权 Header 统一为单次请求快照
 */
function resolveHeaders(
  headers: CreateRequestOptions['headers'],
) {
  return typeof headers === 'function' ? headers() : headers
}

/**
 * 将浏览器同源空地址和显式地址统一成绝对基础地址
 */
function resolveBaseUrl(baseUrl: string) {
  const value = baseUrl.replace(/\/+$/, '')

  try {
    return new URL(value).toString().replace(/\/+$/, '')
  }
  catch {
    if (typeof globalThis.location === 'undefined')
      throw new TypeError('Node.js 环境中的 baseUrl 必须是绝对地址')

    return new URL(value || '/', globalThis.location.origin)
      .toString()
      .replace(/\/+$/, '')
  }
}

/**
 * 将非成功响应按当前后端协议转换成统一 HttpError
 */
async function assertResponse(
  response: Response,
  system: string,
  decodeError?: CreateRequestOptions['decodeError'],
) {
  if (response.ok)
    return

  const text = await response.text()
  const body = jsonParse(text)
  const defaults = decodeDefaultError(response, text, body)
  const decoded = await decodeError?.({ system, response, text, body })

  throw new HttpError({
    system,
    status: response.status,
    message: decoded?.message ?? defaults.message,
    code: decoded?.code ?? defaults.code,
    details: decoded?.details ?? defaults.details,
    issues: decoded?.issues ?? defaults.issues,
  })
}

/**
 * 兼容常见 JSON 错误结构并为纯文本服务保留可读消息
 */
function decodeDefaultError(response: Response, text: string, body: unknown) {
  const record = isPlainRecord(body) ? body : undefined
  const details = isPlainRecord(record?.details) ? record.details : undefined
  const issues = Array.isArray(record?.issues)
    ? record.issues.filter((issue): issue is HttpErrorIssue => (
        isPlainRecord(issue)
        && typeof issue.code === 'string'
        && typeof issue.message === 'string'
        && typeof issue.path === 'string'
      ))
    : undefined
  const message = typeof record?.message === 'string'
    ? record.message
    : typeof record?.error === 'string'
      ? record.error
      : text || response.statusText
  const code = typeof record?.code === 'string'
    ? record.code
    : undefined

  return { message, code, details, issues }
}
