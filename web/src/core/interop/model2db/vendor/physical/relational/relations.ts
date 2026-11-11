import { nameWords, toSnakeCase } from '../../model/naming.ts'
import { allFields, findModel, type FieldDef, type TypeRef } from '../../model/schema.ts'
import { singularField } from '../../design/analysis.ts'
import { findModelDesign, type FieldDesign } from '../../design/types.ts'
import { columnName, freeName, joinNames } from '../naming.ts'
import type { ColumnType, Table } from '../types.ts'
import type { Entity, RelationalBuild } from './build.ts'
import { DEFAULT_LENGTH, fieldColumn, keyColumnName, ownedTableName, storesNull } from './names.ts'

/** The fields that hold other models, lists or maps, as the design decided to store them: columns,
 * foreign keys, child tables and join tables. */
export function addRelations(build: RelationalBuild) {
  const joins = new Set<string>()
  // Lists whose foreign key is the child's own reference, which may be built later
  const inverses: { table: Table; field: string; inverse: string }[] = []
  for (const entity of build.entities.values()) {
    for (const { field, decided } of build.fieldsOf(entity)) {
      const relation = decided?.relation
      if (!decided?.include || !relation) continue
      if (relation.status === 'pending') {
        build.todo(entity.table, 'relationPending', { field: field.name })
        continue
      }
      const items = field.type.kind === 'array' ? field.type.items : field.type.kind === 'map' ? field.type.value : field.type
      const targetName = items.kind === 'model' ? items.name : null
      const target = targetName ? build.entities.get(targetName) : undefined
      const missing = () => build.todo(entity.table, 'targetNotStored', { field: field.name, model: targetName ?? '' })
      switch (relation.value) {
        case 'json':
          addColumn(build, entity, field, decided, { kind: 'json' })
          break
        case 'array':
          addArray(build, entity, field, decided, items)
          break
        case 'flatten':
          if (targetName)
            flatten(
              build,
              entity.table,
              entity.used,
              [decided.column ?? field.name],
              targetName,
              storesNull(field),
              `${entity.model.name}.${field.name}`,
              new Set([entity.model.name]),
            )
          break
        case 'reference':
          if (target) reference(build, entity, field, decided, target)
          else missing()
          break
        case 'child':
          if (targetName) {
            if (target) childModels(build, entity, field, target, inverses)
            else missing()
          } else childValues(build, entity, field, decided, items, field.type.kind === 'map')
          break
        case 'join':
          if (target) join(build, entity, field, target, joins)
          else missing()
          break
        case 'embed':
          // Only for documents
          break
      }
    }
  }
  for (const item of inverses) {
    const fk = item.table.foreignKeys.find((candidate) => candidate.field === item.field)
    if (fk) fk.inverse = item.inverse
  }
}

function addColumn(build: RelationalBuild, entity: Entity, field: FieldDef, decided: FieldDesign, type: ColumnType) {
  entity.table.columns.push({
    name: freeName(fieldColumn(field, decided, build.options), entity.used),
    type,
    nullable: storesNull(field),
    source: `${entity.model.name}.${field.name}`,
  })
}

/** A native array column in PostgreSQL; JSON in the others, with a note. */
function addArray(build: RelationalBuild, entity: Entity, field: FieldDef, decided: FieldDesign, items: TypeRef) {
  const path = `${entity.model.name}.${field.name}`
  if (build.options.dialect !== 'postgresql') {
    build.notes.push({ code: 'arrayAsJson', params: { field: path } })
    addColumn(build, entity, field, decided, { kind: 'json' })
  } else addColumn(build, entity, field, decided, { kind: 'array', items: build.columnType(items, field, path) })
}

