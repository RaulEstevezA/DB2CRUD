/**
 * The projects in shared/test-cases/outputs/, which the desktop version's generators must write too: one file
 * per verification scenario (verification/scenarios/index.mjs), with the schema, the decisions taken, the
 * settings, the application models of a scenario that has them, and every file written. The same scenarios run in
 * Docker, so these outputs are known to work.
 *
 * `UPDATE_SHARED=1 npx vitest run src/core/generators/shared.test.ts` writes them again from what the web
 * version does now; the desktop version then has to match them.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decidePolicy } from '../crud/edit.ts'
import { SHOP } from '../crud/fixtures.ts'
import { proposeCrud } from '../crud/propose.ts'
import { readOrmCode } from '../importers/orm/registry.ts'
import { readDdl } from '../importers/ddl/ddl.ts'
import { readModel2DBProject } from '../interop/model2db/read.ts'
import { scenarioProject, type ScenarioProject } from '../interop/model2db/test/fixtures.ts'
import type { DbSchema } from '../schema/types.ts'
import { MATCHING_CASES, readCase } from '../matching/test/cases.ts'
import { generateProject } from './registry.ts'

// Tests run from web/
const FOLDER = resolve(process.cwd(), '../shared/test-cases/outputs')
const UPDATE = process.env.UPDATE_SHARED === '1'

interface Scenario {
  id: string
  schema?: 'shop'
  /** A shared case of the matching, with its database and application models */
  case?: string
  /** The database of verification/ddl/, read from its SQL */
  ddl?: true
  /** A file or folder, from verification/, with the code the schema is read from */
  code?: string
  /** A Model2DB project (interop/model2db/test/fixtures.ts) */
  model2db?: ScenarioProject
  settings: Record<string, unknown>
  decisions?: { table: string; decision: 'role' | 'delete' | 'concurrency' | 'children' | 'hidden'; value: unknown }[]
}

const SCHEMAS: Record<'shop', DbSchema> = { shop: SHOP }
const { SCENARIOS } = (await import(resolve(process.cwd(), '../verification/scenarios/index.mjs'))) as { SCENARIOS: Scenario[] }

const ddlOf = (scenario: Scenario) => readFileSync(resolve(process.cwd(), `../verification/ddl/${scenario.settings.database}.sql`), 'utf8')

function readCode(path: string): DbSchema {
  const full = resolve(process.cwd(), '../verification', path)
  const files = statSync(full).isDirectory()
    ? readdirSync(full)
        .filter((name) => name !== 'expected.json')
        .sort()
        .map((name) => join(full, name))
    : [full]
  const read = readOrmCode(files.map((file) => ({ name: file, text: readFileSync(file, 'utf8') })))
  if (!read.ok) throw new Error(`${path}: ${read.error}`)
  return read.schema
}

function readModel2DB(scenario: ScenarioProject): DbSchema {
  const read = readModel2DBProject(scenarioProject(scenario))
  if (!read.ok) throw new Error(`${scenario.models} with ${scenario.output}: ${read.error}`)
  return read.schema
}

/** The schema of a scenario that does not come from a shared case. */
function schemaOf(scenario: Scenario): DbSchema {
  if (scenario.model2db) return readModel2DB(scenario.model2db)
  if (scenario.code) return readCode(scenario.code)
  if (scenario.ddl) return readDdl(ddlOf(scenario), scenario.settings.database as Parameters<typeof readDdl>[1])
  return SCHEMAS[scenario.schema ?? 'shop']
}

function project(scenario: Scenario) {
  const shared = scenario.case ? readCase(join(MATCHING_CASES, scenario.case)) : null
  const schema = shared ? shared.database : schemaOf(scenario)
  const models = shared ? { schema: shared.models, project: shared.project } : null
  let design = proposeCrud(schema, null, models?.schema ?? null, models?.project ?? null)
  for (const item of scenario.decisions ?? [])
    design = proposeCrud(
      schema,
      decidePolicy(design, item.table, item.decision, item.value),
      models?.schema ?? null,
      models?.project ?? null,
    )
  const settings = { name: scenario.id, ...scenario.settings }
  const files = Object.fromEntries(generateProject(schema, design, settings, models).map((file) => [file.path, file.content]))
  return { schema, decisions: scenario.decisions ?? [], settings, ...(models ? { models } : {}), files }
}

describe('shared outputs', () => {
  if (UPDATE) {
    rmSync(FOLDER, { recursive: true, force: true })
    mkdirSync(FOLDER, { recursive: true })
  }
  for (const scenario of SCENARIOS) {
    it(scenario.id, () => {
      const path = join(FOLDER, `${scenario.id}.json`)
      const current = project(scenario)
      if (UPDATE) return writeFileSync(path, `${JSON.stringify(current, null, 1)}\n`)
      expect(current).toEqual(JSON.parse(readFileSync(path, 'utf8')))
    })
  }

  it('has a file for every scenario and no other', () => {
    if (UPDATE) return
    expect(readdirSync(FOLDER).sort()).toEqual(SCENARIOS.map((scenario) => `${scenario.id}.json`).sort())
  })
})
