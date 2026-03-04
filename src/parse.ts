import type { Parser as ParserType } from 'web-tree-sitter'
import { fileURLToPath } from 'url'

let _parser: ParserType | null = null

function resolveWasm(asset: string): string {
  if (asset.startsWith('file://')) return fileURLToPath(asset)
  if (asset.startsWith('/') || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

export async function getParser(): Promise<ParserType> {
  if (_parser) return _parser
  const { Parser, Language } = await import('web-tree-sitter')
  const { default: treeWasm } = await import('web-tree-sitter/tree-sitter.wasm' as string, {
    with: { type: 'wasm' },
  })
  await Parser.init({ locateFile() { return resolveWasm(treeWasm) } })
  const { default: bashWasm } = await import('tree-sitter-bash/tree-sitter-bash.wasm' as string, {
    with: { type: 'wasm' },
  })
  const bashLang = await Language.load(resolveWasm(bashWasm))
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
