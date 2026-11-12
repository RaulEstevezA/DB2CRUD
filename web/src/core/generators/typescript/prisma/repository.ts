/**
 * The Prisma repositories, over a client (the application's or a transaction's): rows become the project's
 * plain entities and back, with the conversions Prisma's types need (whole numbers of 64 bits, decimals, dates
 * and times, bytes, JSON and enum values); reads leave out rows marked as deleted; pages go by offset or after a
 * key; and a database refusal becomes a ConflictError.
 */
import type { Line } from '../../types.ts'
import type { TsImports } from '../typescript.ts'
import { columnType, query, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import type { RepositoryMethod } from '../common/orm.ts'
import { fieldOf, memberOf, nativeEnum, renamesValues, enumName } from './schema.ts'

/** The module the Prisma client and its types are imported from: the generated one, or the project's own. */
export function clientModule(context: Context): string {
  return context.tables.some((info) => info.writesEntity)
    ? 'src/generated/prisma/client'
    : context.settings.entitiesModule.replace(/\./g, '/')
}

/** `orderLine`: the property of the client for a model. */
export const accessor = (info: TableInfo) => info.entity.charAt(0).toLowerCase() + info.entity.slice(1)

const rowType = (info: TableInfo) => `Prisma.${info.entity}Model`

/** Name of the record that turns the Prisma names of an enum's values into the values, and back. */
const valuesRecord = (context: Context, column: ColumnInfo) => `${enumName(nativeEnum(context, column.column.type)!).toUpperCase()}_VALUES`
const namesRecord = (context: Context, column: ColumnInfo) => `${enumName(nativeEnum(context, column.column.type)!).toUpperCase()}_NAMES`

/** A value of a Prisma row as the entity keeps it, when it needs converting. */
function fromRow(context: Context, column: ColumnInfo, value: string): string | null {
  const type = column.column.type
  const prisma = fieldOf(context, type).type
  switch (type.kind) {
    case 'integer':
      return prisma === 'BigInt' ? `Number(${value})` : null
    case 'decimal':
      return type.scale !== undefined ? `${value}.toFixed(${type.scale})` : `${value}.toFixed()`
    case 'date':
      return `${value}.toISOString().slice(0, 10)`
    case 'time':
      return prisma === 'DateTime' ? `${value}.toISOString().slice(11, 19)` : null
    case 'binary':
      return `Buffer.from(${value})`
    case 'array':
      return `${value} as ${columnType(column)}`
    case 'enum': {
      const item = nativeEnum(context, type)
      return item && renamesValues(item) ? `${valuesRecord(context, column)}[${value}]` : null
    }
    default:
      return null
  }
}

/** A value of the entity as Prisma writes it, when it needs converting. */
function toPrisma(context: Context, column: ColumnInfo, value: string, imports: TsImports): string | null {
  const type = column.column.type
  const prisma = fieldOf(context, type).type
  switch (type.kind) {
    case 'date':
      return `new Date(${value})`
    case 'time':
      return prisma === 'DateTime' ? `new Date(\`1970-01-01T\${${value}}Z\`)` : null
    case 'binary':
      return `new Uint8Array(${value})`
    case 'enum': {
      const item = nativeEnum(context, type)
      if (!item) return null
      if (renamesValues(item)) return `${namesRecord(context, column)}[${value}]`
      imports.type(clientModule(context), '$Enums')
      return `${value} as $Enums.${enumName(item)}`
    }
    default:
      return null
  }
}

const isJson = (column: ColumnInfo) => column.column.type.kind === 'json' || column.column.type.kind === 'array'

/** `name: value` of a property read from a row. */
function readProperty(context: Context, column: ColumnInfo): string {
  const value = `row.${column.prop}`
  const converted = fromRow(context, column, value)
  if (!converted) return `${column.prop}: ${value}`
  const nullable = column.column.nullable && !isJson(column)
  return `${column.prop}: ${nullable ? `${value} === null ? null : ${converted}` : converted}`
}

/** `name: value` of a property written from the entity; undefined values are left for the database to fill. */
function writeProperty(context: Context, column: ColumnInfo, imports: TsImports): string {
  const value = `entity.${column.prop}`
  if (isJson(column)) {
    imports.from(clientModule(context), 'Prisma')
    return column.column.nullable
      ? `${column.prop}: ${value} === null ? Prisma.DbNull : (${value} as Prisma.InputJsonValue)`
      : `${column.prop}: ${value} as Prisma.InputJsonValue`
  }
  const converted = toPrisma(context, column, value, imports)
  return converted ? `${column.prop}: ${value} == null ? ${value} : ${converted}` : `${column.prop}: ${value}`
}

/** A condition on a column, with the value converted as Prisma compares it. */
function condition(context: Context, column: ColumnInfo, value: string, imports: TsImports): string {
  const converted = isJson(column) ? null : toPrisma(context, column, value, imports)
  return converted ? `${column.prop}: ${converted}` : value === column.prop ? column.prop : `${column.prop}: ${value}`
}

/** What a computed column or the key of a stored row is never written with. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) => writable(column) && !info.key.includes(column) && !column.generated

function multiline(open: string, items: string[], close: string): Line[] {
  return [open, ...items.map((item) => `    ${item},`), close]
}

/** toEntity, createData and updateData of a table, and the records of renamed enum values. */
export function prismaHelpers(context: Context, info: TableInfo, imports: TsImports): Line[] {
  imports.from(clientModule(context), 'Prisma')
  const result: Line[] = []
  const enums = new Map<string, ColumnInfo>()
  for (const column of info.columns) {
    const item = nativeEnum(context, column.column.type)
    if (item && renamesValues(item)) enums.set(item.name, column)
  }
  for (const column of enums.values()) {
    const item = nativeEnum(context, column.column.type)!
    imports.type(clientModule(context), '$Enums')
    result.push(
      `/** The values of ${item.name} by their Prisma names, and back: the client uses the names. */`,
      `const ${valuesRecord(context, column)}: Record<$Enums.${enumName(item)}, string> = { ${item.values.map((value) => `${memberOf(value)}: ${JSON.stringify(value).replace(/"/g, "'")}`).join(', ')} }`,
      `const ${namesRecord(context, column)} = Object.fromEntries(Object.entries(${valuesRecord(context, column)}).map(([name, value]) => [value, name])) as Record<string, $Enums.${enumName(item)}>`,
      '',
    )
  }
  result.push(
    `/** The ${info.entity} of a row Prisma read. */`,
    `function toEntity(row: ${rowType(info)}): ${info.entity} {`,
    ...multiline(
      `  return Object.assign(new ${info.entity}(), {`,
      info.columns.map((column) => readProperty(context, column)),
      '  })',
    ),
    '}',
  )
  if (query(info, 'insert'))
    result.push(
      '',
      `/** The values of a new row; those left undefined take the database's default. */`,
      `function createData(entity: ${info.entity}): Prisma.${info.entity}UncheckedCreateInput {`,
      ...multiline(
        '  return {',
        info.columns.filter(writable).map((column) => writeProperty(context, column, imports)),
        '  }',
      ),
      '}',
    )
  if (query(info, 'update')) {
    const columns = info.columns.filter((column) => changeable(info, column))
    result.push(
      '',
      `/** The values a change writes: not the key, nor what the database fills. */`,
      `function updateData(entity: ${info.entity}): Prisma.${info.entity}UncheckedUpdateManyInput {`,
      ...(columns.length > 0
        ? multiline(
            '  return {',
            columns.map((column) => writeProperty(context, column, imports)),
            '  }',
          )
        : ['  return {}']),
      '}',
    )
  }
  return result
}

// Bodies

/** The condition that leaves out rows marked as deleted. */
function softCondition(info: TableInfo): string | null {
  if (!info.soft) return null
  return `${info.soft.prop}: ${info.soft.column.type.kind === 'boolean' ? 'false' : 'null'}`
}

function whereOf(conditions: (string | null)[]): string | null {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? `where: { ${present.join(', ')} }` : null
}

const orderBy = (info: TableInfo) =>
  info.key.length === 1
    ? `orderBy: { ${info.key[0].prop}: 'asc' }`
    : `orderBy: [${info.key.map((column) => `{ ${column.prop}: 'asc' }`).join(', ')}]`

const args = (items: (string | null)[]) => {
  const present = items.filter((item): item is string => item !== null)
  return present.length > 0 ? `{ ${present.join(', ')} }` : ''
}

/** A write, with a database refusal (a unique value, a row still pointed to) turned into a ConflictError. */
function write(context: Context, info: TableInfo, action: Line[], imports: TsImports): Line[] {
  imports.from(clientModule(context), 'Prisma').from('src/errors', 'ConflictError')
  return [
    'try {',
    ...action.map((line) => (typeof line === 'string' ? `  ${line}` : line)),
    '} catch (error) {',
    `  if (error instanceof Prisma.PrismaClientKnownRequestError) throw new ConflictError('${info.entity}', \`the database refused the change: \${error.message}\`)`,
    '  throw error',
    '}',
  ]
}

const keyWhere = (context: Context, info: TableInfo, imports: TsImports) =>
  `where: { ${info.key.map((column) => condition(context, column, `entity.${column.prop}`, imports)).join(', ')} }`

export function prismaBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: TsImports): Line[] {
  const model = `this.db.${accessor(info)}`
  // The parameters of a read by columns are named after them
  const byParams = method.query.columns.map((name) => {
    const column = info.columns.find((item) => item.column.name === name)!
    return condition(context, column, column.prop, imports)
  })
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        `const row = await ${model}.findFirst(${args([whereOf([...byParams, softCondition(info)])])})`,
        'return row === null ? null : toEntity(row)',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [`return (await ${model}.findMany(${args([whereOf([...byParams, softCondition(info)]), orderBy(info)])})).map(toEntity)`]
    case 'list': {
      const where = whereOf([softCondition(info)])
      if (context.settings.paging === 'offset')
        return [
          `const rows = await ${model}.findMany(${args([where, orderBy(info), 'skip: offset', 'take: limit'])})`,
          `const total = await ${model}.count(${args([where])})`,
          'return { items: rows.map(toEntity), total, offset, limit }',
        ]
      if (context.settings.paging === 'cursor') {
        imports.from(clientModule(context), 'Prisma')
        // After the key (a, b): a greater, or a the same and b greater
        const value = (index: number) => {
          const column = info.key[index]
          const raw = `after[${index}] as ${column.ts}`
          return isJson(column) ? raw : (toPrisma(context, column, `(${raw})`, imports) ?? raw)
        }
        const after = info.key.map((column, index) =>
          [
            ...info.key.slice(0, index).map((before, position) => `${before.prop}: ${value(position)}`),
            `${column.prop}: { gt: ${value(index)} }`,
          ].join(', '),
        )
        const soft = softCondition(info)
        return [
          `const where: Prisma.${info.entity}WhereInput = ${soft ? `{ ${soft} }` : '{}'}`,
          info.key.length === 1
            ? `if (after !== null) where.${info.key[0].prop} = { gt: ${value(0)} }`
            : `if (after !== null) where.OR = [${after.map((item) => `{ ${item} }`).join(', ')}]`,
          `const rows = (await ${model}.findMany({ where, ${orderBy(info)}, take: limit + 1 })).map(toEntity)`,
          'const items = rows.slice(0, limit)',
          'const last = items[items.length - 1]',
          `return { items, next: rows.length > limit ? [${info.key.map((column) => `last.${column.prop}`).join(', ')}] : null }`,
        ]
      }
      return [`return (await ${model}.findMany(${args([where, orderBy(info)])})).map(toEntity)`]
    }
    case 'insert':
      // The values the database filled (the key, defaults) are read back into the entity
      return write(context, info, [`return Object.assign(entity, toEntity(await ${model}.create({ data: createData(entity) })))`], imports)
    case 'update':
      return [
        ...write(context, info, [`await ${model}.updateMany({ ${keyWhere(context, info, imports)}, data: updateData(entity) })`], imports),
        'return entity',
      ]
    case 'delete':
      return write(context, info, [`await ${model}.deleteMany({ ${keyWhere(context, info, imports)} })`], imports)
    default:
      return ["throw new Error('not written')"]
  }
}
