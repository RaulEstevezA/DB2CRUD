/**
 * The repository of each table: the interface services depend on (when the settings want one), its database
 * implementation (written by each ORM, common/orm.ts) and its in-memory one, with the same methods. Repositories
 * read and write rows and never decide anything; the only translation they make is a database refusal into a
 * ConflictError, for the races the services' checks cannot prevent.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { indent, lines, type Line } from '../../types.ts'
import { tsLiteral, TsImports } from '../typescript.ts'
import {
  columnOf,
  memoryRepositoryClass,
  moduleOf,
  pathOf,
  queryName,
  repositoryInterface,
  sqlRepositoryClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import type { RepositoryMethod } from './orm.ts'

/** The methods of a table's repository, with their TypeScript signatures. */
export function repositoryMethods(context: Context, info: TableInfo, imports: TsImports): RepositoryMethod[] {
  const entity = info.entity
  const methods: RepositoryMethod[] = []
  for (const query of info.queries) {
    const name = queryName(context, query)
    const byColumns = query.columns.map((column) => ({ name: columnOf(info, column).prop, type: columnOf(info, column).ts }))
    const add = (params: RepositoryMethod['params'], returns: string, doc: string) => methods.push({ query, name, params, returns, doc })
    switch (query.kind) {
      case 'getByKey':
        add(byColumns, `${entity} | null`, 'The row with this primary key, or null.')
        break
      case 'findByUnique':
        add(byColumns, `${entity} | null`, `The row with this ${query.columns.join(' and ')}, or null.`)
        break
      case 'listByParent':
      case 'findAllBy':
        add(byColumns, `${entity}[]`, `Rows with this ${query.columns.join(' and ')}, by primary key.`)
        break
      case 'list':
        if (context.settings.paging === 'offset') {
          imports.type('src/paging', 'Page')
          add(
            [
              { name: 'offset', type: 'number' },
              { name: 'limit', type: 'number' },
            ],
            `Page<${entity}>`,
            'At most `limit` rows from `offset`, by primary key, and how many there are.',
          )
        } else if (context.settings.paging === 'cursor') {
          imports.type('src/paging', 'CursorPage')
          add(
            [
              { name: 'after', type: 'unknown[] | null' },
              { name: 'limit', type: 'number' },
            ],
            `CursorPage<${entity}>`,
            'At most `limit` rows after the key `after`, by primary key, and the key to read the next page from.',
          )
        } else add([], `${entity}[]`, 'Every row, by primary key.')
        break
      case 'insert':
        add([{ name: 'entity', type: entity }], entity, 'Stores a new row; the values the database fills are read back.')
        break
      case 'update':
        add([{ name: 'entity', type: entity }], entity, 'Stores the changes made to a row read from this repository.')
        break
      case 'delete':
        add([{ name: 'entity', type: entity }], 'void', 'Removes a row read from this repository.')
        break
    }
  }
  return methods
}

/** Default values of the list's parameters, in the classes (the interface leaves them optional). */
const DEFAULTS: Record<string, string> = { offset: '0', limit: '50', after: 'null' }

function parameters(method: RepositoryMethod, withDefaults: boolean): string {
  return method.params
    .map((param) =>
      method.query.kind === 'list'
        ? withDefaults
          ? `${param.name}: ${param.type} = ${DEFAULTS[param.name]}`
          : `${param.name}?: ${param.type}`
        : `${param.name}: ${param.type}`,
    )
    .join(', ')
}

function methodBlock(method: RepositoryMethod, body: Line[]): string {
  return lines(
    `/** ${method.doc} */`,
    `async ${method.name}(${parameters(method, true)}): Promise<${method.returns}> {`,
    indent(lines(...body), 2),
    '}',
  )
}

// In memory

/** The value a new row gets for a column the database would fill. */
function memoryFill(context: Context, column: ColumnInfo, imports: TsImports): string | null {
  const db = column.column
  const target = `entity.${column.prop}`
  const unset = context.orm.unset(target)
  if (db.generated === 'identity') return `if (${unset}) ${target} = this.nextId++`
  if (db.generated === 'uuid') {
    imports.from('node:crypto', 'randomUUID')
    return `if (${unset}) ${target} = randomUUID()`
  }
  if (db.generated === 'now' || db.generated === 'onUpdateNow') return `if (${unset}) ${target} = new Date()`
  if (db.default?.kind === 'literal') return `if (${unset}) ${target} = ${tsLiteral(db.default.value)}`
  return null
}

