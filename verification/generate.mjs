/**
 * Writes the project of every verification scenario to verification/.work/<scenario>/, with the same core the
 * web version runs. Requires Node 22.6 or later (TypeScript files are loaded with type stripping).
 *
 * Usage: node --experimental-strip-types verification/generate.mjs [scenario-id-prefix]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS } from './scenarios/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const core = join(here, '..', 'web', 'src', 'core')
const { SHOP } = await import(join(core, 'crud', 'fixtures.ts'))
const { proposeCrud } = await import(join(core, 'crud', 'propose.ts'))
const { decidePolicy } = await import(join(core, 'crud', 'edit.ts'))
const { generateProject } = await import(join(core, 'generators', 'registry.ts'))

const SCHEMAS = { shop: SHOP }
const prefix = process.argv[2] ?? ''
const work = join(here, '.work')

for (const scenario of SCENARIOS.filter((item) => item.id.startsWith(prefix))) {
  const schema = SCHEMAS[scenario.schema]
  let design = proposeCrud(schema)
  // Decisions change what depends on them (operations, checks): the design is proposed again after each
  for (const item of scenario.decisions ?? []) design = proposeCrud(schema, decidePolicy(design, item.table, item.decision, item.value))
  const files = generateProject(schema, design, { name: scenario.id, ...scenario.settings })
  const folder = join(work, scenario.id)
  rmSync(folder, { recursive: true, force: true })
  for (const file of files) {
    mkdirSync(dirname(join(folder, file.path)), { recursive: true })
    writeFileSync(join(folder, file.path), file.content)
  }
  console.log(`${scenario.id}: ${files.length} files`)
}
