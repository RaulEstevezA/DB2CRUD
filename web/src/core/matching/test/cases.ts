/**
 * The shared cases of the matching (shared/test-cases/matching/<case>/), for tests only: schema.sql is the database,
 * models.<ext> the application models, read by the importers, or a Mapper project (models.mapper.json).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readDdl } from '../../importers/ddl/ddl.ts'
import { detectFormat, parseInput } from '../../importers/registry.ts'
import { isMapperProject, mapperModels, readMapperProject, type MapperProject } from '../../interop/mapper/read.ts'
import type { ModelSchema } from '../../model/schema.ts'
import type { DbSchema } from '../../schema/types.ts'

export const MATCHING_CASES = resolve(process.cwd(), '../shared/test-cases/matching')

/** The database and the models of a case, with the Mapper project they come from when they do. */
export function readCase(folder: string): { database: DbSchema; models: ModelSchema; project: MapperProject | null } {
  const database = readDdl(readFileSync(join(folder, 'schema.sql'), 'utf8'))
  const name = readdirSync(folder).find((file) => file.startsWith('models.'))!
  const text = readFileSync(join(folder, name), 'utf8')
  if (isMapperProject(text)) {
    const read = readMapperProject(text)
    if (!read.ok) throw new Error(`${name}: ${read.error} ${read.path ?? ''}`)
    return { database, models: mapperModels(read.project), project: read.project }
  }
  const format = detectFormat(text, name)
  if (!format) throw new Error(`${name}: no format`)
  const models = parseInput(text, format)
  if (!models.ok) throw new Error(`${name}: ${models.error.code}`)
  return { database, models: models.schema, project: null }
}
