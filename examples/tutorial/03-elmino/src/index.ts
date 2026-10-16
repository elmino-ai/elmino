/**
 * Tutorial 03 · Elmino 应用入口
 *
 * 运行：pnpm example:elmino；凭据由本示例的 .env 提供
 * 阅读顺序：app/elmino.ts 的应用装配 → app/run.ts 的本地调用 → agent/clock.ts 的行为定义
 * 学完再看 04-server：把同样的应用实例交给 Server，就能提供远程访问
 */
import { runExample } from './app/run'

runExample().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
