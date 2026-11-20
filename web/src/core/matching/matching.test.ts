/**
 * The matching of application models with tables against shared/test-cases/matching/<case>/: schema.sql is the
 * database, models.<ext> the application models (read by the importers), expected.json the matching, which the
 * desktop version must give too (`UPDATE_SHARED=1 npx vitest run src/core/matching` writes them again).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDdl } from '../importers/ddl/ddl.ts'
import { detectFormat, parseInput } from '../importers/registry.ts'
import { matchModels } from './matching.ts'

const FOLDER = resolve(process.cwd(), '../shared/test-cases/matching')
const UPDATE = process.env.UPDATE_SHARED === '1'

/** The database and the models of a case. */
export function readCase(folder: string) {
  const database = readDdl(readFileSync(join(folder, 'schema.sql'), 'utf8'))
  const name = readdirSync(folder).find((file) => file.startsWith('models.'))!
  const text = readFileSync(join(folder, name), 'utf8')
  const format = detectFormat(text, name)
  if (!format) throw new Error(`${name}: no format`)
  const models = parseInput(text, format)
  if (!models.ok) throw new Error(`${name}: ${models.error.code}`)
  return { database, models: models.schema }
}

describe('matching application models with tables', () => {
  for (const name of existsSync(FOLDER) ? readdirSync(FOLDER).sort() : [])
    it(name, () => {
      const folder = join(FOLDER, name)
      const { database, models } = readCase(folder)
      const matching = matchModels(database, models)
      const path = join(folder, 'expected.json')
      if (UPDATE) writeFileSync(path, `${JSON.stringify(matching, null, 1)}\n`)
      else expect(matching).toEqual(JSON.parse(readFileSync(path, 'utf8')))
    })
})
