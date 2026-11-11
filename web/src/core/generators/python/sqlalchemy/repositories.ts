/**
 * The repository of each table: the interface services depend on (a Protocol, when the settings want one),
 * its SQLAlchemy implementation and its in-memory one, with the same methods. Repositories read and write
 * rows and never decide anything; the only translation they make is a database refusal into a
 * `ConflictError`, for the races the services' checks cannot prevent.
 */
import type { QueryDesign } from '../../../crud/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import { indent, lines, type Line } from '../../types.ts'
import { Imports, pyLiteral } from '../python.ts'
import {
  aw,
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

interface Method {
  query: QueryDesign
  name: string
  params: { name: string; type: string }[]
  returns: string
  doc: string
}

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

const signature = (context: Context, method: Method) =>
  `${def(context)} ${method.name}(${['self', ...method.params.map((param) => `${param.name}: ${param.type}`)].join(', ')}) -> ${method.returns}:`

// SQLAlchemy

/** The filter that leaves out rows marked as deleted. */
function softFilter(info: TableInfo): string | null {
  if (!info.soft) return null
  const attr = `${info.entity}.${info.soft.attr}`
  return info.soft.column.type.kind === 'boolean' ? `${attr}.is_(False)` : `${attr}.is_(None)`
}

function where(info: TableInfo, conditions: string[]): string {
  const all = [...conditions, softFilter(info)].filter((item): item is string => item !== null)
  return all.length > 0 ? `.where(${all.join(', ')})` : ''
}

const keyColumns = (info: TableInfo) => info.key.map((column) => `${info.entity}.${column.attr}`).join(', ')

function sqlBody(context: Context, info: TableInfo, method: Method, imports: Imports): Line[] {
  const a = aw(context)
  const entity = info.entity
  const equals = method.params.map((param) => `${entity}.${param.name} == ${param.name}`)
  const commit = context.settings.transactions === 'repository'
  const write = (action: string): Line[] => {
    imports.from('sqlalchemy.exc', 'IntegrityError').from('app.errors', 'ConflictError')
    return [
      action,
      'try:',
      `    ${a}self._session.flush()`,
      'except IntegrityError as error:',
      `    ${a}self._session.rollback()`,
      `    raise ConflictError("${entity}", "the database refused the change: " + str(error.orig)) from error`,
      commit && `${a}self._session.commit()`,
    ]
  }
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      imports.from('sqlalchemy', 'select')
      return [`return (${a}self._session.scalars(select(${entity})${where(info, equals)})).first()`]
    case 'listByParent':
    case 'findAllBy':
      imports.from('sqlalchemy', 'select')
      return [`return list((${a}self._session.scalars(select(${entity})${where(info, equals)}.order_by(${keyColumns(info)}))).all())`]
    case 'list': {
      imports.from('sqlalchemy', 'select')
      const base = `query = select(${entity})${where(info, [])}`
      if (context.settings.paging === 'offset') {
        imports.from('sqlalchemy', 'func')
        return [
          base,
          `total = ${a}self._session.scalar(select(func.count()).select_from(query.subquery())) or 0`,
          `rows = (${a}self._session.scalars(query.order_by(${keyColumns(info)}).offset(offset).limit(limit))).all()`,
          'return Page(items=list(rows), total=total, offset=offset, limit=limit)',
        ]
      }
      if (context.settings.paging === 'cursor') {
        const single = info.key.length === 1
        if (!single) imports.from('sqlalchemy', 'tuple_')
        const after = single ? `${entity}.${info.key[0].attr} > after[0]` : `tuple_(${keyColumns(info)}) > tuple_(*after)`
        return [
          base,
          'if after is not None:',
          `    query = query.where(${after})`,
          `rows = list((${a}self._session.scalars(query.order_by(${keyColumns(info)}).limit(limit + 1))).all())`,
          'more = len(rows) > limit',
          'rows = rows[:limit]',
          `last = (${info.key.map((column) => `rows[-1].${column.attr}`).join(', ')},) if more else None`,
          'return CursorPage(items=rows, next=last)',
        ]
      }
      return [base, `return list((${a}self._session.scalars(query.order_by(${keyColumns(info)}))).all())`]
    }
    case 'insert':
      return [...write('self._session.add(entity)'), `${a}self._session.refresh(entity)`, 'return entity']
    case 'update':
      return [...write('self._session.add(entity)'), `${a}self._session.refresh(entity)`, 'return entity']
    case 'delete':
      return write(`${a}self._session.delete(entity)`)
    default:
      return ['raise NotImplementedError']
  }
}

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
  const sessionType = context.async ? 'AsyncSession' : 'Session'
  imports.from(context.async ? 'sqlalchemy.ext.asyncio' : 'sqlalchemy.orm', sessionType)
  if (context.settings.repositoryInterfaces) imports.from('typing', 'Protocol')
  const sqlMethods = methods.map((method) => methodBlock(context, method, sqlBody(context, info, method, imports)))
  const memoryMethods = context.settings.memoryRepositories
    ? methods.map((method) => methodBlock(context, method, memoryBody(context, info, method, imports)))
    : []
  if (context.settings.memoryRepositories) imports.from('typing', 'Any')
  const identity = info.columns.some((column) => column.column.generated === 'identity')
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
    `    """Keeps ${info.name} rows in the database, through a ${sessionType}.${context.settings.transactions === 'repository' ? ' Every write is committed at once.' : ' It never commits: the transaction belongs to whoever holds the session.'}"""`,
    '',
    `    def __init__(self, session: ${sessionType}) -> None:`,
    '        self._session = session',
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
