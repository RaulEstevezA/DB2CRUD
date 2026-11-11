import { toSnakeCase } from '../model/naming.ts'
import { allFields, findModel, modelOf, type FieldDef, type ModelSchema, type TypeRef } from '../model/schema.ts'
import { findModelDesign, type Design, type FieldDesign } from '../design/types.ts'
import { keyHolder } from './document.ts'
import { columnName, constraintName, freeName, joinNames, tableName } from './naming.ts'
import { keyColumnName, ownedTableName } from './relational/names.ts'
import { modelRoles } from './roles.ts'
import type { CqlColumn, CqlTable, CqlType, NamingOptions, Note, Todo, WideColumnSchema } from './types.ts'

/** The CQL type of a scalar. A number without a size used as a key is a whole number. */
function scalarType(type: TypeRef, key = false): string {
  if (type.kind === 'enum') return 'text'
  if (type.kind !== 'primitive') return 'text'
  switch (type.name) {
    case 'integer':
      return type.bits === 64 ? 'bigint' : type.bits === 8 ? 'tinyint' : type.bits === 16 ? 'smallint' : 'int'
    case 'float':
      if (key && type.bits === undefined) return 'bigint'
      return type.bits === 32 ? 'float' : 'double'
    case 'decimal':
      return 'decimal'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'datetime':
      return 'timestamp'
    case 'time':
      return 'time'
    case 'duration':
      return 'duration'
    case 'uuid':
      return 'uuid'
    case 'binary':
      return 'blob'
    default:
      return 'text'
  }
}

/** Turns the active decisions of a design into Cassandra and ScyllaDB tables: one per stored model,
 * partitioned by its key; values kept in the row as user-defined types or collections; and, for a list of
 * other models, a table partitioned by the owner's key. `database` names the engine in the notes. */
