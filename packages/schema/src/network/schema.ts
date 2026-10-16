import { z } from 'zod'

/** HTTP 服务连接地址，不接受文件、邮件和其他 URL 协议 */
export const HttpUrlSchema = z.url()
  .refine((value) => {
    const url = URL.parse(value)
    return url !== null && ['http:', 'https:'].includes(url.protocol)
  }, '必须使用 HTTP 或 HTTPS 地址')
  .meta({ description: '完整 HTTP 或 HTTPS 地址，可包含路径', examples: ['https://agent.example.com/api'] })

/** 浏览器精确来源，不能包含路径、凭据、查询或片段 */
export const HttpOriginSchema = HttpUrlSchema.refine(value => URL.parse(value)?.origin === value, '必须填写不含路径的完整 HTTP Origin')
  .meta({ description: '浏览器完整来源，不包含路径或末尾斜杠', examples: ['http://localhost:5173'] })

/** 多个来源分别校验，逗号分隔环境字符串的转换由配置入口完成 */
export const HttpOriginsSchema = z.array(HttpOriginSchema)

/** 服务端可传 0 请求系统分配端口；此处不转换字符串或设置默认值 */
export const ListenPortSchema = z.number()
  .int()
  .min(0)
  .max(65_535)
  .meta({ description: '监听端口，0 表示由系统分配', examples: [3000, 0] })

/** 连接已存在的服务必须使用实际端口，不能把 0 当作目标端口 */
export const PortSchema = ListenPortSchema.min(1)
  .meta({ description: '目标服务端口，范围 1–65535', examples: [3000] })
