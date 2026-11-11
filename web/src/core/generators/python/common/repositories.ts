/**
 * The repository of each table: the interface services depend on (a Protocol, when the settings want one),
 * its database implementation (written by each ORM, common/orm.ts) and its in-memory one, with the same methods. Repositories read and write
 * rows and never decide anything; the only translation they make is a database refusal into a
 * `ConflictError`, for the races the services' checks cannot prevent.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { indent, lines, type Line } from '../../types.ts'
import { Imports, pyLiteral } from '../python.ts'
import type { RepositoryMethod } from './orm.ts'
import {
  columnPyType,
  def,
  memoryRepositoryClass,
  moduleOf,
  pathOf,
  queryName,
  repositoryClass,
  sqlRepositoryClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'

type Method = RepositoryMethod

const columnsOf = (info: TableInfo, names: string[]) => names.map((name) => info.columns.find((column) => column.column.name === name)!)

/** The methods of a table's repository, with their Python signatures. */
export function repositoryMethods(context: Context, info: TableInfo, imports: Imports): Method[] {
  const entity = info.entity
  const paging = context.settings.paging
  const methods: Method[] = []
  for (const query of info.queries) {
    const name = queryName(context, query)
    const byColumns = columnsOf(info, query.columns).map((column) => ({ name: column.attr, type: columnPyType(column, imports, false) }))
    switch (query.kind) {
      case 'getByKey':
        methods.push({ query, name, params: byColumns, returns: `${entity} | None`, doc: 'The row with this primary key, or None.' })
        break
      case 'findByUnique':
        methods.push({
          query,
          name,
          params: byColumns,
          returns: `${entity} | None`,
          doc: `The row with this ${query.columns.join(' and ')}, or None.`,
        })
        break
      case 'listByParent':
      case 'findAllBy':
        methods.push({
          query,
          name,
          params: byColumns,
          returns: `list[${entity}]`,
          doc: `Rows with this ${query.columns.join(' and ')}, by primary key.`,
        })
        break
      case 'list':
        if (paging === 'offset') {
          imports.from('app.paging', 'Page')
          methods.push({
            query,
            name,
            params: [
              { name: 'offset', type: 'int = 0' },
              { name: 'limit', type: 'int = 50' },
            ],
            returns: `Page[${entity}]`,
            doc: 'At most `limit` rows from `offset`, by primary key, and how many there are.',
          })
        } else if (paging === 'cursor') {
          imports.from('app.paging', 'CursorPage').from('typing', 'Any')
          methods.push({
            query,
            name,
            params: [
              { name: 'after', type: 'tuple[Any, ...] | None = None' },
              { name: 'limit', type: 'int = 50' },
            ],
            returns: `CursorPage[${entity}]`,
            doc: 'At most `limit` rows after the key `after`, by primary key, and the key to read the next page from.',
          })
        } else methods.push({ query, name, params: [], returns: `list[${entity}]`, doc: 'Every row, by primary key.' })
        break
      case 'insert':
        methods.push({
          query,
          name,
          params: [{ name: 'entity', type: entity }],
          returns: entity,
          doc: 'Stores a new row; the values the database fills are read back.',
        })
        break
      case 'update':
        methods.push({
          query,
          name,
          params: [{ name: 'entity', type: entity }],
          returns: entity,
          doc: 'Stores the changes made to a row read from this repository.',
        })
        break
      case 'delete':
        methods.push({
          query,
          name,
          params: [{ name: 'entity', type: entity }],
          returns: 'None',
          doc: 'Removes a row read from this repository.',
        })
        break
    }
  }
  return methods
}

export const signature = (context: Context, method: Method) =>
  `${def(context)} ${method.name}(${['self', ...method.params.map((param) => `${param.name}: ${param.type}`)].join(', ')}) -> ${method.returns}:`

// In memory

/** The value a new row gets for a column the database would fill. */
function memoryFill(column: ColumnInfo, imports: Imports): Line {
  const db = column.column
  const attr = `entity.${column.attr}`
  if (db.generated === 'identity') return `if ${attr} is None:\n    ${attr} = self._next_id\n    self._next_id += 1`
  if (db.generated === 'uuid') {
    imports.from('uuid', 'uuid4')
    return `if ${attr} is None:\n    ${attr} = uuid4()`
  }
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    imports.from('datetime', 'UTC', 'datetime')
    return `if ${attr} is None:\n    ${attr} = datetime.now(UTC)`
  }
  if (db.default?.kind === 'literal') return `if ${attr} is None:\n    ${attr} = ${pyLiteral(db.default.value)}`
  return null
}

