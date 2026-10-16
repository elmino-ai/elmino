import {
  HttpOriginSchema,
  HttpUrlSchema,
  ListenPortSchema,
  NonBlankStringSchema,
  PortSchema,
  TrimmedStringSchema,
} from '@elmino/schema'

if (NonBlankStringSchema.parse(' agent ') !== ' agent ' || TrimmedStringSchema.parse(' agent ') !== 'agent')
  throw new Error('字段规则丢失了保真与归一化的区别')
if (ListenPortSchema.parse(0) !== 0 || PortSchema.safeParse(0).success)
  throw new Error('监听端口与目标端口边界错误')
if (HttpOriginSchema.parse('https://agent.example.test') !== 'https://agent.example.test'
  || HttpOriginSchema.safeParse('https://agent.example.test/path').success
  || HttpUrlSchema.safeParse('file:///tmp/data').success) {
  throw new Error('HTTP 地址与精确浏览器来源校验错误')
}