/** Columns of a value object, prefixed with the field that holds it: `address_city`. */
function flatten(
  build: RelationalBuild,
  table: Table,
  used: Set<string>,
  prefix: string[],
  target: string,
  nullable: boolean,
  path: string,
  seen: Set<string>,
) {
  const model = findModel(build.schema, target)
  if (!model || seen.has(target)) return
  for (const field of allFields(build.schema, model)) {
    const fieldPath = `${path}.${field.name}`
    const optional = nullable || storesNull(field)
    if (field.type.kind === 'model') {
      flatten(build, table, used, [...prefix, field.name], field.type.name, optional, fieldPath, new Set([...seen, target]))
      continue
    }
    table.columns.push({
      name: freeName(joinNames([...prefix, field.name], build.options.naming), used),
      type: build.columnType(field.type, field, fieldPath),
      nullable: optional,
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      source: fieldPath,
    })
  }
}

/** A foreign key to another stored model (many-to-one). */
function reference(build: RelationalBuild, entity: Entity, field: FieldDef, decided: FieldDesign, target: Entity) {
  // `customer: Customer` next to `customerId` (or Prisma's `@relation(fields: [customerId])`): reuse it
  const existing = existingKeyColumn(build, entity, field)
  if (existing) {
    build.foreignKey(entity.table, existing, target, undefined, { field: field.name })
    return
  }
  if (!target.key) {
    build.todo(entity.table, 'foreignKeyTargetNotStored', { column: field.name, model: target.model.name })
    return
  }
  const name = freeName(keyColumnName(decided.column ?? field.name, target.key.column, build.options), entity.used)
  entity.table.columns.push({ name, type: target.key.type, nullable: storesNull(field), source: `${entity.model.name}.${field.name}` })
  build.foreignKey(entity.table, name, target, undefined, { field: field.name })
}

/** The scalar column that already holds the key of a referenced model: `customerId` next to `customer`,
 * or the one Prisma names in `@relation(fields: [...])`. */
