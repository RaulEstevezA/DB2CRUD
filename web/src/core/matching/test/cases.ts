/**
 * The shared cases of the matching (shared/test-cases/matching/<case>/), for tests only: schema.sql is the database,
 * models.<ext> the application models, read by the importers, or a Mapper project (models.mapper.json). A database of documents is in database.<ext>
 * instead, as its ORM or its validators write it.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readDdl } from '../../importers/ddl/ddl.ts'
import { readOrmCode } from '../../importers/orm/registry.ts'
import { detectFormat, parseInput } from '../../importers/registry.ts'
import { isMapperProject, mapperModels, readMapperProject, type MapperProject } from '../../interop/mapper/read.ts'
import type { ModelSchema } from '../../model/schema.ts'
import type { DbSchema } from '../../schema/types.ts'

export const MATCHING_CASES = resolve(process.cwd(), '../shared/test-cases/matching')

function databaseOf(folder: string): DbSchema {
  const file = readdirSync(folder).find((item) => item.startsWith('database.'))
  if (!file) return readDdl(readFileSync(join(folder, 'schema.sql'), 'utf8'))
  const read = readOrmCode([{ name: file, text: readFileSync(join(folder, file), 'utf8') }])
  if (!read.ok) throw new Error(`${file}: ${read.error}`)
  return read.schema
}

/** The database and the models of a case, with the Mapper project they come from when they do. */
export function readCase(folder: string): { database: DbSchema; models: ModelSchema; project: MapperProject | null } {
  const database = databaseOf(folder)
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
