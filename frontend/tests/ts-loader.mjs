// 测试用 ESM loader：运行时即时把 .ts 转译成 ESM，并补全无扩展名的相对导入。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import ts from 'typescript'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.(mjs|js|json)$/.test(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd()
    const base = resolvePath(dirname(parentPath), specifier)
    const candidates = [`${base}.ts`, `${base}/index.ts`]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const path = fileURLToPath(url)
    const source = readFileSync(path, 'utf8')
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        sourceMap: false,
      },
      fileName: path,
    })
    return { format: 'module', source: result.outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}
