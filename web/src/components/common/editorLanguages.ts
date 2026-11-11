/**
 * Syntax highlighting of the code editor, by input format or by the language of a generated file. Each language
 * is downloaded only when it is first shown.
 */
import { LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language'

const legacy = (parser: StreamParser<unknown>) => new LanguageSupport(StreamLanguage.define(parser))

// Loaded on demand: only the languages being viewed are downloaded
const LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  json: async () => (await import('@codemirror/lang-json')).json(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  php: async () => (await import('@codemirror/lang-php')).php({ plain: false }),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  csharp: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).csharp),
  kotlin: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  dart: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).dart),
  scala: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).scala),
  swift: async () => legacy((await import('@codemirror/legacy-modes/mode/swift')).swift),
  protobuf: async () => legacy((await import('@codemirror/legacy-modes/mode/protobuf')).protobuf),
  // GraphQL and Prisma read close enough to Kotlin for highlighting
  graphql: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  prisma: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  toml: async () => legacy((await import('@codemirror/legacy-modes/mode/toml')).toml),
  properties: async () => legacy((await import('@codemirror/legacy-modes/mode/properties')).properties),
  text: async () => new LanguageSupport(StreamLanguage.define({ token: (stream) => (stream.skipToEnd(), null) })),
}

const cache = new Map<string, Promise<LanguageSupport>>()

/** Highlighting for an input format or an output language. */
export function editorLanguage(id: string): Promise<LanguageSupport> {
  if (!cache.has(id)) cache.set(id, (LOADERS[id] ?? LOADERS.text)())
  return cache.get(id)!
}

/** The highlighting of a generated file, by its name. */
export function languageOfFile(path: string): string {
  const name = path.split('/').pop() ?? path
  if (name === '.env.example' || name.endsWith('.properties')) return 'properties'
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const byExtension: Record<string, string> = {
    py: 'python',
    ts: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    cs: 'csharp',
    php: 'php',
    rs: 'rust',
    swift: 'swift',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    md: 'markdown',
    toml: 'toml',
    prisma: 'prisma',
  }
  return byExtension[extension] ?? 'text'
}