export function buildWideColumn(schema: ModelSchema, design: Design, naming: NamingOptions, database: string): WideColumnSchema {
  const roles = modelRoles(schema, design)
  const notes: Note[] = []
  const tableNames = new Set<string>()
  const typeNames = new Set<string>()
  const tables: CqlTable[] = []
  const types: CqlType[] = []
  const udts = new Map<string, string>()
  const entities = new Map<string, CqlTable>()

  for (const model of schema.models) {
    const item = findModelDesign(design, model.name)
    // A model the design does not have yet (the model changed and the design follows a moment later) is left out
    if (roles.get(model.name) !== 'stored' || !item) continue
    const table: CqlTable = {
      name: freeName(item.table ?? tableName(model.name, naming), tableNames),
      model: model.name,
      kind: 'entity',
      columns: [],
      partitionKey: [],
      clusteringKey: [],
      indexes: [],
      todos: [],
    }
    entities.set(model.name, table)
    tables.push(table)
  }

  /** The key column of a stored model, as other rows hold it: its name and type. */
  const keyOf = (model: string): { column: string; type: string } | null => {
    const key = findModelDesign(design, model)?.key
    if (key?.status !== 'active') return null
    if (key.value.kind === 'surrogate') return { column: 'id', type: 'uuid' }
    const name = key.value.field
    const found = findModel(schema, model)
    const field = found && allFields(schema, found).find((item) => item.name === name)
    if (!field) return null
    const decided = findModelDesign(design, model)?.fields.find((item) => item.field === name)
    return { column: decided?.column ?? field.serializedName ?? columnName(name, naming), type: scalarType(field.type, true) }
  }

  /** The columns (or type fields) of some fields, with what they need: user-defined types, key columns, tables. */
  const columnsOf = (
    owner: FieldDef[],
    decisions: FieldDesign[],
    path: string[],
    source: string,
    used: Set<string>,
    todos: Todo[],
    table: CqlTable | null,
  ): CqlColumn[] => {
    const columns: CqlColumn[] = []
    for (const field of owner) {
      const decided = decisions.find((other) => other.field === field.name)
      if (decided && !decided.include) continue
      const fieldSource = `${source}.${field.name}`
      const relation = decided?.relation
      if (relation?.status === 'pending') {
        todos.push({ code: 'relationPending', params: { field: [...path, field.name].join('.') } })
        continue
      }
      const wanted =
        path.length > 0
          ? joinNames([...path, field.name], naming)
          : (decided?.column ?? field.serializedName ?? columnName(field.name, naming))
      const target = modelOf(field.type)
      const add = (name: string, type: string) => {
        const column = { name: freeName(name, used), type, source: fieldSource }
        columns.push(column)
        return column
      }
      if (relation && target && findModel(schema, target)) {
        if (relation.value === 'reference' || relation.value === 'child') {
          const key = entities.has(target) ? keyOf(target) : null
          if (!key) {
            todos.push({ code: 'targetNotStored', params: { field: field.name, model: target } })
            continue
          }
          if (relation.value === 'child' && table && path.length === 0) {
            childTable(table, field, target, key)
            continue
          }
          if (relation.value === 'child') {
            add(wanted, `list<${key.type}>`)
            continue
          }
          // `author` next to `authorId`: the key is already in that column
          if (path.length === 0 && table && keyHolder(field, owner, findModelDesign(design, table.model)!, { naming })) continue
          add(joinNames([...path, field.name, key.column], naming), key.type)
          continue
        }
        if (relation.value === 'embed') {
          const udt = typeOf(target)
          add(wanted, field.type.kind === 'array' ? `list<frozen<${udt}>>` : `frozen<${udt}>`)
          continue
        }
        if (relation.value === 'flatten') {
          const inner = findModel(schema, target)!
          columns.push(
            ...columnsOf(
              allFields(schema, inner),
              findModelDesign(design, target)?.fields ?? [],
              [...path, field.name],
              fieldSource,
              used,
              todos,
              null,
            ),
          )
          continue
        }
      }
      if (relation?.value === 'array') {
        if (field.type.kind === 'array') add(wanted, `list<${scalarType(field.type.items)}>`)
        else if (field.type.kind === 'map') add(wanted, `map<${scalarType(field.type.key)}, ${scalarType(field.type.value)}>`)
        continue
      }
      // JSON, free values and plain fields
      add(wanted, relation ? 'text' : scalarType(field.type))
      if (table && path.length === 0 && !relation) {
        const unique = decided?.unique?.status === 'active' && decided.unique.value
        if (unique) notes.push({ code: 'uniqueInApplication', params: { database, field: fieldSource } })
        const isKey = table.partitionKey.includes(columns[columns.length - 1].name)
        if ((unique || decided?.index) && !isKey) {
          const column = columns[columns.length - 1].name
          table.indexes.push({ name: constraintName('ix', table.name, [column]), column })
        }
      }
    }
    return columns
  }

  /** The user-defined type of a model kept inside rows; made once, after the types it uses. */
  const typeOf = (model: string): string => {
    const known = udts.get(model)
    if (known) return known
    const name = freeName(toSnakeCase(model), typeNames)
    udts.set(model, name)
    const found = findModel(schema, model)!
    const fields = columnsOf(allFields(schema, found), findModelDesign(design, model)?.fields ?? [], [], model, new Set(), [], null)
    types.push({ name, fields: fields.map(({ name: field, type }) => ({ name: field, type })) })
    return name
  }

  /** `User.posts`: a table partitioned by the user's key, with the key of each post. */
  const childTable = (owner: CqlTable, field: FieldDef, target: string, key: { column: string; type: string }) => {
    const ownerKey = keyOf(owner.model)
    if (!ownerKey) return
    const used = new Set<string>()
    const ownerColumn = freeName(keyColumnName(owner.model, ownerKey.column, { naming }), used)
    const targetColumn = freeName(keyColumnName(target, key.column, { naming }), used)
    tables.push({
      name: freeName(ownedTableName(owner.model, field.name, { naming }), tableNames),
      model: owner.model,
      kind: 'child',
      columns: [
        { name: ownerColumn, type: ownerKey.type, source: `${owner.model}.${field.name}` },
        { name: targetColumn, type: key.type, source: `${owner.model}.${field.name}` },
      ],
      partitionKey: [ownerColumn],
      clusteringKey: [targetColumn],
      indexes: [],
      todos: [],
    })
  }

  for (const [modelName, table] of entities) {
    const model = findModel(schema, modelName)!
    const item = findModelDesign(design, modelName)!
    const used = new Set<string>()
    const key = item.key
    if (!key || key.status === 'pending') table.todos.push({ code: 'keyPending', params: { model: modelName } })
    else if (key.value.kind === 'surrogate') {
      const name = freeName('id', used)
      table.columns.push({ name, type: 'uuid' })
      table.partitionKey = [name]
    } else {
      const keyField = keyOf(modelName)
      if (keyField) table.partitionKey = [keyField.column]
    }
    const columns = columnsOf(allFields(schema, model), item.fields, [], modelName, used, table.todos, table)
    // The key column takes the key's type: a number without a size is a whole number there
    const keyField = key?.status === 'active' && key.value.kind === 'field' ? keyOf(modelName) : null
    for (const column of columns) if (keyField && column.name === keyField.column) column.type = keyField.type
    table.columns.push(...columns)
  }
  return { kind: 'widecolumn', types, tables, notes }
}
