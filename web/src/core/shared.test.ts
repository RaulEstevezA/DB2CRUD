// @vitest-environment jsdom
/**
 * The cases in shared/test-cases/calls/, which the desktop version's tests read too (shared/README.md):
 * each `<module>.<function>.json` holds the arguments of a core function and the result it must give.
 *
 * `UPDATE_SHARED=1 npx vitest run src/core/shared.test.ts` writes the results again from what the web
 * version does now; the desktop version then has to match them.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readConstraints } from './analysis/constraints.ts'
import { analyzeModels } from './analysis/models.ts'
import { detectFormats, parseInput } from './importers/registry.ts'
import { accept, decidePolicy, pendingDecisions, setOperationInclude, setQueryInclude } from './crud/edit.ts'
import { proposeCrud } from './crud/propose.ts'
import { readModel2DBProject } from './interop/model2db/read.ts'
import { validateDbSchema } from './schema/validate.ts'
import { pluralize, singularize, splitWords, toCamelCase, toPascalCase, toSnakeCase } from './model/naming.ts'

// Tests run from web/
const FOLDER = resolve(process.cwd(), '../shared/test-cases/calls')
const UPDATE = process.env.UPDATE_SHARED === '1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => unknown

/** Every function with shared cases, by `<module>.<function>`. */
const SHARED_FUNCTIONS: Record<string, AnyFunction> = {
  'naming.splitWords': splitWords,
  'naming.toPascalCase': toPascalCase,
  'naming.toCamelCase': toCamelCase,
  'naming.toSnakeCase': toSnakeCase,
  'naming.singularize': singularize,
  'naming.pluralize': pluralize,
  'registry.detectFormats': detectFormats,
  'registry.parseInput': parseInput,
  'constraints.readConstraints': readConstraints,
  // A Map does not survive JSON: the facts are written as an object
  'models.analyzeModels': (schema) => Object.fromEntries(analyzeModels(schema)),
  'validate.validateDbSchema': validateDbSchema,
  'propose.proposeCrud': proposeCrud,
  'edit.decidePolicy': decidePolicy,
  'edit.setQueryInclude': setQueryInclude,
  'edit.setOperationInclude': setOperationInclude,
  'edit.accept': accept,
  'edit.pendingDecisions': pendingDecisions,
  'read.readModel2DBProject': readModel2DBProject,
}

/** What JSON keeps of a value: the files hold JSON, so `undefined` keys disappear as they do there. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value === undefined ? null : value))

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`)

describe('shared calls', () => {
  for (const file of readdirSync(FOLDER).filter((name) => name.endsWith('.json'))) {
    const name = file.slice(0, -'.json'.length)
    it(name, () => {
      const fn = SHARED_FUNCTIONS[name]
      expect(fn, `no function for ${file}`).toBeDefined()
      const path = join(FOLDER, file)
      const cases: { args: unknown[]; result: unknown }[] = JSON.parse(readFileSync(path, 'utf8'))
      const results = cases.map((item) => asJson(fn(...item.args)))
      if (UPDATE)
        return writeJson(
          path,
          cases.map((item, index) => ({ args: item.args, result: results[index] })),
        )
      cases.forEach((item, index) => expect(results[index], `${name} #${index}`).toEqual(item.result))
    })
  }
})
