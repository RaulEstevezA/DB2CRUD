/**
 * Writes the project of every verification scenario to verification/.work/<scenario>/, with the same core
 * the web version runs. Requires Node 22.6 or later (TypeScript files are loaded with type stripping).
 *
 * Usage: node --experimental-strip-types verification/generate.mjs [scenario-id-prefix]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS } from './scenarios/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const core = join(here, '..', 'web', 'src')
const { EXAMPLES } = await import(join(core, 'examples', 'index.ts'))
const { parseInput } = await import(join(core, 'core', 'importers', 'registry.ts'))
const { proposeDesign } = await import(join(core, 'core', 'design', 'propose.ts'))
const { addCustomEndpoint, updateEndpoint } = await import(join(core, 'core', 'design', 'edit.ts'))
const { resolveApi } = await import(join(core, 'core', 'api', 'spec.ts'))
const { DEFAULT_SETTINGS, normalizeSettings } = await import(join(core, 'core', 'compatibility', 'stack.ts'))
const { generateProject } = await import(join(core, 'core', 'generators', 'registry.ts'))

/** Design edits a scenario can ask for, so the generated code covers more than the proposal. */
const EDITS = {
  // Filters and sorting on the first resource's list, on its first two plain fields
  filters: (design) => {
    const resource = design.resources.find((item) => item.expose.value === 'resource')
    const plain = resource.fields.filter((field) => field.access.value === 'readWrite' && !field.relation).map((field) => field.field).slice(0, 2)
    return updateEndpoint(design, resource.model, `${resource.model}.list`, { filters: plain, sort: plain })
  },
  // A business operation on the last resource
  custom: (design) => {
    const resource = design.resources.filter((item) => item.expose.value === 'resource').at(-1)
    return addCustomEndpoint(design, resource.model).design
  },
  // The deletion of every resource needs the "admin" role
  roles: (design) => {
    let next = design
    for (const resource of design.resources.filter((item) => item.expose.value === 'resource')) {
      next = updateEndpoint(next, resource.model, `${resource.model}.delete`, { access: 'roles', roles: ['admin'] })
      next = updateEndpoint(next, resource.model, `${resource.model}.get`, { access: 'roles', roles: ['admin', 'reader'] })
    }
    return next
  },
}

const filter = process.argv[2] ?? ''
for (const scenario of SCENARIOS.filter((item) => item.id.startsWith(filter))) {
  const example = EXAMPLES.find((item) => item.id === scenario.example)
  const outcome = parseInput(example.text, example.format)
  if (!outcome.ok) throw new Error(`${scenario.id}: the example does not parse`)
  let design = proposeDesign(outcome.schema)
  for (const edit of scenario.edits ?? []) design = EDITS[edit](design)
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, name: example.project, ...scenario.settings })
  const spec = resolveApi(outcome.schema, design, settings)
  if (spec.issues.some((issue) => issue.severity === 'error')) throw new Error(`${scenario.id}: ${JSON.stringify(spec.issues)}`)
  const files = generateProject(spec, settings)
  const folder = join(here, '.work', scenario.id)
  rmSync(folder, { recursive: true, force: true })
  for (const file of files) {
    mkdirSync(dirname(join(folder, file.path)), { recursive: true })
    writeFileSync(join(folder, file.path), file.content)
  }
  console.log(`${scenario.id}: ${files.length} files`)
}
