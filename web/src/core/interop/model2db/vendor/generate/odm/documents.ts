import { allFields, findEnum, findModel, modelOf, type EnumDef, type FieldDef, type ModelSchema, type TypeRef } from '../../model/schema.ts'
import { findModelDesign, type Design } from '../../design/types.ts'
import type { Collection, DocumentSchema, NamingOptions } from '../../physical/types.ts'
import { columnName } from '../../physical/naming.ts'
import { keyHolder } from '../../physical/document.ts'
import { modelRoles } from '../../physical/roles.ts'

/** The collections of a document design seen as ODM classes: a class per stored model (with its
 * collection) and per embedded model, and for each field what it holds. Every ODM writer works from
 * this view, so they all store the same thing. */

export type DocumentFieldKind =
  /** A value of one of the common types, or an enum */
  | 'value'
  /** A list of values */
  | 'values'
  /** A map of values */
  | 'map'
  /** Any shape */
  | 'free'
  /** Another model inside the document */
  | 'embedded'
  /** The id of a document of another collection */
  | 'reference'

export interface DocumentField {
  field: FieldDef
  /** Property name in the stored document */
  stored: string
  kind: DocumentFieldKind
  /** Through a list */
  many: boolean
  /** The model of an embedded or referenced field */
  target?: string
  /** The type of the value (or of the list's items) */
  type: TypeRef
  enum?: EnumDef
  required: boolean
  nullable: boolean
  unique: boolean
  indexed: boolean
  /** The field is the document's `_id` */
  id: boolean
}

export interface DocumentClass {
  name: string
  /** Stored models have a collection; embedded ones do not */
  collection?: Collection
  fields: DocumentField[]
  /** The `_id` is MongoDB's ObjectId, not a field of the model */
  objectId: boolean
  todos: Collection['todos']
}

export interface DocumentView {
  classes: DocumentClass[]
  enums: EnumDef[]
}

/** The type behind lists and maps: `Order[]` → `Order`. */
function innerType(type: TypeRef): TypeRef {
  if (type.kind === 'array') return innerType(type.items)
  if (type.kind === 'map') return innerType(type.value)
  return type
}

export function buildDocumentView(schema: ModelSchema, design: Design, physical: DocumentSchema, naming: NamingOptions): DocumentView {
  const roles = modelRoles(schema, design)
  const classes: DocumentClass[] = []
  for (const model of schema.models) {
    const role = roles.get(model.name)
    if (role !== 'stored' && role !== 'embedded') continue
    const item = findModelDesign(design, model.name)
    if (!item) continue
    const collection = physical.collections.find((candidate) => candidate.model === model.name)
    const key = item.key?.status === 'active' ? item.key.value : null
    const fields: DocumentField[] = []
    for (const field of allFields(schema, model)) {
      const decided = item.fields.find((candidate) => candidate.field === field.name)
      if (decided && !decided.include) continue
      const relation = decided?.relation
      if (relation?.status === 'pending' || relation?.value === 'child') continue
      const id = role === 'stored' && key?.kind === 'field' && key.field === field.name
      const target = modelOf(field.type)
      const inner = innerType(field.type)
      let kind: DocumentFieldKind = 'value'
      if (target && findModel(schema, target)) kind = relation?.value === 'reference' ? 'reference' : 'embedded'
      else if (field.type.kind === 'map') kind = 'map'
      else if (field.type.kind === 'array') kind = 'values'
      else if (inner.kind === 'unknown' || (inner.kind === 'primitive' && inner.name === 'any')) kind = 'free'
      // A reference whose target has no collection of its own cannot be written; one whose id is already
      // in another field (`author` next to `authorId`) is that field
      if (kind === 'reference' && roles.get(target!) !== 'stored') continue
      if (kind === 'reference' && keyHolder(field, allFields(schema, model), item, { naming })) continue
      fields.push({
        field,
        stored: id ? '_id' : (decided?.column ?? field.serializedName ?? columnName(field.name, naming)),
        kind,
        many: field.type.kind === 'array',
        ...(target ? { target } : {}),
        type: inner,
        ...(inner.kind === 'enum' && findEnum(schema, inner.name) ? { enum: findEnum(schema, inner.name) } : {}),
        required: id || (!field.optional && !field.nullable),
        nullable: field.nullable,
        unique: decided?.unique?.status === 'active' && decided.unique.value === true,
        indexed: decided?.index === true || kind === 'reference',
        id,
      })
    }
    classes.push({
      name: model.name,
      ...(collection ? { collection } : {}),
      fields,
      objectId: role === 'stored' && key?.kind !== 'field',
      todos: collection?.todos ?? [],
    })
  }
  return {
    classes,
    enums: schema.enums.filter((item) => classes.some((cls) => cls.fields.some((field) => field.enum?.name === item.name))),
  }
}
