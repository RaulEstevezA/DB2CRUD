/**
 * Facts about each model: whether the input declares it as a stored entity, which field identifies it,
 * and which other models refer to it. Only what the input says or what follows from its names is
 * reported; the rules that build on them decide what to do with it.
 */
import { nameWords } from '../model/naming.ts'
import { allFields, findModel, type Annotation, type FieldDef, type ModelDef, type ModelSchema, type TypeRef } from '../model/schema.ts'

/** Frameworks whose models are stored entities, as the importers name them. */
const ENTITY_FRAMEWORKS = new Set(['jpa', 'efcore', 'doctrine', 'django', 'sqlalchemy', 'sqlmodel', 'typeorm', 'prisma'])

/** Annotations that mark a stored entity (`@Entity`, `@Table`, `@Document`). */
const ENTITY_ANNOTATIONS = new Set(['entity', 'table', 'document'])

/** Annotations that mark a key field, by simple lower-case name. */
const KEY_ANNOTATIONS = new Set(['id', 'key', 'primarykey', 'primarycolumn', 'primarygeneratedcolumn', 'objectidcolumn', 'embeddedid'])

/** Annotations that say the server fills the key (`@GeneratedValue`, `@default(autoincrement())`). */
const GENERATED_KEY_ANNOTATIONS = new Set(['generatedvalue', 'primarygeneratedcolumn', 'databasegenerated', 'uuidgenerator'])

/** One place where a model is used as the type of a field. */
export interface Reference {
  model: string
  field: string
  /** The field holds a list of them */
  many: boolean
}

export interface ModelFacts {
  model: string
  /** The input declares it as a stored entity (JPA, Django, SQLAlchemy, Prisma…) */
  declaredEntity: boolean
  /** The field the input declares as its key */
  declaredKey: string | null
  /** The server fills the declared key (`@GeneratedValue`, `autoincrement()`, `AutoField`) */
  declaredKeyGenerated: boolean
  /** A field whose name says it is the key: `id`, or the model's name followed by `Id` / `_id` */
  namedKey: string | null
  /** Fields that could identify the model: required single values of text, whole number or UUID */
  keyCandidates: string[]
  referencedBy: Reference[]
}

function simpleName(name: string): string {
  return name
    .split(/\.|::|\\/)
    .pop()!
    .replace(/Attribute$/, '')
    .toLowerCase()
}

function annotationNames(item: { annotations?: Annotation[] }): Set<string> {
  return new Set((item.annotations ?? []).map((annotation) => simpleName(annotation.name)))
}

/** `primary_key=True`, `primary: true` and the like inside an annotation's arguments. */
function argIsTrue(annotation: Annotation, name: string): boolean {
  return new RegExp(`(?:^|[\\s,({])${name}\\s*[:=]\\s*(true|True)\\b`).test(annotation.args ?? '')
}

/** The input declares the field as the key of its model. */
export function declaresKey(field: FieldDef): boolean {
  if (field.metadata?.primaryKey === true) return true
  const names = annotationNames(field)
  if ([...names].some((name) => KEY_ANNOTATIONS.has(name))) return true
  return (field.annotations ?? []).some((annotation) => argIsTrue(annotation, 'primary_key') || argIsTrue(annotation, 'primary'))
}

/** The input says the server fills the key. */
function declaresGeneratedKey(field: FieldDef): boolean {
  if (field.generated) return true
  const names = annotationNames(field)
  if ([...names].some((name) => GENERATED_KEY_ANNOTATIONS.has(name))) return true
  return (field.annotations ?? []).some(
    (annotation) => simpleName(annotation.name) === 'default' && /^\s*(autoincrement|uuid|cuid)\(/.test(annotation.args ?? ''),
  )
}

/** The model a type leads to, directly or through a list, and whether it is a list. */
export function modelTarget(type: TypeRef): { model: string; many: boolean } | null {
  if (type.kind === 'model') return { model: type.name, many: false }
  if (type.kind === 'array' && type.items.kind === 'model') return { model: type.items.name, many: true }
  return null
}

/** A required single value that can identify something: text, whole number or UUID. */
function canBeKey(field: FieldDef): boolean {
  if (field.optional || field.type.kind !== 'primitive') return false
  return field.type.name === 'string' || field.type.name === 'integer' || field.type.name === 'uuid'
}

function namedKey(model: ModelDef, fields: FieldDef[]): string | null {
  const plain = fields.find((field) => field.name.toLowerCase() === 'id' && field.type.kind === 'primitive')
  if (plain) return plain.name
  const own = new Set([`${model.name}id`.toLowerCase(), `${model.name}_id`.toLowerCase()])
  return fields.find((field) => own.has(field.name.toLowerCase()) && field.type.kind === 'primitive')?.name ?? null
}

function isEntity(model: ModelDef): boolean {
  if (model.framework && ENTITY_FRAMEWORKS.has(model.framework)) return true
  return [...annotationNames(model)].some((name) => ENTITY_ANNOTATIONS.has(name))
}

/**
 * Collects the facts of every model of a schema.
 *
 * @param schema The models as the importer read them.
 * @returns The facts of each model, by name, in the order of the schema.
 */
export function analyzeModels(schema: ModelSchema): Map<string, ModelFacts> {
  const facts = new Map<string, ModelFacts>()
  for (const model of schema.models) {
    const fields = allFields(schema, model)
    const declared = fields.find(declaresKey) ?? null
    facts.set(model.name, {
      model: model.name,
      declaredEntity: isEntity(model),
      declaredKey: declared?.name ?? null,
      declaredKeyGenerated: declared ? declaresGeneratedKey(declared) : false,
      namedKey: namedKey(model, fields),
      keyCandidates: fields.filter(canBeKey).map((field) => field.name),
      referencedBy: [],
    })
  }
  for (const model of schema.models) {
    for (const field of allFields(schema, model)) {
      const target = modelTarget(field.type)
      if (target && findModel(schema, target.model)) {
        facts.get(target.model)!.referencedBy.push({ model: model.name, field: field.name, many: target.many })
      }
    }
  }
  return facts
}

/** Words that say a field holds a secret the API must never return. */
const SECRET_WORDS = new Set(['password', 'passwd', 'secret', 'pin', 'token', 'apikey'])

/** A name whose words say it holds a secret: `password`, `passwordHash`, `api_key`, `refreshToken`. */
export function isSecretName(name: string): boolean {
  const words = nameWords(name).map((word) => word.toLowerCase())
  const joined = words.join('')
  return words.some((word) => SECRET_WORDS.has(word)) || joined.endsWith('apikey')
}

/** Names of timestamps the server keeps: `createdAt`, `updated_at`, `modifiedOn`, `deletedAt`. */
export function auditKind(name: string): 'created' | 'updated' | null {
  const lower = name.toLowerCase().replace(/_/g, '')
  if (/^(created|creation|inserted)(at|on|date|time)?$/.test(lower)) return 'created'
  if (/^(updated|modified|lastmodified|changed)(at|on|date|time)?$/.test(lower)) return 'updated'
  return null
}
