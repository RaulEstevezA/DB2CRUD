/**
 * The entity of each collection, for the MongoDB driver: the stored name and type of every field and a class per nested
 * document. Fields the classes do not know are left alone.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbColumn, DbType } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { csString, CsUsings } from '../csharp.ts'
import { namespaceOf, pathOf, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, type NestedClass } from '../documents.ts'

const innermost = (type: DbType): DbType => (type.kind === 'array' ? innermost(type.items) : type)

interface Property {
  column: DbColumn
  prop: string
  propType: string
  optional: boolean
  valueType: boolean
}

/** How a field is stored: its name, its type when C#'s is another, and left out when it has no value. */
function attributes(field: Property): string[] {
  const type = innermost(field.column.type)
  return [
    field.column.name === '_id' ? '[BsonId]' : `[BsonElement(${csString(field.column.name)})]`,
    ...(type.kind === 'text' && type.objectId ? ['[BsonRepresentation(BsonType.ObjectId)]'] : []),
    ...(type.kind === 'decimal' ? ['[BsonRepresentation(BsonType.Decimal128)]'] : []),
    ...(type.kind === 'uuid' ? ['[BsonGuidRepresentation(GuidRepresentation.Standard)]'] : []),
    ...(field.optional ? ['[BsonIgnoreIfNull]'] : []),
  ]
}

function properties(fields: Property[]): string[] {
  return fields.flatMap((field, index) => [
    ...(index > 0 ? [''] : []),
    ...(field.column.comment
      ? [`/// <summary>${field.column.comment.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\s+/g, ' ')}</summary>`]
      : []),
    ...attributes(field),
    `public ${field.propType} ${field.prop} { get; set; }${field.optional || field.valueType ? '' : ' = null!;'}`,
  ])
}

const indented = (items: string[]): string[] => items.map((line) => (line === '' ? '' : `    ${line}`))

function nestedBlock(item: NestedClass): string[] {
  return [
    '/// <summary>A nested document: it is stored with the one that holds it.</summary>',
    '[BsonIgnoreExtraElements]',
    `public class ${item.name}`,
    '{',
    ...indented([...properties(item.fields), ...item.classes.flatMap((inner) => ['', ...nestedBlock(inner)])]),
    '}',
  ]
}

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const ns = namespaceOf(context, info, 'entity')
  const usings = new CsUsings(ns).add('MongoDB.Bson', 'MongoDB.Bson.Serialization.Attributes')
  const lists = identifiedLists(info)
  const identify: Line[] =
    lists.length > 0
      ? [
          '',
          '    /// <summary>Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents.</summary>',
          '    public void IdentifyItems()',
          '    {',
          ...lists.map((column) => `        foreach (var item in ${column.prop} ?? []) item.Id ??= ObjectId.GenerateNewId().ToString();`),
          '    }',
        ]
      : []
  const content = lines(
    usings.write(),
    '',
    `namespace ${ns};`,
    '',
    `/// <summary>A document of the "${info.name}" collection.</summary>`,
    '[BsonIgnoreExtraElements]',
    `public class ${info.entity}`,
    '{',
    ...indented(properties(info.columns)),
    ...identify,
    ...[...info.nested.values()].flatMap((item) => ['', ...indented(nestedBlock(item))]),
    '}',
    '',
  )
  return { path: pathOf(ns, info.entity), content }
}
