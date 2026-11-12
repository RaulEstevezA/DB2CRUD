/**
 * The Drizzle repositories, over a database or a transaction: rows become the project's plain entities (Drizzle's
 * rows already have their types), reads leave out rows marked as deleted, pages go by offset or after a key, new
 * rows are read back (with `returning()`, or by their key on MySQL), and a database refusal becomes a
 * ConflictError.
 */
import type { Line } from '../../types.ts'
import type { TsImports } from '../typescript.ts'
import { query, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import type { RepositoryMethod } from '../common/orm.ts'
import { dialectOf, nativeEnum, schemaModule, tableVar } from './schema.ts'

/** What a computed column is never written with, nor the key of a stored row or what the database fills. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
// A column the database sets on every change (ON UPDATE) is left for it, or the ORM, to set
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

function multiline(open: string, items: string[], close: string): Line[] {
  return [open, ...items.map((item) => `    ${item},`), close]
}

/** `name: entity.name`, with the type Drizzle asks for when the column is an enum of the database. */
function value(context: Context, info: TableInfo, column: ColumnInfo): string {
  const cast = nativeEnum(context, column.column.type) ? ` as (typeof ${tableVar(info)}.$inferInsert)['${column.prop}']` : ''
  return `${column.prop}: entity.${column.prop}${cast}`
}

/** toEntity, insertValues and updateValues of a table. */
export function drizzleHelpers(context: Context, info: TableInfo, imports: TsImports): Line[] {
  const table = tableVar(info)
  imports.from(schemaModule(context), table)
  const result: Line[] = [
    `/** The ${info.entity} of a row Drizzle read. */`,
    `function toEntity(row: typeof ${table}.$inferSelect): ${info.entity} {`,
    `  return Object.assign(new ${info.entity}(), row)`,
    '}',
  ]
  if (query(info, 'insert'))
    result.push(
      '',
      `/** The values of a new row; those left undefined take the database's default. */`,
      `function insertValues(entity: ${info.entity}): typeof ${table}.$inferInsert {`,
      ...multiline(
        '  return {',
        info.columns.filter(writable).map((column) => value(context, info, column)),
        '  }',
      ),
      '}',
    )
  const changes = info.columns.filter((column) => changeable(info, column))
  if (query(info, 'update') && changes.length > 0)
    result.push(
      '',
      `/** The values a change writes: not the key, nor what the database fills. */`,
      `function updateValues(entity: ${info.entity}): Partial<typeof ${table}.$inferInsert> {`,
      ...multiline(
        '  return {',
        changes.map((column) => value(context, info, column)),
        '  }',
      ),
      '}',
    )
  return result
}

// Bodies

/** The condition that leaves out rows marked as deleted. */
function softCondition(info: TableInfo, imports: TsImports): string | null {
  if (!info.soft) return null
  const column = `${tableVar(info)}.${info.soft.prop}`
  if (info.soft.column.type.kind === 'boolean') {
    imports.from('drizzle-orm', 'eq')
    return `eq(${column}, false)`
  }
  imports.from('drizzle-orm', 'isNull')
  return `isNull(${column})`
}

function both(conditions: (string | null)[], imports: TsImports): string | null {
  const present = conditions.filter((item): item is string => item !== null)
  if (present.length === 0) return null
  if (present.length === 1) return present[0]
  imports.from('drizzle-orm', 'and')
  return `and(${present.join(', ')})`
}

function equal(info: TableInfo, column: ColumnInfo, value: string, imports: TsImports): string {
  imports.from('drizzle-orm', 'eq')
  return `eq(${tableVar(info)}.${column.prop}, ${value})`
}

const keyOf = (info: TableInfo, imports: TsImports, target = 'entity') =>
  both(
    info.key.map((column) => equal(info, column, `${target}.${column.prop}`, imports)),
    imports,
  )!

function orderBy(info: TableInfo, imports: TsImports): string {
  imports.from('drizzle-orm', 'asc')
  return `.orderBy(${info.key.map((column) => `asc(${tableVar(info)}.${column.prop})`).join(', ')})`
}

const whereOf = (condition: string | null) => (condition ? `.where(${condition})` : '')

/** A write, with a database refusal (a unique value, a row still pointed to) turned into a ConflictError. */
function write(info: TableInfo, action: Line[], imports: TsImports): Line[] {
  imports.from('src/database', 'isRefusal').from('src/errors', 'ConflictError')
  return [
    'try {',
    ...action.map((line) => (typeof line === 'string' ? `  ${line}` : line)),
    '} catch (error) {',
    `  if (isRefusal(error)) throw new ConflictError('${info.entity}', \`the database refused the change: \${(error as Error).message}\`)`,
    '  throw error',
    '}',
  ]
}

export function drizzleBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: TsImports): Line[] {
  const table = tableVar(info)
  const select = `this.db.select().from(${table})`
  const byParams = method.query.columns.map((name) => {
    const column = info.columns.find((item) => item.column.name === name)!
    return equal(info, column, column.prop, imports)
  })
  const kind = method.query.kind
  const reads = kind === 'getByKey' || kind === 'findByUnique' || kind === 'listByParent' || kind === 'findAllBy' || kind === 'list'
  const soft = reads ? softCondition(info, imports) : null
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        `const [row] = await ${select}${whereOf(both([...byParams, soft], imports))}.limit(1)`,
        'return row === undefined ? null : toEntity(row)',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [`return (await ${select}${whereOf(both([...byParams, soft], imports))}${orderBy(info, imports)}).map(toEntity)`]
    case 'list': {
      const where = whereOf(both([soft], imports))
      if (context.settings.paging === 'offset') {
        imports.from('drizzle-orm', 'count')
        return [
          `const rows = await ${select}${where}${orderBy(info, imports)}.limit(limit).offset(offset)`,
          `const [{ total }] = await this.db.select({ total: count() }).from(${table})${where}`,
          'return { items: rows.map(toEntity), total, offset, limit }',
        ]
      }
      if (context.settings.paging === 'cursor') {
        imports.from('drizzle-orm', 'gt', 'and').type('drizzle-orm', 'SQL')
        // After the key (a, b): a greater, or a the same and b greater
        const key = info.key
        const at = (index: number) => `after[${index}] as ${key[index].ts}`
        const options = key.map((column, index) => {
          const parts = [
            ...key.slice(0, index).map((before, position) => equal(info, before, at(position), imports)),
            `gt(${table}.${column.prop}, ${at(index)})`,
          ]
          return parts.length === 1 ? parts[0] : `and(${parts.join(', ')})`
        })
        if (options.length > 1) imports.from('drizzle-orm', 'or')
        return [
          `const conditions: (SQL | undefined)[] = [${soft ?? ''}]`,
          `if (after !== null) conditions.push(${options.length === 1 ? options[0] : `or(${options.join(', ')})`})`,
          `const rows = (await ${select}.where(and(...conditions))${orderBy(info, imports)}.limit(limit + 1)).map(toEntity)`,
          'const items = rows.slice(0, limit)',
          'const last = items[items.length - 1]',
          `return { items, next: rows.length > limit ? [${key.map((column) => `last.${column.prop}`).join(', ')}] : null }`,
        ]
      }
      return [`return (await ${select}${where}${orderBy(info, imports)}).map(toEntity)`]
    }
    case 'insert': {
      if (dialectOf(context) !== 'mysql')
        // The values the database filled (the key, defaults) are read back into the entity
        return write(
          info,
          [
            `const [row] = await this.db.insert(${table}).values(insertValues(entity)).returning()`,
            'return Object.assign(entity, toEntity(row))',
          ],
          imports,
        )
      // MySQL returns only the new key: the row is read back by it
      const identity = info.columns.some((column) => column.column.generated === 'identity')
      return [
        ...write(
          info,
          identity
            ? [`const [ids] = await this.db.insert(${table}).values(insertValues(entity)).$returningId()`, 'Object.assign(entity, ids)']
            : [`await this.db.insert(${table}).values(insertValues(entity))`],
          imports,
        ),
        `const [row] = await ${select}.where(${keyOf(info, imports)}).limit(1)`,
        'return row === undefined ? entity : Object.assign(entity, toEntity(row))',
      ]
    }
    case 'update': {
      const changes = info.columns.some((column) => changeable(info, column))
      if (!changes) return ['// Nothing of the row can change but its key', 'return entity']
      return [
        ...write(info, [`await this.db.update(${table}).set(updateValues(entity)).where(${keyOf(info, imports)})`], imports),
        'return entity',
      ]
    }
    case 'delete':
      return write(info, [`await this.db.delete(${table}).where(${keyOf(info, imports)})`], imports)
    default:
      return ["throw new Error('not written')"]
  }
}
