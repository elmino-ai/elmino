import { defineConfig } from 'tsdown'

/** 保留模块目录，由构建器为 ESM 产物补齐相对导入路径 */
export default defineConfig({
  cwd: process.cwd(),
  entry: ['src/**/*.ts'],
  root: 'src',
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  unbundle: true,
  clean: true,
  sourcemap: true,
  dts: { sourcemap: true },
  tsconfig: 'tsconfig.build.json',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: { neverBundle: true, onlyBundle: [] },
})
