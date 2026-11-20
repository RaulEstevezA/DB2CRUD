/**
 * The shared cases of the matching (shared/test-cases/matching/<case>/), for tests only: schema.sql is the database,
 * models.<ext> the application models, read by the importers.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readDdl } from '../../importers/ddl/ddl.ts'
import { detectFormat, parseInput } from '../../importers/registry.ts'

export const MATCHING_CASES = resolve(process.cwd(), '../shared/test-cases/matching')

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
