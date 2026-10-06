// 打包并运行日记审核事务测试；通过 esbuild 的 JS API 调用，避免平台二进制软链问题。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outfile = path.join(root, 'node_modules/.cache/test-diary.mjs')

await build({
  entryPoints: [path.join(root, 'test-diary.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'silent',
})

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
process.exit(result.status ?? 1)
