/**
 * The entity of each collection, for Spring Data MongoDB: the stored name and type of every field, a class per nested
 * document, and the indexes, which only the tests create.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbColumn, DbType } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { javaPath, javaString, JavaImports } from '../java.ts'
import { packageOf, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, nestedImports, type NestedClass } from '../documents.ts'

const MAPPING = 'org.springframework.data.mongodb.core.mapping'

const innermost = (type: DbType): DbType => (type.kind === 'array' ? innermost(type.items) : type)

/** `@Field`, when the stored name or type is not what Spring would write. */
function fieldAnnotation(column: DbColumn, prop: string, imports: JavaImports): string[] {
  if (column.name === '_id') return []
  const type = innermost(column.type)
  const target = type.kind === 'text' && type.objectId ? 'OBJECT_ID' : type.kind === 'decimal' ? 'DECIMAL128' : null
  const named = column.name !== prop
  if (!named && !target) return []
  imports.add(`${MAPPING}.Field`)
  if (target) imports.add(`${MAPPING}.FieldType`)
  if (!target) return [`@Field(${javaString(column.name)})`]
  return [`@Field(${named ? `name = ${javaString(column.name)}, ` : ''}targetType = FieldType.${target})`]
}

interface Property {
  column: DbColumn
  prop: string
  java: string
  getter: string
  setter: string
}

function accessors(fields: Property[]): string[] {
  return fields.flatMap((field) => [
    '',
    `public ${field.java} ${field.getter}() {`,
    `    return ${field.prop};`,
    '}',
    '',
    `public void ${field.setter}(${field.java} ${field.prop}) {`,
    `    this.${field.prop} = ${field.prop};`,
    '}',
  ])
}

function nestedBlock(item: NestedClass, imports: JavaImports): string[] {
  const body = [
    ...item.fields.flatMap((field, index) => [
      ...(index > 0 ? [''] : []),
      ...fieldAnnotation(field.column, field.prop, imports),
      ...(field.column.comment ? [`/** ${field.column.comment} */`] : []),
      `private ${field.java} ${field.prop};`,
    ]),
    ...accessors(item.fields),
    ...item.classes.flatMap((inner) => ['', ...nestedBlock(inner, imports)]),
  ]
  return [
    `/** A nested document: it is stored with the one that holds it. */`,
    `public static class ${item.name} {`,
    ...body.map((line) => (line === '' ? '' : `    ${line}`)),
    '}',
  ]
}

/** The path of an index key in Spring's JSON: `{'year': 1, 'number': 1}`. */
const keys = (columns: string[]) => `{${columns.map((column) => `'${column}': 1`).join(', ')}}`

function classAnnotations(info: TableInfo, imports: JavaImports): string[] {
  imports.add(`${MAPPING}.Document`)
  const nullable = (columns: string[]) => columns.every((name) => info.table.columns.find((column) => column.name === name)?.nullable)
  const indexes = [
    ...info.table.uniques.map(
      (unique) =>
        `@CompoundIndex(${unique.name ? `name = ${javaString(unique.name)}, ` : ''}def = ${javaString(keys(unique.columns))}, unique = true${nullable(unique.columns) ? ', sparse = true' : ''})`,
    ),
    ...info.table.indexes.map(
      (index) => `@CompoundIndex(${index.name ? `name = ${javaString(index.name)}, ` : ''}def = ${javaString(keys(index.columns))})`,
    ),
  ]
  if (indexes.length > 0) imports.add('org.springframework.data.mongodb.core.index.CompoundIndex')
  if (indexes.length > 1) imports.add('org.springframework.data.mongodb.core.index.CompoundIndexes')
  return [
    `@Document(collection = ${javaString(info.name)})`,
    ...(indexes.length > 1 ? ['@CompoundIndexes({', ...indexes.map((item) => `    ${item},`), '})'] : indexes),
  ]
}

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const pkg = packageOf(context, info, 'entity')
  const imports = new JavaImports(pkg).add('org.springframework.data.annotation.Id', ...nestedImports(info.nested.values()))
  for (const column of info.columns) if (column.javaImport) imports.add(column.javaImport)
  const annotations = classAnnotations(info, imports)
  const fields = info.columns.flatMap((column, index): (string | null)[] => [
    index > 0 ? '' : null,
    column.column.comment ? `    /** ${column.column.comment} */` : null,
    ...(column.column.name === '_id' ? ['    @Id'] : fieldAnnotation(column.column, column.prop, imports).map((line) => `    ${line}`)),
    `    private ${column.java} ${column.prop};`,
  ])
  const lists = identifiedLists(info)
  if (lists.length > 0) imports.add('org.bson.types.ObjectId')
  const identify: Line[] =
    lists.length > 0
      ? [
          '',
          '    /** Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents. */',
          '    public void identifyItems() {',
          ...lists.flatMap((column) => [
            `        if (${column.prop} != null) {`,
            `            ${column.prop}.forEach((item) -> {`,
            '                if (item.getId() == null) item.setId(new ObjectId().toHexString());',
            '            });',
            '        }',
          ]),
          '    }',
        ]
      : []
  // Written before the imports, which it adds to
  const classes = [...info.nested.values()].flatMap((item) => [
    '',
    ...nestedBlock(item, imports).map((line) => (line === '' ? '' : `    ${line}`)),
  ])
  const content = lines(
    `package ${pkg};`,
    '',
    imports.write(),
    '',
    `/** A document of the "${info.name}" collection${info.table.comment ? `: ${info.table.comment}` : ''}. Its indexes are for the tests: in the application's database they are not touched. */`,
    ...annotations,
    `public class ${info.entity} {`,
    ...fields,
    ...accessors(info.columns).map((line) => (line === '' ? '' : `    ${line}`)),
    ...identify,
    ...classes,
    '}',
    '',
  )
  return { path: javaPath(pkg, info.entity), content }
}
