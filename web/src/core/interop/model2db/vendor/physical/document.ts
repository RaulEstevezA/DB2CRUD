import { nameWords } from '../model/naming.ts'
import { allFields, findEnum, findModel, type FieldDef, type ModelSchema, type TypeRef } from '../model/schema.ts'
import { findModelDesign, type Design, type ModelDesign } from '../design/types.ts'
import { columnName, constraintName, freeName, tableName } from './naming.ts'
import { modelRoles } from './roles.ts'
import type { BsonSchema, NamingOptions, Collection, DocumentSchema, Index, Note, Todo } from './types.ts'

const PRIMITIVE_BSON: Record<string, string | undefined> = {
  string: 'string',
  integer: 'int',
  float: 'double',
  decimal: 'decimal',
  boolean: 'bool',
  date: 'date',
  datetime: 'date',
  time: 'string',
  duration: 'string',
  uuid: 'string',
  binary: 'binData',
  any: undefined,
}

/** Turns the active decisions of a design into MongoDB collections with a `$jsonSchema` validator and
 * their indexes. Embedded models become nested objects; references hold the other document's `_id`. */
export function buildDocument(schema: ModelSchema, design: Design, naming: NamingOptions): DocumentSchema {
  const options = { naming }
  const roles = modelRoles(schema, design)
  const notes: Note[] = []
  const used = new Set<string>()
  const collections: Collection[] = []
  const names = new Map<string, string>()
  for (const model of schema.models) {
    const item = findModelDesign(design, model.name)
    // A model the design does not have yet (the model changed and the design follows a moment later) is left out
    if (roles.get(model.name) !== 'stored' || !item) continue
    names.set(model.name, freeName(item.table ?? tableName(model.name, options.naming), used))
  }

  /** The type of the `_id` other documents store to refer to a model. */
  const idType = (model: string): BsonSchema => {
    const key = findModelDesign(design, model)?.key
    if (key?.status === 'active' && key.value.kind === 'field') {
      const found = findModel(schema, model)
      const field = found && allFields(schema, found).find((item) => item.name === (key.value as { field: string }).field)
      if (field) return keySchema(field.type)
    }
    return { bsonType: 'objectId' }
  }

  interface Scope {
    todos: Todo[]
    indexes: Index[]
    collection: string
  }

  const typeSchema = (type: TypeRef, nullable: boolean, seen: Set<string>, path: string[], scope: Scope): BsonSchema => {
    const withNull = (bson: BsonSchema): BsonSchema => {
      if (!nullable) return bson
      if (bson.enum) return { ...bson, enum: [...bson.enum, null] }
      if (bson.bsonType === undefined) return bson
      return { ...bson, bsonType: [...(Array.isArray(bson.bsonType) ? bson.bsonType : [bson.bsonType]), 'null'] }
    }
    switch (type.kind) {
      case 'primitive': {
        const bsonType = type.name === 'integer' && type.bits === 64 ? 'long' : PRIMITIVE_BSON[type.name]
        return withNull(bsonType ? { bsonType } : {})
      }
      case 'enum': {
        const definition = findEnum(schema, type.name)
        return withNull(definition ? { enum: definition.values.map((value) => value.value ?? value.name) } : { bsonType: 'string' })
      }
      case 'array':
        return withNull({ bsonType: 'array', items: typeSchema(type.items, type.itemsNullable === true, seen, path, scope) })
      case 'map':
        return withNull({ bsonType: 'object', additionalProperties: typeSchema(type.value, false, seen, path, scope) })
      case 'unknown':
        return {}
      case 'model': {
        if (seen.has(type.name)) {
          notes.push({ code: 'cycleEmbedded', params: { model: type.name } })
          return withNull({ bsonType: 'object' })
        }
        return withNull(objectSchema(type.name, new Set([...seen, type.name]), path, scope, false))
      }
    }
  }

  /** The validator of a model: its fields, embedded models inside, references as ids. */
  const objectSchema = (model: string, seen: Set<string>, path: string[], scope: Scope, root: boolean): BsonSchema => {
    const found = findModel(schema, model)
    const item = findModelDesign(design, model)
    if (!found || !item) return { bsonType: 'object' }
    const properties: Record<string, BsonSchema> = {}
    const required: string[] = []
    const key = item.key?.status === 'active' ? item.key.value : null
    if (root) {
      properties._id = key?.kind === 'field' ? {} : { bsonType: 'objectId' }
      required.push('_id')
    }
    for (const field of allFields(schema, found)) {
      const decided = item.fields.find((other) => other.field === field.name)
      if (decided && !decided.include) continue
      const isKey = root && key?.kind === 'field' && key.field === field.name
      const name = isKey ? '_id' : (decided?.column ?? field.serializedName ?? columnName(field.name, options.naming))
      const fieldPath = [...path, name]
      const optional = field.nullable || field.optional
      const relation = decided?.relation
      if (relation?.status === 'pending') {
        scope.todos.push({ code: 'relationPending', params: { field: [...path, field.name].join('.') } })
        continue
      }
      // Kept on the other side: the other collection stores this document's id (and indexes it)
      if (relation?.value === 'child') continue
      let bson: BsonSchema
      if (relation?.value === 'reference') {
        const target = referenceTarget(field.type)
        if (!target || !names.has(target)) {
          scope.todos.push({ code: 'targetNotStored', params: { field: field.name, model: target ?? '' } })
          continue
        }
        // `author` next to `authorId` (Prisma's `@relation(fields: [authorId])`): the id is already stored there
        const holder = keyHolder(field, allFields(schema, found), item, options)
        if (holder) {
          addIndex(scope, [...path, holder], false)
          continue
        }
        const id = idType(target)
        bson = field.type.kind === 'array' ? { bsonType: 'array', items: id } : id
        if (field.nullable) bson = nullableOf(bson)
        // Lookups go from the document to the one it refers to; a list of ids is read with its document
        if (field.type.kind !== 'array') addIndex(scope, fieldPath, false)
      } else bson = isKey ? keySchema(field.type) : typeSchema(field.type, field.nullable, seen, fieldPath, scope)
      if (field.description) bson.description = field.description
      properties[name] = bson
      if (!optional || isKey) {
        if (!required.includes(name)) required.push(name)
      }
      if (!isKey && decided?.unique?.status === 'active' && decided.unique.value) addIndex(scope, fieldPath, true)
      if (!isKey && decided?.index) addIndex(scope, fieldPath, false)
    }
    return { bsonType: 'object', ...(required.length > 0 ? { required } : {}), properties, additionalProperties: false }
  }

  const addIndex = (scope: Scope, path: string[], unique: boolean) => {
    const columns = [path.join('.')]
    if (scope.indexes.some((index) => index.columns[0] === columns[0])) return
    scope.indexes.push({ name: constraintName(unique ? 'uq' : 'ix', scope.collection, [path.join('_')]), columns, unique })
  }

  for (const model of schema.models) {
    const name = names.get(model.name)
    if (!name) continue
    const item = findModelDesign(design, model.name) as ModelDesign
    const scope: Scope = { todos: [], indexes: [], collection: name }
    if (item.key?.status === 'pending') scope.todos.push({ code: 'keyPending', params: { model: model.name } })
    const validator = objectSchema(model.name, new Set([model.name]), [], scope, true)
    collections.push({ name, model: model.name, validator, indexes: scope.indexes, todos: scope.todos })
  }
  return { kind: 'document', collections, notes: dedupe(notes) }
}

