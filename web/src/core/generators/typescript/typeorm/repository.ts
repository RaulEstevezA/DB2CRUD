/**
 * The bodies of the TypeORM repositories, over an EntityManager: find options with the soft-delete filter,
 * pages by offset or after a key (a query builder), and writes that turn a database refusal into a
 * ConflictError.
 */
import type { Line } from '../../types.ts'
import type { TsImports } from '../typescript.ts'
import { findInfo, type Context, type TableInfo } from '../common/context.ts'
import type { RepositoryMethod } from '../common/orm.ts'

/** The condition that leaves out rows marked as deleted, as a find option. */
function softOption(info: TableInfo, imports: TsImports): string | null {
  if (!info.soft) return null
  if (info.soft.column.type.kind === 'boolean') return `${info.soft.prop}: false`
  imports.from('typeorm', 'IsNull')
  return `${info.soft.prop}: IsNull()`
}

function where(info: TableInfo, conditions: string[], imports: TsImports): string | null {
  const all = [...conditions, softOption(info, imports)].filter((item): item is string => item !== null)
  return all.length > 0 ? `where: { ${all.join(', ')} }` : null
}

const order = (info: TableInfo) => `order: { ${info.key.map((column) => `${column.prop}: 'ASC'`).join(', ')} }`

const options = (items: (string | null)[]) => {
  const present = items.filter((item): item is string => item !== null)
  return present.length > 0 ? `, { ${present.join(', ')} }` : ''
}

/** A write, with a database refusal (a unique value, a row still pointed to) turned into a ConflictError. */
function write(info: TableInfo, action: string, imports: TsImports): Line[] {
  imports.from('typeorm', 'QueryFailedError').from('src/errors', 'ConflictError')
  return [
    'try {',
    `  ${action}`,
    '} catch (error) {',
    `  if (error instanceof QueryFailedError) throw new ConflictError('${info.entity}', \`the database refused the change: \${error.message}\`)`,
    '  throw error',
    '}',
  ]
}

/** Whether the entity holds JSON (unknown) values, itself or through the rows its relations point to: TypeORM's
 * insert() then cannot check it against its deep partial type, and is told what it is. */
function reachesJson(context: Context, info: TableInfo, seen = new Set<string>()): boolean {
  if (seen.has(info.name)) return false
  seen.add(info.name)
  if (info.columns.some((column) => column.column.type.kind === 'json' || column.column.type.kind === 'array')) return true
  return info.table.foreignKeys.some((key) => {
    const parent = findInfo(context, key.references.table)
    return parent !== undefined && parent.table.primaryKey !== null && reachesJson(context, parent, seen)
  })
}

export function typeormBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: TsImports): Line[] {
  const entity = info.entity
  const params = method.params.map((param) => param.name)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return this.manager.findOne(${entity}${options([where(info, params, imports)])})`]
    case 'listByParent':
    case 'findAllBy':
      return [`return this.manager.find(${entity}${options([where(info, params, imports), order(info)])})`]
    case 'list': {
      if (context.settings.paging === 'offset')
        return [
          `const [items, total] = await this.manager.findAndCount(${entity}${options([where(info, [], imports), order(info), 'skip: offset', 'take: limit'])})`,
          'return { items, total, offset, limit }',
        ]
      if (context.settings.paging === 'cursor') {
        const single = info.key.length === 1
        const columns = info.key.map((column) => `row.${column.prop}`)
        const marks = info.key.map((_, index) => `:k${index}`)
        const values = info.key.map((_, index) => `k${index}: after[${index}]`).join(', ')
        const after = single ? `${columns[0]} > ${marks[0]}` : `(${columns.join(', ')}) > (${marks.join(', ')})`
        const soft = info.soft
          ? info.soft.column.type.kind === 'boolean'
            ? `row.${info.soft.prop} = false`
            : `row.${info.soft.prop} IS NULL`
          : null
        return [
          `const query = this.manager.createQueryBuilder(${entity}, 'row')`,
          ...columns.map((column, index) => `query.${index === 0 ? 'orderBy' : 'addOrderBy'}('${column}', 'ASC')`),
          'query.limit(limit + 1)',
          soft && `query.andWhere('${soft}')`,
          `if (after !== null) query.andWhere('${after}', { ${values} })`,
          'const rows = await query.getMany()',
          'const items = rows.slice(0, limit)',
          `const last = items[items.length - 1]`,
          `return { items, next: rows.length > limit ? [${info.key.map((column) => `last.${column.prop}`).join(', ')}] : null }`,
        ]
      }
      return [`return this.manager.find(${entity}${options([where(info, [], imports), order(info)])})`]
    }
    case 'insert': {
      // insert() puts the values the database filled (the key, defaults) back into the entity, but a new 64-bit
      // key as the driver returns it: text. Reads return it as a number (the data source asks for that)
      const bigKeys = info.columns.filter(
        (column) => column.column.generated === 'identity' && column.column.type.kind === 'integer' && column.column.type.bits === 64,
      )
      const json = reachesJson(context, info)
      if (json) imports.type('typeorm', 'QueryDeepPartialEntity')
      return [
        ...write(info, `await this.manager.insert(${entity}, ${json ? `entity as QueryDeepPartialEntity<${entity}>` : 'entity'})`, imports),
        bigKeys.length > 0 && '// The driver returns a new 64-bit key as text',
        ...bigKeys.map((column) => `entity.${column.prop} = Number(entity.${column.prop})`),
        'return entity',
      ]
    }
    case 'update':
      return [...write(info, `await this.manager.save(${entity}, entity)`, imports), 'return entity']
    case 'delete':
      return write(
        info,
        `await this.manager.delete(${entity}, { ${info.key.map((column) => `${column.prop}: entity.${column.prop}`).join(', ')} })`,
        imports,
      )
    default:
      return ["throw new Error('not written')"]
  }
}
