/** 浏览器与 Node.js 兼容运行时提供的 Fetch 请求目标 */
export type FetchInput = Parameters<typeof globalThis.fetch>[0]

/** 浏览器与 Node.js 兼容运行时提供的 Fetch 请求配置 */
export type FetchInit = RequestInit

/** 浏览器与 Node.js 兼容运行时提供的标准 Fetch */
export type Fetch = (input: FetchInput, init?: FetchInit) => Promise<Response>
