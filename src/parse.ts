import type { Parser as ParserType } from 'web-tree-sitter'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

let _parser: ParserType | null = null

/** Resolve the directory of an npm package by finding its package.json */
function pkgDir(pkg: string): string {
  return path.dirname(require.resolve(`${pkg}/package.json`))
}

export async function getParser(): Promise<ParserType> {
  if (_parser) return _parser
  const { Parser, Language } = await import('web-tree-sitter')

  // Locate WASM files from node_modules (works regardless of bundler/runtime)
  const treeSitterWasm = path.join(pkgDir('web-tree-sitter'), 'web-tree-sitter.wasm')
  await Parser.init({ locateFile() { return treeSitterWasm } })

  const bashWasm = path.join(pkgDir('tree-sitter-bash'), 'tree-sitter-bash.wasm')
  const bashLang = await Language.load(bashWasm)

  const p = new Parser()
  p.setLanguage(bashLang)
  _parser = p
  return p
}

export function stripSentinels(command: string, parser: ParserType): string {
  const tree = parser.parse(command)
  if (!tree) return command
  const pieces: string[] = []
  let pos = 0

  for (const node of tree.rootNode.children) {
    if (node.startIndex > pos) {
      pieces.push(command.slice(pos, node.startIndex))
    }

    if (node.type === 'comment' && /^#\s*\[sandboxed\]/.test(node.text)) {
      // Sentinel comment — extract inner content and recurse
      const inner = node.text.replace(/^#\s*\[sandboxed\]\s*/, '').trim()
      if (inner) pieces.push(stripSentinels(inner, parser))
    } else {
      pieces.push(command.slice(node.startIndex, node.endIndex))
    }

    pos = node.endIndex
  }

  if (pos < command.length) pieces.push(command.slice(pos))
  const result = pieces.join('').trim()
  return result || command
}
