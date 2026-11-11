import { allFields } from '../../model/schema.ts'
import { declaresUuidDefault } from '../../design/hints.ts'
import { findModelDesign, type KeyChoice } from '../../design/types.ts'
import { columnName, constraintName, freeName, tableName } from '../naming.ts'
import type { Column, ColumnType } from '../types.ts'
import type { Entity, RelationalBuild } from './build.ts'
import { fieldColumn, keyType, storesNull } from './names.ts'

/** The tables of the stored models, their keys and their scalar columns. */

export function addEntityTables(build: RelationalBuild) {
  const { schema, design, options, roles } = build
  for (const model of schema.models) {
    if (roles.get(model.name) !== 'stored') continue
    const item = findModelDesign(design, model.name)
    if (!item) continue
    const table = build.newTable(item.table ?? tableName(model.name, options.naming), 'entity', model.name)
    const entity: Entity = { model, table, design: item.fields, used: new Set(), key: null }
    build.entities.set(model.name, entity)
    // Field columns keep their names; a surrogate key takes a free one
    for (const { field, decided } of build.fieldsOf(entity))
      if (decided?.include && !decided.relation) entity.used.add(fieldColumn(field, decided, options).toLowerCase())
    const parents = (model.extends ?? []).filter((parent) => roles.get(parent) === 'parent')
    if (parents.length > 0) build.notes.push({ code: 'inheritedFields', params: { model: model.name, parents: parents.join(', ') } })
  }
}

/** New key columns, and the key of every table whose key is one of its fields. Keys go first, so the
 * columns that refer to them can take their type. Returns the key field of each model. */
export function addKeys(build: RelationalBuild): Map<string, string> {
  const keyFields = new Map<string, string>()
  for (const entity of build.entities.values()) {
    const decision = findModelDesign(build.design, entity.model.name)?.key
    if (!decision || decision.status === 'pending') {
      build.todo(entity.table, 'keyPending', { model: entity.model.name })
      continue
    }
    const key: KeyChoice = decision.value
    if (key.kind === 'surrogate') {
      const name = freeName(columnName('id', build.options.naming), entity.used)
      const type: ColumnType = key.type === 'uuid' ? { kind: 'primitive', name: 'uuid' } : { kind: 'primitive', name: 'integer', bits: 64 }
      entity.table.columns.push({ name, type, nullable: false, generated: key.type === 'uuid' ? 'uuid' : 'identity' })
      entity.table.primaryKey = [name]
      entity.key = { column: name, type }
    }
  }
  for (const entity of build.entities.values()) {
    const decision = findModelDesign(build.design, entity.model.name)?.key
    if (decision?.status !== 'active' || decision.value.kind !== 'field') continue
    const name = decision.value.field
    const field = allFields(build.schema, entity.model).find((item) => item.name === name)
    if (!field) continue
    const decided = entity.design.find((item) => item.field === name)
    keyFields.set(entity.model.name, name)
    entity.key = {
      column: fieldColumn(field, decided, build.options),
      type: keyType(build.typeOf(field, decided, `${entity.model.name}.${name}`)),
    }
  }
  return keyFields
}

/** One column per scalar field, with its key, unique and index settings. */
export function addScalarColumns(build: RelationalBuild, keyFields: Map<string, string>) {
  for (const entity of build.entities.values()) {
    const { table, model } = entity
    const keyField = keyFields.get(model.name) ?? null
    for (const { field, decided } of build.fieldsOf(entity)) {
      if (!decided?.include || decided.relation) continue
      const name = fieldColumn(field, decided, build.options)
      const isKey = field.name === keyField
      // A column holding another table's key has that key's type
      const fk =
        decided.foreignKey?.status === 'active' && decided.foreignKey.value ? build.entities.get(decided.foreignKey.value) : undefined
      const column: Column = {
        name,
        type:
          isKey && entity.key
            ? entity.key.type
            : fk?.key && !decided.type
              ? fk.key.type
              : build.typeOf(field, decided, `${model.name}.${field.name}`),
        nullable: isKey ? false : storesNull(field),
        source: `${model.name}.${field.name}`,
      }
      if (field.defaultValue !== undefined && !isKey) column.defaultValue = field.defaultValue
      if (field.generated && column.type.kind === 'primitive') {
        if (isKey && column.type.name === 'integer') column.generated = 'identity'
        if (isKey && column.type.name === 'uuid') column.generated = 'uuid'
        if (column.type.name === 'string' && declaresUuidDefault(field)) column.generated = 'uuid'
        if (!isKey && (column.type.name === 'datetime' || column.type.name === 'date')) column.generated = 'now'
      }
      table.columns.push(column)
      if (isKey) table.primaryKey = [name]
      if (decided.unique?.status === 'active' && decided.unique.value && !isKey)
        table.uniques.push({ name: constraintName('uq', table.name, [name]), columns: [name], unique: true })
      if (decided.index && !isKey) table.indexes.push({ name: constraintName('ix', table.name, [name]), columns: [name], unique: false })
    }
  }
}

/** Scalar fields that hold another model's key (`customerId` → customers). */
export function addScalarForeignKeys(build: RelationalBuild) {
  for (const entity of build.entities.values()) {
    for (const { field, decided } of build.fieldsOf(entity)) {
      const fk = decided?.foreignKey
      if (!decided?.include || !fk || fk.status !== 'active' || fk.value === null) continue
      const target = build.entities.get(fk.value)
      const column = fieldColumn(field, decided, build.options)
      if (target) build.foreignKey(entity.table, column, target)
      else build.todo(entity.table, 'targetNotStored', { field: field.name, model: fk.value })
    }
  }
}
