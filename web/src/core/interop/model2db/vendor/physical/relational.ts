import type { ModelSchema } from '../model/schema.ts'
import { findModelDesign, type Design } from '../design/types.ts'
import { addQueryIndexes } from './queryIndexes.ts'
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
  addQueries(build)
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

/** The index of each query the user accepted, on the model's table. */
function addQueries(build: RelationalBuild) {
  let indexed = false
  for (const { model, table } of build.entities.values()) {
    const queries = findModelDesign(build.design, model.name)?.queries ?? []
    const source = (field: string) => `${model.name}.${field}`
    const added = addQueryIndexes(
      {
        name: table.name,
        model: model.name,
        columnOf: (field) =>
          table.columns.find((column) => column.source === source(field))?.name ??
          table.foreignKeys.find((key) => key.field === field && key.columns.length === 1)?.columns[0],
        indexes: table.indexes,
        covering: [{ name: '', columns: table.primaryKey, unique: true }, ...table.uniques],
        pending: (query) => build.todo(table, 'queryPending', { model: model.name, query }),
      },
      queries,
      build.notes,
    )
    indexed ||= added
  }
  if (indexed) build.notes.push({ code: 'queryIndexes', params: {} })
}
