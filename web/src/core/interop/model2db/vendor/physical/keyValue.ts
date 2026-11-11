import { allFields, findEnum, findModel, modelOf, type FieldDef, type ModelSchema, type TypeRef } from '../model/schema.ts'
import { findModelDesign, type Design, type FieldDesign } from '../design/types.ts'
import { keyHolder } from './document.ts'
import { storesNull } from './relational/names.ts'
import { columnName, freeName, joinNames, tableName } from './naming.ts'
import { modelRoles } from './roles.ts'
import type { HashField, KeyEntry, KeyValueHolds, KeyValueSchema, NamingOptions, Note, SearchField } from './types.ts'

/** Turns the active decisions of a design into Redis keys: a hash for each stored model under
 * `prefix:<key>`, with lists, sets and hashes of its own under that key, and a search index on the fields
 * other keys point to and the ones the user indexed. Redis keeps every value as text; the description
 * says what each one holds. */
export function buildKeyValue(schema: ModelSchema, design: Design, naming: NamingOptions): KeyValueSchema {
  const roles = modelRoles(schema, design)
  const notes: Note[] = []
  const used = new Set<string>()
  const prefixes = new Map<string, string>()
  for (const model of schema.models) {
    const item = findModelDesign(design, model.name)
    // A model the design does not have yet (the model changed and the design follows a moment later) is left out
    if (roles.get(model.name) !== 'stored' || !item) continue
    prefixes.set(model.name, freeName(item.table ?? tableName(model.name, naming), used))
  }

  const holdsOf = (type: TypeRef): KeyValueHolds => {
    if (type.kind !== 'primitive') return type.kind === 'enum' ? 'text' : 'json'
    switch (type.name) {
      case 'integer':
      case 'float':
      case 'decimal':
        return 'number'
      case 'boolean':
        return 'boolean'
      case 'date':
      case 'datetime':
        return 'date'
      case 'any':
        return 'json'
      default:
        return 'text'
    }
  }

  const entries: KeyEntry[] = []
  for (const model of schema.models) {
    const prefix = prefixes.get(model.name)
    if (!prefix) continue
    const item = findModelDesign(design, model.name)!
    const entry: KeyEntry = { model: model.name, prefix, keyField: null, newKey: null, fields: [], structures: [], search: [], todos: [] }
    const key = item.key
    if (!key || key.status === 'pending') entry.todos.push({ code: 'keyPending', params: { model: model.name } })
    else if (key.value.kind === 'surrogate') entry.newKey = key.value.type === 'uuid' ? 'uuid' : 'counter'
    const fieldNames = new Set<string>()
    const search = (field: string, type: SearchField['type']) => {
      if (!entry.search.some((other) => other.field === field)) entry.search.push({ field, type })
    }
    const fields = allFields(schema, model)
    // `customer` next to `customerId`: the key goes in that field, which points to the customer
    const holders = new Map<string, string>()
    for (const field of fields) {
      const decided = item.fields.find((other) => other.field === field.name)
      const target = modelOf(field.type)
      if (decided?.include === false || decided?.relation?.status !== 'active' || decided.relation.value !== 'reference' || !target)
        continue
      const holder = keyHolder(field, fields, item, { naming })
      const refers = prefixes.get(target)
      if (holder && refers) holders.set(holder, refers)
    }

    /** The fields of a model, or of a value flattened into this hash (`shipping_address_city`). */
    const addFields = (owner: FieldDef[], decisions: FieldDesign[], path: string[], source: string) => {
      for (const field of owner) {
        const decided = decisions.find((other) => other.field === field.name)
        if (decided && !decided.include) continue
        const name = freeName(
          path.length > 0
            ? joinNames([...path, field.name], naming)
            : (decided?.column ?? field.serializedName ?? columnName(field.name, naming)),
          fieldNames,
        )
        const fieldSource = `${source}.${field.name}`
        const relation = decided?.relation
        if (relation?.status === 'pending') {
          entry.todos.push({ code: 'relationPending', params: { field: [...path, field.name].join('.') } })
          continue
        }
        const target = modelOf(field.type)
        if (relation && target && findModel(schema, target) && (relation.value === 'reference' || relation.value === 'child')) {
          const refers = prefixes.get(target)
          if (!refers) {
            entry.todos.push({ code: 'targetNotStored', params: { field: field.name, model: target } })
            continue
          }
          if (relation.value === 'child') {
            entry.structures.push({ suffix: name, type: 'set', holds: 'key', refers, source: fieldSource })
            continue
          }
          if (path.length === 0 && keyHolder(field, owner, item, { naming })) continue
          const keyName = freeName(joinNames([...path, field.name, 'id'], naming), fieldNames)
          fieldNames.delete(name.toLowerCase())
          entry.fields.push({ name: keyName, holds: 'key', refers, nullable: storesNull(field), source: fieldSource })
          search(keyName, 'TAG')
          continue
        }
        if (relation?.value === 'flatten' && target) {
          fieldNames.delete(name.toLowerCase())
          const inner = findModel(schema, target)!
          addFields(allFields(schema, inner), findModelDesign(design, target)?.fields ?? [], [...path, field.name], fieldSource)
          continue
        }
        if (relation?.value === 'child') {
          const items = field.type.kind === 'array' ? field.type.items : field.type.kind === 'map' ? field.type.value : field.type
          entry.structures.push({
            suffix: name,
            type: field.type.kind === 'map' ? 'hash' : 'list',
            holds: holdsOf(items),
            source: fieldSource,
          })
          continue
        }
        const hash: HashField = {
          name,
          holds: relation ? 'json' : holdsOf(field.type),
          nullable: storesNull(field),
          source: fieldSource,
        }
        if (field.type.kind === 'enum') {
          const values = findEnum(schema, field.type.name)?.values.map((value) => value.value ?? value.name)
          if (values) hash.values = values
          search(name, 'TAG')
        }
        const foreignKey = decided?.foreignKey
        const held = path.length === 0 ? holders.get(name) : undefined
        if (held) {
          hash.holds = 'key'
          hash.refers = held
          search(name, 'TAG')
        } else if (foreignKey?.status === 'active' && foreignKey.value) {
          const refers = prefixes.get(foreignKey.value)
          if (refers) {
            hash.holds = 'key'
            hash.refers = refers
            search(name, 'TAG')
          } else entry.todos.push({ code: 'targetNotStored', params: { field: field.name, model: foreignKey.value } })
        }
        if (path.length === 0 && key?.status === 'active' && key.value.kind === 'field' && key.value.field === field.name) {
          entry.keyField = name
          hash.nullable = false
        } else {
          const unique = decided?.unique?.status === 'active' && decided.unique.value
          if (unique) notes.push({ code: 'uniqueInApplication', params: { database: 'Redis', field: `${model.name}.${field.name}` } })
          if (unique || decided?.index) search(name, hash.holds === 'number' ? 'NUMERIC' : 'TAG')
        }
        entry.fields.push(hash)
      }
    }
    addFields(fields, item.fields, [], model.name)
    entries.push(entry)
  }
  return { kind: 'keyvalue', entries, notes }
}
