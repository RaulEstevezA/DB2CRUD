import type { ModelSchema } from '../model/schema.ts'
import type { Design } from '../design/types.ts'
import { modelRoles } from './roles.ts'
import { DEFAULT_PRECISION, RelationalBuild } from './relational/build.ts'
import { buildEnums, constrainEnumColumns } from './relational/enums.ts'
import { addRelations } from './relational/relations.ts'
import { addEntityTables, addKeys, addScalarColumns, addScalarForeignKeys } from './relational/tables.ts'
import { boundIndexedTexts } from './relational/textKeys.ts'
import type { BuildOptions, RelationalSchema } from './types.ts'

export { fieldColumn, storesNull } from './relational/names.ts'

/** Turns the active decisions of a design into tables, step by step. Pending decisions add a `todo` instead. */
export function buildRelational(schema: ModelSchema, design: Design, options: BuildOptions): RelationalSchema {
  const build = new RelationalBuild(schema, design, options, modelRoles(schema, design))
  addEntityTables(build)
  const keyFields = addKeys(build)
  addScalarColumns(build, keyFields)
  addScalarForeignKeys(build)
  addRelations(build)
  const { enums, lookups } = buildEnums(build)
  const tables = [...lookups, ...[...build.entities.values()].map((entity) => entity.table), ...build.extraTables]
  constrainEnumColumns(tables, enums, lookups)
  boundIndexedTexts(build, tables)
  if (build.decimals.length > 0)
    build.notes.push({
      code: 'defaultPrecision',
      params: { fields: build.decimals.join(', '), precision: `${DEFAULT_PRECISION.precision}, ${DEFAULT_PRECISION.scale}` },
    })
  return { kind: 'relational', tables, enums, notes: build.notes }
}
