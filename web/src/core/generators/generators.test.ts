/**
 * Static checks of every generated project, for every built-in example and stack: the files a project
 * imports exist, the contract it ships is the contract of the API, and every resource is wired in.
 * Running the projects with their real tools is the job of verification/ (Docker).
 */
import { describe, expect, it } from 'vitest'
import { FRAMEWORKS, databasesFor, type ProjectSettings } from '../compatibility/stack.ts'
import { openApiYaml } from '../openapi/build.ts'
import { example } from '../test/fixtures.ts'
import { compareText } from './common/text.ts'
import { csClass, csProperty, csString } from './languages/csharp/csharp.ts'
import { ktClass, ktName, ktString } from './languages/kotlin/kotlin.ts'
import { rsModule, rsName, rsString, rsType } from './languages/rust/rust.ts'
import { swName, swString, swType } from './languages/swift/swift.ts'
import { findGenerator, generateProject } from './registry.ts'

const EXAMPLES = ['store', 'library', 'catalog'] as const

/** Every stack a framework offers, with the first database of each persistence. */
function stacks(): Partial<ProjectSettings>[] {
  const result: Partial<ProjectSettings>[] = []
  for (const framework of FRAMEWORKS) {
    if (!findGenerator(framework.id)) continue
    for (const architecture of framework.architectures) {
      for (const persistence of framework.persistence) {
        for (const auth of framework.auth) {
          result.push({
            framework: framework.id,
            architecture,
            persistence: persistence.id,
            database: databasesFor(framework.id, persistence.id)[0] ?? null,
            auth,
          })
        }
      }
    }
  }
  return result
}

/** Python modules a project imports from itself (`from app.x.y import …`, `from tests.helpers import …`). */
function pythonImports(content: string): string[] {
  return [...content.matchAll(/^from ((?:app|tests)(?:\.\w+)*) import/gm)].map((match) => match[1])
}

describe('generated projects', () => {
  for (const settings of stacks()) {
    const label = Object.values(settings).join(' / ')
    it(`imports only files it contains: ${label}`, () => {
      for (const id of EXAMPLES) {
        const { spec, settings: resolved } = example(id, settings)
        const files = generateProject(spec, resolved)
        const paths = new Set(files.map((file) => file.path))
        for (const file of files.filter((item) => item.path.endsWith('.ts'))) {
          for (const match of file.content.matchAll(/from '(\.{1,2}\/[^']+)\.js'/g)) {
            const target = [...file.path.split('/').slice(0, -1), ...match[1].split('/')].reduce<string[]>(
              (parts, part) => (part === '..' ? parts.slice(0, -1) : part === '.' ? parts : [...parts, part]),
              [],
            )
            expect(paths.has(`${target.join('/')}.ts`), `${id}: ${file.path} imports ${match[1]}`).toBe(true)
          }
        }
        // C#: every `using` of the project's own namespaces names a namespace some file declares
        const declared = new Set(files.flatMap((file) => [...file.content.matchAll(/^namespace ([\w.]+);/gm)].map((match) => match[1])))
        const root = [...declared][0]?.split('.')[0]
        for (const file of files.filter((item) => item.path.endsWith('.cs'))) {
          for (const match of file.content.matchAll(/^using ([\w.]+);/gm)) {
            if (root && match[1].startsWith(`${root}.`)) expect(declared.has(match[1]), `${id}: ${file.path} uses ${match[1]}`).toBe(true)
          }
        }
        // Kotlin: every import of the project's own packages names a package some file declares
        const packages = new Set(files.flatMap((file) => [...file.content.matchAll(/^package ([\w.]+)$/gm)].map((match) => match[1])))
        const base = resolved.javaPackage
        for (const file of files.filter((item) => item.path.endsWith('.kt'))) {
          for (const match of file.content.matchAll(/^import ([\w.]+)$/gm)) {
            if (!match[1].startsWith(`${base}.`)) continue
            const pkg = match[1].slice(0, match[1].lastIndexOf('.'))
            expect(packages.has(pkg), `${id}: ${file.path} imports ${match[1]}`).toBe(true)
          }
        }
        for (const file of files.filter((item) => item.path.endsWith('.py'))) {
          for (const module of pythonImports(file.content)) {
            const path = module.replace(/\./g, '/')
            expect(paths.has(`${path}.py`) || paths.has(`${path}/__init__.py`), `${id}: ${file.path} imports ${module}`).toBe(true)
          }
        }
      }
    })
  }

  it('ships the contract of the API and wires every resource', () => {
    for (const id of EXAMPLES) {
      const { spec, settings } = example(id, { framework: 'fastapi' })
      const files = generateProject(spec, settings)
      expect(files.find((file) => file.path === 'openapi.yaml')!.content).toBe(openApiYaml(spec, findGenerator('fastapi')!.serverUrl))
      const main = files.find((file) => file.path === 'app/main.py')!.content
      for (const resource of spec.resources)
        expect(main).toContain(`include_router(${resource.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_router)`)
      expect(files.map((file) => file.path)).toEqual([...files.map((file) => file.path)].sort(compareText))
    }
  })

  it('keeps secrets out of the project: only placeholders in .env.example', () => {
    const { spec, settings } = example('store', { framework: 'fastapi', auth: 'jwt', persistence: 'sqlalchemy', database: 'postgresql' })
    const env = generateProject(spec, settings).find((file) => file.path === '.env.example')!.content
    expect(env).toMatch(/^JWT_SECRET=$/m)
    expect(env).toContain('change-me')
  })

  it('writes C# names that do not clash with .NET or with their own class', () => {
    expect(csClass('task')).toBe('TaskItem')
    expect(csClass('order line')).toBe('OrderLine')
    expect(csProperty('note', 'Note')).toBe('NoteValue')
    expect(csProperty('postal_code', 'Address')).toBe('PostalCode')
    expect(csString('say "hi"\\n')).toBe('"say \\"hi\\"\\\\n"')
  })

  it('writes Kotlin names and strings that compile', () => {
    expect(ktClass('route')).toBe('RouteItem')
    expect(ktName('object')).toBe('`object`')
    expect(ktString('costs $5 "now"')).toBe('"costs \\$5 \\"now\\""')
  })

  it('writes Rust names and strings that compile', () => {
    expect(rsType('path')).toBe('PathItem')
    expect(rsName('type')).toBe('r#type')
    expect(rsName('self')).toBe('self_')
    expect(rsModule('match')).toBe('match_')
    expect(rsString('say "hi"\n')).toBe('"say \\"hi\\"\\n"')
  })

  it('writes Swift names and strings that compile', () => {
    expect(swType('task')).toBe('TaskItem')
    expect(swName('default')).toBe('`default`')
    expect(swName('self')).toBe('self_')
    expect(swString('say "hi"\n')).toBe('"say \\"hi\\"\\n"')
  })
})