function memoryVisible(info: TableInfo): string {
  if (!info.soft) return 'True'
  return info.soft.column.type.kind === 'boolean' ? `not row.${info.soft.attr}` : `row.${info.soft.attr} is None`
}

function memoryBody(context: Context, info: TableInfo, method: Method, imports: Imports): Line[] {
  const keyOf = (target: string) => `(${info.key.map((column) => `${target}.${column.attr}`).join(', ')},)`
  const visible = memoryVisible(info)
  const rows = `[row for row in sorted(self._rows.values(), key=self._key) if ${visible}]`
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique': {
      const conditions = method.params.map((param) => `row.${param.name} == ${param.name}`).join(' and ')
      return [`return next((row for row in ${rows} if ${conditions}), None)`]
    }
    case 'listByParent':
    case 'findAllBy': {
      const conditions = method.params.map((param) => `row.${param.name} == ${param.name}`).join(' and ')
      return [`return [row for row in ${rows} if ${conditions}]`]
    }
    case 'list':
      if (context.settings.paging === 'offset')
        return [`rows = ${rows}`, 'return Page(items=rows[offset : offset + limit], total=len(rows), offset=offset, limit=limit)']
      if (context.settings.paging === 'cursor')
        return [
          `rows = [row for row in ${rows} if after is None or self._key(row) > tuple(after)]`,
          'more = len(rows) > limit',
          'rows = rows[:limit]',
          'return CursorPage(items=rows, next=self._key(rows[-1]) if more else None)',
        ]
      return [`return ${rows}`]
    case 'insert': {
      const fills = info.columns.map((column) => memoryFill(column, imports)).filter((line): line is string => typeof line === 'string')
      return [...fills, `self._rows[${keyOf('entity')}] = entity`, 'return entity']
    }
    case 'update':
      return [`self._rows[${keyOf('entity')}] = entity`, 'return entity']
    case 'delete':
      return [`self._rows.pop(${keyOf('entity')}, None)`]
    default:
      return ['raise NotImplementedError']
  }
}

function methodBlock(context: Context, method: Method, body: Line[]): string {
  return lines(signature(context, method), `    """${method.doc}"""`, indent(lines(...body)))
}

export function repositoryFile(context: Context, info: TableInfo): GeneratedFile {
  const imports = new Imports().annotations().from(moduleOf(context, info, 'entity'), info.entity)
  const methods = repositoryMethods(context, info, imports)
  if (context.settings.repositoryInterfaces) imports.from('typing', 'Protocol')
  const sqlMethods = methods.map((method) => methodBlock(context, method, context.orm.repository.body(context, info, method, imports)))
  const memoryMethods = context.settings.memoryRepositories
    ? methods.map((method) => methodBlock(context, method, memoryBody(context, info, method, imports)))
    : []
  if (context.settings.memoryRepositories) imports.from('typing', 'Any')
  const identity = info.columns.some((column) => column.column.generated === 'identity')
  // Written before the imports, which they may add to
  const constructorLines = context.orm.repository.init(context, imports)
  const content = lines(
    `"""Repository of the "${info.name}" table: reads and writes rows, and decides nothing."""`,
    '',
    imports.write('app'),
    context.settings.repositoryInterfaces && [
      '',
      '',
      `class ${repositoryClass(info)}(Protocol):`,
      `    """Where ${info.name} rows are kept. Services depend only on this interface."""`,
      ...methods.flatMap((method) => ['', indent(lines(signature(context, method), `    """${method.doc}"""`, '    ...'))]),
    ],
    '',
    '',
    `class ${sqlRepositoryClass(info)}:`,
    `    """${context.orm.repository.doc(context, info)}"""`,
    '',
    ...constructorLines.map((line) => (typeof line === 'string' ? `    ${line}` : line)),
    ...sqlMethods.flatMap((block) => ['', indent(block)]),
    context.settings.memoryRepositories && [
      '',
      '',
      `class ${memoryRepositoryClass(info)}:`,
      `    """Keeps ${info.name} rows in memory, for tests and for trying the services without a database."""`,
      '',
      '    def __init__(self) -> None:',
      `        self._rows: dict[tuple[Any, ...], ${info.entity}] = {}`,
      identity && '        self._next_id = 1',
      '',
      '    @staticmethod',
      `    def _key(row: ${info.entity}) -> tuple[Any, ...]:`,
      `        return (${info.key.map((column) => `row.${column.attr}`).join(', ')},)`,
      ...memoryMethods.flatMap((block) => ['', indent(block)]),
    ],
    '',
  )
  return { path: pathOf(moduleOf(context, info, 'repository')), content }
}
