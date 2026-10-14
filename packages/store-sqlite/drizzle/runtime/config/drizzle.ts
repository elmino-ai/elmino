import { defineConfig } from 'drizzle-kit'

/** -------------------- 配置出口 -------------------- */
/** 运行事实数据库的增量迁移生成配置 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/drizzle/schema/tables.ts',
  out: './drizzle/runtime/migrations',
})
