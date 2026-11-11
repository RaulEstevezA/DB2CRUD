/**
 * The projects in shared/test-cases/outputs/, which the desktop version's generators must write too: one file
 * per verification scenario (verification/scenarios/index.mjs), with the schema, the decisions taken, the
 * settings and every file written. The same scenarios run in Docker, so these outputs are known to work.
 *
 * `UPDATE_SHARED=1 npx vitest run src/core/generators/shared.test.ts` writes them again from what the web
 * version does now; the desktop version then has to match them.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decidePolicy } from '../crud/edit.ts'
import { SHOP } from '../crud/fixtures.ts'
import { proposeCrud } from '../crud/propose.ts'
import type { DbSchema } from '../schema/types.ts'
import { generateProject } from './registry.ts'

// Tests run from web/
const FOLDER = resolve(process.cwd(), '../shared/test-cases/outputs')
const UPDATE = process.env.UPDATE_SHARED === '1'

interface Scenario {
  id: string
  schema: 'shop'
  settings: Record<string, unknown>
  decisions?: { table: string; decision: 'role' | 'delete' | 'concurrency' | 'children' | 'hidden'; value: unknown }[]
}

const SCHEMAS: Record<Scenario['schema'], DbSchema> = { shop: SHOP }
const { SCENARIOS } = (await import(resolve(process.cwd(), '../verification/scenarios/index.mjs'))) as { SCENARIOS: Scenario[] }

function project(scenario: Scenario) {
  const schema = SCHEMAS[scenario.schema]
  let design = proposeCrud(schema)
  for (const item of scenario.decisions ?? []) design = proposeCrud(schema, decidePolicy(design, item.table, item.decision, item.value))
  const settings = { name: scenario.id, ...scenario.settings }
  const files = Object.fromEntries(generateProject(schema, design, settings).map((file) => [file.path, file.content]))
  return { schema, decisions: scenario.decisions ?? [], settings, files }
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
