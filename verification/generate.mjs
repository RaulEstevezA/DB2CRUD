/**
 * Writes the project of every verification scenario to verification/.work/<scenario>/, with the same core the
 * web version runs. Requires Node 22.6 or later (TypeScript files are loaded with type stripping).
 *
 * Usage: node --experimental-strip-types verification/generate.mjs [scenario-id-prefix]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onOriginalDatabase, originalDdl } from './original-ddl.mjs'
import { withJavaRoundTrip, withRoundTrip } from './mongodb-round-trip.mjs'
import { SCENARIOS } from './scenarios/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const core = join(here, '..', 'web', 'src', 'core')
const { SHOP } = await import(join(core, 'crud', 'fixtures.ts'))
const { proposeCrud } = await import(join(core, 'crud', 'propose.ts'))
const { decidePolicy } = await import(join(core, 'crud', 'edit.ts'))
const { generateProject } = await import(join(core, 'generators', 'registry.ts'))
const { readDdl } = await import(join(core, 'importers', 'ddl', 'ddl.ts'))
const { dropStatements } = await import(join(core, 'schema', 'ddl.ts'))
const { readOrmCode } = await import(join(core, 'importers', 'orm', 'registry.ts'))
const { MATCHING_CASES, readCase } = await import(join(core, 'matching', 'test', 'cases.ts'))

const SCHEMAS = { shop: SHOP }
const prefix = process.argv[2] ?? ''
const work = join(here, '.work')

/** The schema of a file of ORM code or of the validators of a database. */
function readCode(path) {
  const read = readOrmCode([{ name: path, text: readFileSync(join(here, path), 'utf8') }])
  if (!read.ok) throw new Error(`${path}: ${read.error}`)
  return read.schema
}

for (const scenario of SCENARIOS.filter((item) => item.id.startsWith(prefix))) {
  // A shared case of the matching brings its database and its application models (shared/test-cases/matching/)
  const shared = scenario.case ? readCase(join(MATCHING_CASES, scenario.case)) : null
  const schema = shared ? shared.database : scenario.code ? readCode(scenario.code) : scenario.ddl ? readDdl(originalDdl(scenario.settings.database), scenario.settings.database) : SCHEMAS[scenario.schema]
  const models = shared ? shared.models : null
  const project = shared ? shared.project : null
  let design = proposeCrud(schema, null, models, project)
  // Decisions change what depends on them (operations, checks): the design is proposed again after each
  for (const item of scenario.decisions ?? [])
    design = proposeCrud(schema, decidePolicy(design, item.table, item.decision, item.value), models, project)
  let files = generateProject(schema, design, { name: scenario.id, ...scenario.settings }, shared ? { schema: models, project } : null)
  // ENTITIES=1 leaves the tests as they are, creating their tables from the entities
  if (scenario.ddl && !process.env.ENTITIES) files = onOriginalDatabase(files, scenario.settings, dropStatements(schema, scenario.settings.database))
  if (scenario.code && scenario.settings.language === 'java') files = withJavaRoundTrip(files, scenario.settings, scenario.code)
  if (scenario.code && scenario.settings.language === 'typescript') files = withRoundTrip(files, scenario.settings, scenario.code)
  const folder = join(work, scenario.id)
  rmSync(folder, { recursive: true, force: true })
  for (const file of files) {
    mkdirSync(dirname(join(folder, file.path)), { recursive: true })
    writeFileSync(join(folder, file.path), file.content)
  }
  console.log(`${scenario.id}: ${files.length} files`)
}
