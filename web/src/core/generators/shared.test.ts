/**
 * The generated projects in shared/test-cases/, which the desktop version's tests read too (shared/README.md):
 *
 * - `outputs/<framework>/<example>/…`: the files of every framework for every example, with the proposal and
 *   the default settings, as real files.
 * - `variants/<scenario>.json`: the scenarios of verification/ and a few more, each with its example, its
 *   settings, the edits made on the proposal (as calls to design/edit.ts) and the files written.
 *
 * `UPDATE_SHARED=1 npx vitest run src/core/generators/shared.test.ts` writes them again.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The scenarios are plain JavaScript, shared with the verification scripts
import { SCENARIOS } from '../../../../verification/scenarios/index.mjs'
import { EXAMPLES, type ExampleId } from '../../examples/index.ts'
import { resolveApi } from '../api/spec.ts'
import type { ApiDesign } from '../api/types.ts'
import { DEFAULT_SETTINGS, FRAMEWORKS, normalizeSettings, type ProjectSettings } from '../compatibility/stack.ts'
import { addCustomEndpoint, decide, pendingDecisions, updateEndpoint } from '../design/edit.ts'
import { proposeDesign } from '../design/propose.ts'
import { parseInput } from '../importers/registry.ts'
import { generateProject } from './registry.ts'

// Tests run from web/
const SHARED = resolve(process.cwd(), '../shared/test-cases')
const UPDATE = process.env.UPDATE_SHARED === '1'

/** An edit of the design, as a call to a function of design/edit.ts without its first argument. */
interface Edit {
  edit: 'decide' | 'updateEndpoint' | 'addCustomEndpoint'
  args: unknown[]
}

interface Variant {
  example: ExampleId
  settings: Partial<ProjectSettings>
  edits: Edit[]
}

interface VariantFile extends Variant {
  files: Record<string, string>
}

type Scenario = { id: string; example: ExampleId; settings: Partial<ProjectSettings>; edits?: string[] }

function schemaOf(id: ExampleId) {
  const example = EXAMPLES.find((item) => item.id === id)!
  const outcome = parseInput(example.text, example.format)
  if (!outcome.ok) throw new Error(`Example ${id} does not parse`)
  return { example, schema: outcome.schema }
}

/** Applies an edit; `addCustomEndpoint` returns the design with the new endpoint. */
function applyEdit(design: ApiDesign, { edit, args }: Edit): ApiDesign {
  if (edit === 'decide') return decide(design, ...(args as [never, unknown]))
  if (edit === 'updateEndpoint') return updateEndpoint(design, ...(args as [string, string, never]))
  return addCustomEndpoint(design, ...(args as [string])).design
}

/** The edits a verification scenario names, as explicit calls on the proposal of its example. */
function scenarioEdits(names: string[], design: ApiDesign): Edit[] {
  const resources = design.resources.filter((item) => item.expose.value === 'resource')
  return names.flatMap((name): Edit[] => {
    if (name === 'filters') {
      const resource = resources[0]
      const plain = resource.fields
        .filter((field) => field.access.value === 'readWrite' && !field.relation)
        .map((field) => field.field)
        .slice(0, 2)
      return [{ edit: 'updateEndpoint', args: [resource.model, `${resource.model}.list`, { filters: plain, sort: plain }] }]
    }
    if (name === 'custom') return [{ edit: 'addCustomEndpoint', args: [resources.at(-1)!.model] }]
    return resources.flatMap((resource): Edit[] => [
      { edit: 'updateEndpoint', args: [resource.model, `${resource.model}.delete`, { access: 'roles', roles: ['admin'] }] },
      { edit: 'updateEndpoint', args: [resource.model, `${resource.model}.get`, { access: 'roles', roles: ['admin', 'reader'] }] },
    ])
  })
}

/** Every pending decision accepted with its suggestion. */
function acceptAll(design: ApiDesign): Edit[] {
  return pendingDecisions(design).map((ref) => ({ edit: 'decide', args: [ref] }))
}

function variants(): Record<string, Variant> {
  const result: Record<string, Variant> = {}
  for (const scenario of SCENARIOS as Scenario[]) {
    const design = proposeDesign(schemaOf(scenario.example).schema)
    result[scenario.id] = { example: scenario.example, settings: scenario.settings, edits: scenarioEdits(scenario.edits ?? [], design) }
  }
  // Decisions taken, endpoints public by default, a custom endpoint with input and output
  for (const framework of FRAMEWORKS) {
    const design = proposeDesign(schemaOf('library').schema)
    const model = design.resources.find((item) => item.expose.value === 'resource')!.model
    result[`${framework.id.toLowerCase()}-decided-public`] = {
      example: 'library',
      settings: { framework: framework.id, auth: 'jwt', defaultAccess: 'public' },
      edits: [
        ...acceptAll(design),
        { edit: 'addCustomEndpoint', args: [model] },
        {
          edit: 'updateEndpoint',
          args: [model, `${model}.custom.1`, { method: 'PUT', path: '/archive/{id}', input: 'partial', output: 'list', status: 202 }],
        },
      ],
    }
  }
  return result
}

/** The files of a project for an example, settings and edits. */
function filesOf(variant: Variant): Record<string, string> {
  const { example, schema } = schemaOf(variant.example)
  const design = variant.edits.reduce(applyEdit, proposeDesign(schema))
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, name: example.project, ...variant.settings })
  return Object.fromEntries(generateProject(resolveApi(schema, design, settings), settings).map((file) => [file.path, file.content]))
}

/** Every file under a folder, by path relative to it. */
function readTree(folder: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(folder, path).split('\\').join('/')] = readFileSync(path, 'utf8')
    }
  }
  walk(folder)
  return files
}

describe('shared outputs', () => {
  for (const framework of FRAMEWORKS)
    for (const example of EXAMPLES)
      it(`${framework.id}/${example.id}`, () => {
        const files = filesOf({ example: example.id, settings: { framework: framework.id }, edits: [] })
        const folder = join(SHARED, 'outputs', framework.id, example.id)
        if (UPDATE) {
          rmSync(folder, { recursive: true, force: true })
          for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(folder, path)), { recursive: true })
            writeFileSync(join(folder, path), content)
          }
          return
        }
        expect(readTree(folder)).toEqual(files)
      })
})

describe('shared variants', () => {
  const folder = join(SHARED, 'variants')
  if (UPDATE) {
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    for (const [name, variant] of Object.entries(variants())) {
      const file: VariantFile = { ...variant, files: filesOf(variant) }
      writeFileSync(join(folder, `${name}.json`), `${JSON.stringify(file, null, 1)}\n`)
    }
  }
  for (const name of readdirSync(folder).filter((item) => item.endsWith('.json')))
    it(name.slice(0, -'.json'.length), () => {
      const { files, ...variant }: VariantFile = JSON.parse(readFileSync(join(folder, name), 'utf8'))
      expect(filesOf(variant)).toEqual(files)
    })
})
