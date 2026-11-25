/** Values between Kotlin and the documents of the MongoDB driver (org.bson.Document). */
import { isObjectId } from '../../../schema/documents.ts'
import type { DbType } from '../../../schema/types.ts'
import { KtImports, ktString, memberName } from '../kotlin.ts'
import type { NestedClass } from '../documents.ts'

/** The functions of a nested class: `lineToDocument`, `lineFromDocument`. */
const baseName = (nested: NestedClass) => memberName(nested.path.split('.').slice(1).join(' ')).replace(/`/g, '')
export const toName = (nested: NestedClass) => `${baseName(nested)}ToDocument`
export const fromName = (nested: NestedClass) => `${baseName(nested)}FromDocument`

/** A value that is there, as a document holds it. */
export function encode(type: DbType, value: string, nested: NestedClass | null, imports: KtImports): string {
  if (isObjectId(type)) {
    imports.add('org.bson.types.ObjectId')
    return `ObjectId(${value})`
  }
  switch (type.kind) {
    case 'decimal':
      imports.add('org.bson.types.Decimal128')
      return `Decimal128(${value})`
    case 'datetime':
      imports.add('java.util.Date')
      return `Date.from(${value})`
    case 'binary':
      imports.add('org.bson.types.Binary')
      return `Binary(${value})`
    case 'array': {
      const item = encode(type.items, 'it', nested, imports)
      return item === 'it' ? value : `${value}.map { ${item} }`
    }
    case 'json':
      return type.fields && nested ? `${toName(nested)}(${value})` : value
    default:
      return value
  }
}

/** A value of a document, which may be missing, as Kotlin has it. */
export function decode(type: DbType, value: string, nested: NestedClass | null, imports: KtImports): string {
  if (isObjectId(type)) return `${value}?.toString()`
  switch (type.kind) {
    case 'integer':
      return `(${value} as Number?)?.to${type.bits === 64 ? 'Long' : type.bits === 16 ? 'Short' : 'Int'}()`
    case 'float':
      return `(${value} as Number?)?.to${type.bits === 32 ? 'Float' : 'Double'}()`
    case 'decimal':
      imports.add('app.Documents')
      return `Documents.decimal(${value})`
    case 'boolean':
      return `${value} as Boolean?`
    case 'datetime':
      imports.add('java.util.Date')
      return `(${value} as Date?)?.toInstant()`
    case 'uuid':
      imports.add('java.util.UUID')
      return `${value} as UUID?`
    case 'binary':
      imports.add('org.bson.types.Binary')
      return `(${value} as Binary?)?.data`
    case 'array':
      if ((type.items.kind === 'json' && !type.items.fields) || type.items.kind === 'unknown')
        return `(${value} as List<*>?)?.filterNotNull()`
      return `(${value} as List<*>?)?.mapNotNull { ${decode(type.items, 'it', nested, imports)} }`
    case 'json':
      if (!type.fields || !nested) return value
      imports.add('org.bson.Document')
      return `(${value} as Document?)?.let { ${fromName(nested)}(it) }`
    case 'unknown':
      return value
    default:
      return `${value} as String?`
  }
}

interface Field {
  name: string
  type: DbType
  prop: string
  nested: NestedClass | null
}

/** The functions between a class and its document: what is null is left out. */
function pair(doc: string, kt: string, fields: Field[], to: string, from: string, imports: KtImports): string[] {
  imports.add('org.bson.Document')
  return [
    '',
    `    /** The document of ${doc}: what is null is left out. */`,
    `    private fun ${to}(value: ${kt}): Document {`,
    '        val document = Document()',
    ...fields.map((field) => {
      const encoded = encode(field.type, 'it', field.nested, imports)
      const lambda = encoded.includes('map { ')
        ? `held -> document[${ktString(field.name)}] = ${encode(field.type, 'held', field.nested, imports)}`
        : `document[${ktString(field.name)}] = ${encoded}`
      return `        value.${field.prop}?.let { ${lambda} }`
    }),
    '        return document',
    '    }',
    '',
    `    private fun ${from}(document: Document): ${kt} =`,
    `        ${kt}(`,
    ...fields.map(
      (field) => `            ${field.prop} = ${decode(field.type, `document[${ktString(field.name)}]`, field.nested, imports)},`,
    ),
    '        )',
  ]
}

const nestedPairs = (item: NestedClass, imports: KtImports): string[] => [
  ...pair(
    `a ${item.path}`,
    item.path,
    item.fields.map((field) => ({ name: field.column.name, type: field.column.type, prop: field.prop, nested: field.nested })),
    toName(item),
    fromName(item),
    imports,
  ),
  ...item.classes.flatMap((inner) => nestedPairs(inner, imports)),
]

export const documentFunctions = (entity: string, fields: Field[], classes: Iterable<NestedClass>, imports: KtImports): string[] => [
  ...pair(`a ${entity}`, entity, fields, 'toDocument', 'fromDocument', imports),
  ...[...classes].flatMap((item) => nestedPairs(item, imports)),
]