/** A scalar field next to a reference that already holds the referenced id. */
export function keyHolder(field: FieldDef, fields: FieldDef[], item: ModelDesign, options: { naming: NamingOptions }): string | null {
  const relation = field.annotations?.find((annotation) => annotation.name === 'relation')
  const named = relation?.args ? /fields\s*:\s*\[\s*(\w+)/.exec(relation.args)?.[1] : undefined
  const words = [...nameWords(field.name), 'id'].join('')
  const holder = fields.find((other) => {
    const decided = item.fields.find((candidate) => candidate.field === other.name)
    return (
      other.name !== field.name &&
      decided?.include !== false &&
      !decided?.relation &&
      (other.name === named || nameWords(other.name).join('') === words)
    )
  })
  return holder
    ? (item.fields.find((candidate) => candidate.field === holder.name)?.column ??
        holder.serializedName ??
        columnName(holder.name, options.naming))
    : null
}

/** A number without a size (TypeScript's `number`) used as an id is stored as a whole number. */
function keySchema(type: TypeRef): BsonSchema {
  if (type.kind !== 'primitive') return {}
  if ((type.name === 'float' && type.bits === undefined) || (type.name === 'integer' && type.bits === 64)) return { bsonType: 'long' }
  const bsonType = PRIMITIVE_BSON[type.name]
  return bsonType ? { bsonType } : {}
}

function referenceTarget(type: TypeRef): string | null {
  if (type.kind === 'model') return type.name
  if (type.kind === 'array' && type.items.kind === 'model') return type.items.name
  return null
}

function nullableOf(bson: BsonSchema): BsonSchema {
  if (bson.bsonType === undefined) return bson
  return { ...bson, bsonType: [...(Array.isArray(bson.bsonType) ? bson.bsonType : [bson.bsonType]), 'null'] }
}

function dedupe(notes: Note[]): Note[] {
  const seen = new Set<string>()
  return notes.filter((note) => {
    const key = JSON.stringify(note)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