function existingKeyColumn(build: RelationalBuild, entity: Entity, field: FieldDef): string | null {
  const relation = field.annotations?.find((item) => item.name === 'relation')
  const named = relation?.args ? /fields\s*:\s*\[\s*(\w+)/.exec(relation.args)?.[1] : undefined
  const words = [...nameWords(field.name), 'id'].join('')
  for (const { field: other, decided } of build.fieldsOf(entity)) {
    if (!decided?.include || decided.relation || other.name === field.name) continue
    if (other.name === named || nameWords(other.name).join('') === words) return fieldColumn(other, decided, build.options)
  }
  return null
}

/** A list of models stored in their own table, pointing back to the owner (one-to-many). */
function childModels(
  build: RelationalBuild,
  owner: Entity,
  field: FieldDef,
  child: Entity,
  inverses: { table: Table; field: string; inverse: string }[],
) {
  if (!owner.key) {
    build.todo(owner.table, 'keyPending', { model: owner.model.name })
    return
  }
  // A field of the child that already points to the owner
  if (child.model.name !== owner.model.name) {
    const ownerWords = nameWords(owner.model.name).join('')
    for (const { field: back, decided } of build.fieldsOf(child)) {
      if (!decided?.include) continue
      if (back.type.kind === 'model' && back.type.name === owner.model.name) {
        // The child's own reference creates the foreign key; this list is its other side
        if (decided.relation?.status === 'active' && decided.relation.value === 'reference') {
          inverses.push({ table: child.table, field: back.name, inverse: field.name })
          return
        }
        continue
      }
      const words = nameWords(back.name)
      if (
        back.type.kind === 'primitive' &&
        words.length > 1 &&
        words[words.length - 1] === 'id' &&
        words.slice(0, -1).join('') === ownerWords
      ) {
        build.foreignKey(child.table, fieldColumn(back, decided, build.options), owner, undefined, { inverse: field.name })
        return
      }
    }
  }
  const self = child.model.name === owner.model.name
  const name = freeName(keyColumnName(self ? 'parent' : owner.model.name, owner.key.column, build.options), child.used)
  // Rows that only exist inside this list go with their owner; shared ones stay
  const owned =
    !self && !findModelDesign(build.design, child.model.name)?.key?.reasons.some((r) => r.code === 'keyDeclared' || r.code === 'keyNamed')
  child.table.columns.push({ name, type: owner.key.type, nullable: self || !owned, source: `${owner.model.name}.${field.name}` })
  build.foreignKey(
    child.table,
    name,
    owner,
    owned ? 'cascade' : undefined,
    self ? { field: 'parent', inverse: field.name } : { inverse: field.name },
  )
}

/** A list of plain values (one row per value, in order) or a map (one row per key). */
function childValues(build: RelationalBuild, owner: Entity, field: FieldDef, decided: FieldDesign, items: TypeRef, map: boolean) {
  if (!owner.key) {
    build.todo(owner.table, 'keyPending', { model: owner.model.name })
    return
  }
  const { options } = build
  const table = build.newTable(
    ownedTableName(owner.model.name, decided.column ?? field.name, options),
    map ? 'map' : 'list',
    owner.model.name,
    field.name,
  )
  const used = new Set<string>()
  const ownerColumn = freeName(keyColumnName(owner.model.name, owner.key.column, options), used)
  const second = map
    ? {
        name: freeName(columnName('key', options.naming), used),
        type: { kind: 'primitive', name: 'string', length: DEFAULT_LENGTH } as ColumnType,
      }
    : { name: freeName(columnName('position', options.naming), used), type: { kind: 'primitive', name: 'integer', bits: 32 } as ColumnType }
  const path = `${owner.model.name}.${field.name}`
  table.columns.push(
    { name: ownerColumn, type: owner.key.type, nullable: false },
    { ...second, nullable: false },
    {
      name: freeName(columnName('value', options.naming), used),
      type: build.columnType(items, field, path),
      nullable: map || (field.type.kind === 'array' && field.type.itemsNullable === true),
      ...(map ? {} : { source: path }),
    },
  )
  table.primaryKey = [ownerColumn, second.name]
  build.foreignKey(table, ownerColumn, owner, 'cascade', { inverse: field.name })
  build.extraTables.push(table)
}

/** A many-to-many list: a table with the keys of both sides. Both lists of a pair share it. */
function join(build: RelationalBuild, owner: Entity, field: FieldDef, other: Entity, joins: Set<string>) {
  if (!owner.key || !other.key) {
    build.todo(owner.table, 'keyPending', { model: (owner.key ? other : owner).model.name })
    return
  }
  const self = owner.model.name === other.model.name
  const mirror = self
    ? undefined
    : build
        .fieldsOf(other)
        .find(
          ({ field: item, decided }) =>
            item.type.kind === 'array' &&
            item.type.items.kind === 'model' &&
            item.type.items.name === owner.model.name &&
            decided?.include &&
            decided.relation?.status === 'active' &&
            decided.relation.value === 'join',
        )?.field
  const pair = [`${owner.model.name}.${field.name}`, mirror ? `${other.model.name}.${mirror.name}` : ''].sort().join('|')
  if (joins.has(pair)) return
  joins.add(pair)
  const names = self ? [owner.table.name, toSnakeCase(field.name)] : [owner.table.name, other.table.name].sort()
  const table = build.newTable(names.join('_'), 'join', owner.model.name, field.name)
  if (mirror) table.mirror = mirror.name
  const used = new Set<string>()
  const first = freeName(keyColumnName(owner.model.name, owner.key.column, build.options), used)
  const second = freeName(keyColumnName(self ? singularField(field.name) : other.model.name, other.key.column, build.options), used)
  table.columns.push({ name: first, type: owner.key.type, nullable: false }, { name: second, type: other.key.type, nullable: false })
  table.primaryKey = [first, second]
  build.foreignKey(table, first, owner, 'cascade')
  build.foreignKey(table, second, other, 'cascade')
  // The primary key already indexes the first column
  table.indexes = table.indexes.filter((index) => index.columns[0] !== first)
  build.extraTables.push(table)
}
