/**
 * The Sequelize repositories, over the models of a database and, when there is one, a transaction: instances
 * become the project's plain entities (whole numbers of 64 bits and decimals arrive as text or numbers depending on
 * the driver, and are made numbers and text), reads leave out rows marked as deleted, pages go by offset or after a
 * key, new rows are read back, and a database refusal becomes a ConflictError.
 */
import type { Line } from '../../types.ts'
import type { TsImports } from '../typescript.ts'
import { columnType, query, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import type { RepositoryMethod } from '../common/orm.ts'

const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
// A column the database sets on every change (ON UPDATE) is left for it to set
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

function multiline(open: string, items: string[], close: string): Line[] {
  return [open, ...items.map((item) => `    ${item},`), close]
}

/** `name: value` of a property read from a row, as the entity keeps it. */
function readProperty(column: ColumnInfo): string {
  const value = `row.${column.prop}`
  const type = column.column.type
  const converted = type.kind === 'integer' && type.bits === 64 ? `Number(${value})` : type.kind === 'decimal' ? `String(${value})` : null
  if (!converted) return `${column.prop}: ${value} as ${columnType(column)}`
  return `${column.prop}: ${column.column.nullable ? `${value} == null ? null : ${converted}` : converted}`
}

/** toEntity, insertValues and updateValues of a table. */
export function sequelizeHelpers(_context: Context, info: TableInfo, imports: TsImports): Line[] {
  imports.type('sequelize', 'Model')
  const result: Line[] = [
    `/** The ${info.entity} of an instance Sequelize read. */`,
    `function toEntity(instance: Model): ${info.entity} {`,
    '  const row = instance.get({ plain: true }) as Record<string, unknown>',
    ...multiline(
      `  return Object.assign(new ${info.entity}(), {`,
      info.columns.map((column) => readProperty(column)),
      '  })',
    ),
    '}',
  ]
  if (query(info, 'insert'))
    result.push(
      '',
      `/** The values of a new row; those left undefined take the database's default. */`,
      `function insertValues(entity: ${info.entity}): Record<string, unknown> {`,
      ...multiline(
        '  const values: Record<string, unknown> = {',
        info.columns.filter(writable).map((column) => `${column.prop}: entity.${column.prop}`),
        '  }',
      ),
      '  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))',
      '}',
    )
  const changes = info.columns.filter((column) => changeable(info, column))
  if (query(info, 'update') && changes.length > 0)
    result.push(
      '',
      `/** The values a change writes: not the key, nor what the database fills. */`,
      `function updateValues(entity: ${info.entity}): Record<string, unknown> {`,
      ...multiline(
        '  return {',
        changes.map((column) => `${column.prop}: entity.${column.prop}`),
        '  }',
      ),
      '}',
    )
  return result
}

// Bodies

function softCondition(info: TableInfo): string | null {
  if (!info.soft) return null
  return `${info.soft.prop}: ${info.soft.column.type.kind === 'boolean' ? 'false' : 'null'}`
}

const whereOf = (conditions: (string | null)[]) => {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? `where: { ${present.join(', ')} }` : null
}

const options = (items: (string | null)[]) =>
  `{ ${[...items.filter((item): item is string => item !== null), 'transaction: this.transaction'].join(', ')} }`

const order = (info: TableInfo) => `order: [${info.key.map((column) => `['${column.prop}', 'ASC']`).join(', ')}]`

const keyWhere = (info: TableInfo) => `where: { ${info.key.map((column) => `${column.prop}: entity.${column.prop}`).join(', ')} }`

/** A write, with a database refusal (a unique value, a row still pointed to) turned into a ConflictError. */
function write(info: TableInfo, action: Line[], imports: TsImports): Line[] {
  imports.from('sequelize', 'DatabaseError', 'ValidationError').from('src/errors', 'ConflictError')
  return [
    'try {',
    ...action.map((line) => (typeof line === 'string' ? `  ${line}` : line)),
    '} catch (error) {',
    '  if (error instanceof DatabaseError || error instanceof ValidationError)',
    `    throw new ConflictError('${info.entity}', \`the database refused the change: \${error.message}\`)`,
    '  throw error',
    '}',
  ]
}

export function sequelizeBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: TsImports): Line[] {
  const model = `this.db.models.${info.attr}`
  const byParams = method.query.columns.map((name) => info.columns.find((item) => item.column.name === name)!.prop)
  const soft = softCondition(info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        `const row = await ${model}.findOne(${options([whereOf([...byParams, soft])])})`,
        'return row === null ? null : toEntity(row)',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [`return (await ${model}.findAll(${options([whereOf([...byParams, soft]), order(info)])})).map(toEntity)`]
    case 'list': {
      const where = whereOf([soft])
      if (context.settings.paging === 'offset')
        return [
          `const { rows, count } = await ${model}.findAndCountAll(${options([where, order(info), 'offset', 'limit'])})`,
          'return { items: rows.map(toEntity), total: count, offset, limit }',
        ]
      if (context.settings.paging === 'cursor') {
        imports.from('sequelize', 'Op').type('sequelize', 'WhereOptions')
        // After the key (a, b): a greater, or a the same and b greater
        const key = info.key
        const at = (index: number) => `after[${index}]`
        const after = key.map(
          (column, index) =>
            `{ ${[...key.slice(0, index).map((before, position) => `${before.prop}: ${at(position)}`), `${column.prop}: { [Op.gt]: ${at(index)} }`].join(', ')} }`,
        )
        return [
          `const where: WhereOptions = ${soft ? `{ ${soft} }` : '{}'}`,
          key.length === 1
            ? `if (after !== null) Object.assign(where, ${after[0]})`
            : `if (after !== null) Object.assign(where, { [Op.or]: [${after.join(', ')}] })`,
          `const rows = (await ${model}.findAll(${options(['where', order(info), 'limit: limit + 1'])})).map(toEntity)`,
          'const items = rows.slice(0, limit)',
          'const last = items[items.length - 1]',
          `return { items, next: rows.length > limit ? [${key.map((column) => `last.${column.prop}`).join(', ')}] : null }`,
        ]
      }
      return [`return (await ${model}.findAll(${options([where, order(info)])})).map(toEntity)`]
    }
    case 'insert':
      // The values the database filled (the key, defaults) are read back into the entity
      return write(
        info,
        [
          `const row = await ${model}.create(insertValues(entity), { transaction: this.transaction })`,
          info.table.primaryKey && 'await row.reload({ transaction: this.transaction })',
          'return Object.assign(entity, toEntity(row))',
        ],
        imports,
      )
    case 'update':
      if (!info.columns.some((column) => changeable(info, column))) return ['// Nothing of the row can change but its key', 'return entity']
      return [
        ...write(info, [`await ${model}.update(updateValues(entity), { ${keyWhere(info)}, transaction: this.transaction })`], imports),
        'return entity',
      ]
    case 'delete':
      return write(info, [`await ${model}.destroy({ ${keyWhere(info)}, transaction: this.transaction })`], imports)
    default:
      return ["throw new Error('not written')"]
  }
}