function memoryVisible(info: TableInfo): string {
  if (!info.soft) return 'true'
  return info.soft.column.type.kind === 'boolean' ? `!row.${info.soft.prop}` : `row.${info.soft.prop} == null`
}

function memoryBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: TsImports): Line[] {
  const rows = 'this.visible()'
  const conditions = method.params.map((param) => `row.${param.name} === ${param.name}`).join(' && ')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return ${rows}.find((row) => ${conditions}) ?? null`]
    case 'listByParent':
    case 'findAllBy':
      return [`return ${rows}.filter((row) => ${conditions})`]
    case 'list':
      if (context.settings.paging === 'offset')
        return [`const rows = ${rows}`, 'return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit }']
      if (context.settings.paging === 'cursor')
        return [
          `const rows = ${rows}.filter((row) => after === null || compareKeys(keyOf(row), after) > 0)`,
          'const items = rows.slice(0, limit)',
          'return { items, next: rows.length > limit ? keyOf(items[items.length - 1]) : null }',
        ]
      return [`return ${rows}`]
    case 'insert': {
      const fills = info.columns.map((column) => memoryFill(context, column, imports)).filter((line): line is string => line !== null)
      return [...fills, 'this.rows.set(JSON.stringify(keyOf(entity)), entity)', 'return entity']
    }
    case 'update':
      return ['this.rows.set(JSON.stringify(keyOf(entity)), entity)', 'return entity']
    case 'delete':
      return ['this.rows.delete(JSON.stringify(keyOf(entity)))']
    default:
      return ["throw new Error('not written')"]
  }
}

export function repositoryFile(context: Context, info: TableInfo): GeneratedFile {
  const module = moduleOf(context, info, 'repository')
  const imports = new TsImports(module).from(moduleOf(context, info, 'entity'), info.entity)
  const methods = repositoryMethods(context, info, imports)
  const interfaces = context.settings.repositoryInterfaces
  const memory = context.settings.memoryRepositories
  // Written before the imports, which they add to
  const sqlMethods = methods.map((method) => methodBlock(method, context.orm.repository.body(context, info, method, imports)))
  const constructorLines = context.orm.repository.init(context, imports)
  const memoryMethods = memory ? methods.map((method) => methodBlock(method, memoryBody(context, info, method, imports))) : []
  const identity = info.columns.some((column) => column.column.generated === 'identity')
  const implementsClause = interfaces ? ` implements ${repositoryInterface(info)}` : ''
  const content = lines(
    `/** Repository of the "${info.name}" table: reads and writes rows, and decides nothing. */`,
    imports.write(),
    '',
    interfaces && [
      `/** Where ${info.name} rows are kept. Services depend only on this interface. */`,
      `export interface ${repositoryInterface(info)} {`,
      ...methods.map((method) => `  ${method.name}(${parameters(method, false)}): Promise<${method.returns}>`),
      '}',
      '',
    ],
    memory && [
      '/** The key of a row, as a list of its key values. */',
      `function keyOf(row: ${info.entity}): unknown[] {`,
      `  return [${info.key.map((column) => `row.${column.prop}`).join(', ')}]`,
      '}',
      '',
      '/** Orders two keys value by value. */',
      'function compareKeys(a: unknown[], b: unknown[]): number {',
      '  for (let index = 0; index < a.length; index++) {',
      '    const x = a[index] as number | string',
      '    const y = b[index] as number | string',
      '    if (x < y) return -1',
      '    if (x > y) return 1',
      '  }',
      '  return 0',
      '}',
      '',
    ],
    `/** ${context.orm.repository.doc(context, info)} */`,
    `export class ${sqlRepositoryClass(info)}${implementsClause} {`,
    ...constructorLines.map((line) => (typeof line === 'string' ? (line === '' ? '' : `  ${line}`) : line)),
    ...sqlMethods.flatMap((block) => ['', indent(block, 2)]),
    '}',
    memory && [
      '',
      `/** Keeps ${info.name} rows in memory, for tests and for trying the services without a database. */`,
      `export class ${memoryRepositoryClass(info)}${implementsClause} {`,
      `  private readonly rows = new Map<string, ${info.entity}>()`,
      identity && '  private nextId = 1',
      '',
      `  private visible(): ${info.entity}[] {`,
      `    return [...this.rows.values()].filter((row) => ${memoryVisible(info)}).sort((a, b) => compareKeys(keyOf(a), keyOf(b)))`,
      '  }',
      ...memoryMethods.flatMap((block) => ['', indent(block, 2)]),
      '}',
    ],
    '',
  )
  return { path: pathOf(module), content }
}
