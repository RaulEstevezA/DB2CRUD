/**
 * Python without an ORM (Strategy of common/orm.ts): repositories that write their SQL, through each database's
 * driver (psycopg 3, MySQL Connector/Python, sqlite3), over one connection; plain dataclasses as entities; a unit of
 * work that commits or rolls back the connection; and tests on a real database created from the schema's DDL.
 * Synchronous: the drivers are.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { createStatements, dropStatements, quoteName, tableName } from '../../../schema/ddl.ts'
import { lines, type Line } from '../../types.ts'
import { Imports, pyLiteral } from '../python.ts'
import { sqlRepositoryClass, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import type { PythonOrm, RepositoryMethod } from '../common/orm.ts'
import { databaseFiles, defaultUrl, driverLabel, mark, readerOf } from './database.ts'

const VERSIONS = {
  psycopg: 'psycopg[binary]>=3.2,<4',
  mysql: 'mysql-connector-python>=9.1,<10',
  pydantic: 'pydantic>=2.9,<3',
  pytest: 'pytest>=8.3,<9',
}

/** A Python string of SQL: between single quotes, so the double quotes of names read as they are. */
const sql = (text: string) => (/['\\\n]/.test(text) ? pyLiteral(text) : `'${text}'`)

const q = (context: Context, name: string) => quoteName(context.settings.database, name)
const table = (context: Context, info: TableInfo) => tableName(context.settings.database, info.table)

/** A computed column is never written; the key of a stored row, and what the database fills on change, neither. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const returns = (context: Context) => context.settings.database !== 'mysql' && context.settings.database !== 'mariadb'

/** `"id", "name"`: the columns every read selects, in the order `_entity` takes them. */
const selectList = (context: Context, info: TableInfo) => info.columns.map((column) => q(context, column.column.name)).join(', ')

/** The condition that leaves out rows marked as deleted. */
function softCondition(context: Context, info: TableInfo): string | null {
  if (!info.soft) return null
  const column = q(context, info.soft.column.name)
  return info.soft.column.type.kind === 'boolean' ? `${column} = FALSE` : `${column} IS NULL`
}

function whereSql(conditions: (string | null)[]): string {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? ` WHERE ${present.join(' AND ')}` : ''
}

const equals = (context: Context, columns: ColumnInfo[]) => columns.map((column) => `${q(context, column.column.name)} = ${mark(context)}`)
const orderBy = (context: Context, info: TableInfo) => ` ORDER BY ${info.key.map((column) => q(context, column.column.name)).join(', ')}`
const params = (values: string[]) => (values.length === 0 ? '()' : `(${values.join(', ')},)`)
const toDb = (expression: string) => `to_db(${expression})`

/** The key of the entity as the parameters of a query. */
const keyParams = (info: TableInfo, target = 'entity') => params(info.key.map((column) => toDb(`${target}.${column.attr}`)))

/** The module-level helpers of a repository: the columns it selects and the entity of a row. */
function helpers(context: Context, info: TableInfo, imports: Imports): Line[] {
  const values = info.columns.map((column, index) => {
    const reader = readerOf(context, column.column.type.kind)
    if (reader) imports.from('app.db', reader)
    return `        ${column.attr}=${reader ? `${reader}(row[${index}])` : `row[${index}]`},`
  })
  imports.from('typing', 'Any')
  return [
    '',
    '',
    `_COLUMNS = ${sql(selectList(context, info))}`,
    '',
    '',
    `def _entity(row: tuple[Any, ...]) -> ${info.entity}:`,
    `    """The ${info.entity} of a row read with _COLUMNS."""`,
    `    return ${info.entity}(`,
    ...values,
    '    )',
  ]
}

/** A write, with a refusal of the database turned into a ConflictError (and committed when every write is its own). */
function write(context: Context, info: TableInfo, action: Line[], imports: Imports, after: Line[] = []): Line[] {
  imports.from('app.db', 'IntegrityError').from('app.errors', 'ConflictError')
  return [
    'try:',
    ...action.map((line) => (typeof line === 'string' ? `    ${line}` : line)),
    'except IntegrityError as error:',
    '    self._connection.rollback()',
    `    raise ConflictError("${info.entity}", "the database refused the change: " + str(error)) from error`,
    context.settings.transactions === 'repository' && 'self._connection.commit()',
    ...after,
  ]
}

/** Reads a stored row again by its key, without the soft-delete filter. */
const readBack = (context: Context, info: TableInfo, target: string) => [
  `row = fetch_one(self._connection, 'SELECT ' + _COLUMNS + ${sql(` FROM ${table(context, info)}${whereSql(equals(context, info.key))}`)}, ${keyParams(info, target)})`,
  'if row is None:',
  `    raise LookupError("The ${info.entity} just written is not there")`,
  'return _entity(row)',
]

function body(context: Context, info: TableInfo, method: RepositoryMethod, imports: Imports): Line[] {
  imports.from('app.db', 'fetch_one', 'fetch_all', 'execute', 'to_db')
  const from = ` FROM ${table(context, info)}`
  const select = (rest: string) => `'SELECT ' + _COLUMNS + ${sql(`${from}${rest}`)}`
  const byColumns = method.query.columns.map((name) => info.columns.find((column) => column.column.name === name)!)
  const byParams = params(byColumns.map((column) => toDb(column.attr)))
  const soft = softCondition(context, info)
  const m = mark(context)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        `row = fetch_one(self._connection, ${select(whereSql([...equals(context, byColumns), soft]))}, ${byParams})`,
        'return _entity(row) if row is not None else None',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [
        `rows = fetch_all(self._connection, ${select(`${whereSql([...equals(context, byColumns), soft])}${orderBy(context, info)}`)}, ${byParams})`,
        'return [_entity(row) for row in rows]',
      ]
    case 'list': {
      const where = whereSql([soft])
      if (context.settings.paging === 'offset')
        return [
          `rows = fetch_all(self._connection, ${select(`${where}${orderBy(context, info)} LIMIT ${m} OFFSET ${m}`)}, (limit, offset))`,
          `counted = fetch_one(self._connection, ${sql(`SELECT COUNT(*)${from}${where}`)})`,
          'total = int(counted[0]) if counted is not None else 0',
          'return Page(items=[_entity(row) for row in rows], total=total, offset=offset, limit=limit)',
        ]
      if (context.settings.paging === 'cursor') {
        const key = info.key.map((column) => q(context, column.column.name))
        const after = key.length === 1 ? `${key[0]} > ${m}` : `(${key.join(', ')}) > (${key.map(() => m).join(', ')})`
        return [
          `condition = ${sql(whereSql([soft, after]))} if after is not None else ${sql(where)}`,
          `values = tuple(to_db(value) for value in after) if after is not None else ()`,
          `rows = fetch_all(self._connection, 'SELECT ' + _COLUMNS + ${sql(from)} + condition + ${sql(`${orderBy(context, info)} LIMIT ${m}`)}, (*values, limit + 1))`,
          'items = [_entity(row) for row in rows[:limit]]',
          `last = (${info.key.map((column) => `items[-1].${column.attr}`).join(', ')},) if len(rows) > limit else None`,
          'return CursorPage(items=items, next=last)',
        ]
      }
      return [`rows = fetch_all(self._connection, ${select(`${where}${orderBy(context, info)}`)})`, 'return [_entity(row) for row in rows]']
    }
    case 'insert': {
      const columns = info.columns.filter(writable)
      const uuids = columns.filter((column) => column.column.generated === 'uuid')
      if (uuids.length > 0) imports.from('uuid', 'uuid4')
      const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' ? info.key[0] : null
      const returning = returns(context)
      // Values left None take the database's default
      const prepare = [
        ...uuids.flatMap((column) => [`if entity.${column.attr} is None:`, `    entity.${column.attr} = uuid4()`]),
        'given = [',
        ...columns.map((column) => `    (${sql(q(context, column.column.name))}, entity.${column.attr}),`),
        ']',
        'given = [(column, value) for column, value in given if value is not None]',
        'names = ", ".join(column for column, _ in given)',
        `marks = ", ".join(${sql(m)} for _ in given)`,
      ]
      const values = 'tuple(to_db(value) for _, value in given)'
      const into = `INSERT INTO ${table(context, info)}`
      if (returning) {
        const defaults = `${into} DEFAULT VALUES RETURNING `
        return write(
          context,
          info,
          [
            ...prepare,
            'sql = (',
            `    f${sql(`${into} ({names}) VALUES ({marks}) RETURNING `)} if given else ${sql(defaults)}`,
            ') + _COLUMNS',
            `row = fetch_one(self._connection, sql, ${values})`,
          ],
          imports,
          ['if row is None:', `    raise LookupError("The ${info.entity} just written is not there")`, 'return _entity(row)'],
        )
      }
      return write(
        context,
        info,
        [
          ...prepare,
          `new_id = execute(self._connection, f${sql(`${into} ({names}) VALUES ({marks})`)}, ${values})`,
          identity && `if entity.${identity.attr} is None:`,
          identity && `    entity.${identity.attr} = new_id`,
        ],
        imports,
        readBack(context, info, 'entity'),
      )
    }
    case 'update': {
      const changes = info.columns.filter((column) => changeable(info, column))
      const stamps = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
      const sets = [
        ...changes.map((column) => `${q(context, column.column.name)} = ${m}`),
        ...stamps.map((column) => `${q(context, column.column.name)} = CURRENT_TIMESTAMP`),
      ]
      if (sets.length === 0) return readBack(context, info, 'entity')
      const values = params([
        ...changes.map((column) => toDb(`entity.${column.attr}`)),
        ...info.key.map((column) => toDb(`entity.${column.attr}`)),
      ])
      return write(
        context,
        info,
        [
          `execute(self._connection, ${sql(`UPDATE ${table(context, info)} SET ${sets.join(', ')}${whereSql(equals(context, info.key))}`)}, ${values})`,
        ],
        imports,
        readBack(context, info, 'entity'),
      )
    }
    case 'delete':
      return write(
        context,
        info,
        [`execute(self._connection, ${sql(`DELETE${from}${whereSql(equals(context, info.key))}`)}, ${keyParams(info)})`],
        imports,
      )
    default:
      return ['raise NotImplementedError']
  }
}

function dependencies(context: Context): string[] {
  const { database, serviceTypes, dtoKind } = context.settings
  const deps: string[] = []
  if (database === 'postgresql') deps.push(VERSIONS.psycopg)
  if (database === 'mysql' || database === 'mariadb') deps.push(VERSIONS.mysql)
  if (serviceTypes === 'dtos' && dtoKind === 'pydantic') deps.push(VERSIONS.pydantic)
  return deps
}

/** The class SqlUnitOfWork: the repositories over one connection, and the transaction of each operation. */
function unitOfWork(context: Context, imports: Imports): Line[] {
  imports.from('app.db', 'Connection').from('collections.abc', 'Iterator').from('contextlib', 'contextmanager')
  return [
    'class SqlUnitOfWork:',
    `    """The repositories over one connection of ${driverLabel(context)}."""`,
    '',
    '    def __init__(self, connection: Connection) -> None:',
    '        self.connection = connection',
    ...context.tables.map((info) => `        self.${info.attr} = ${sqlRepositoryClass(info)}(connection)`),
    '',
    '    @contextmanager',
    '    def transaction(self) -> Iterator[None]:',
    '        """Commits what runs inside it, or rolls it back if it fails."""',
    '        try:',
    '            yield',
    '        except BaseException:',
    '            self.connection.rollback()',
    '            raise',
    context.settings.transactions === 'operation'
      ? '        self.connection.commit()'
      : '        # The commit belongs to whoever holds the connection',
  ]
}

/** tests/schema.py: the SQL that removes and creates the tables of the test database. */
function schemaFile(context: Context): GeneratedFile {
  const database = context.settings.database
  const list = (name: string, doc: string, statements: string[]) => [
    `${name} = [`,
    ...statements.map((statement) => `    ${JSON.stringify(statement)},`),
    ']',
    `"""${doc}"""`,
  ]
  return {
    path: 'tests/schema.py',
    content: lines(
      '"""The tables of the test database, as the schema DB2CRUD read has them."""',
      '',
      ...list('DROP', 'Removes every table, so the database starts empty.', dropStatements(context.schema, database)),
      '',
      ...list('CREATE', 'Creates every table, in an order the database accepts.', createStatements(context.schema, database)),
      '',
    ),
  }
}

function conftestFile(context: Context): GeneratedFile {
  const imports = new Imports().module('os').module('pytest').from('collections.abc', 'Iterator')
  imports
    .from('app.db', 'Connection', 'connect', 'execute')
    .from('app.unit_of_work', 'SqlUnitOfWork')
    .from('tests.schema', 'CREATE', 'DROP')
  if (context.settings.memoryRepositories) imports.from('app.unit_of_work', 'MemoryUnitOfWork')
  const content = lines(
    '"""Fixtures of the tests: a database created from the schema, and the units of work."""',
    '',
    imports.write('app'),
    '',
    '',
    '@pytest.fixture',
    'def connection(tmp_path) -> Iterator[Connection]:  # type: ignore[no-untyped-def]',
    '    """The test database, empty: TEST_DATABASE_URL, or SQLite in a temporary file."""',
    '    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / \'test.db\'}"',
    '    connection = connect(url)',
    '    for statement in DROP + CREATE:',
    '        execute(connection, statement)',
    '    connection.commit()',
    '    yield connection',
    '    connection.rollback()',
    '    for statement in DROP:',
    '        execute(connection, statement)',
    '    connection.commit()',
    '    connection.close()',
    '',
    '',
    '@pytest.fixture',
    'def sql_uow(connection: Connection) -> SqlUnitOfWork:',
    '    """The repositories over the test database."""',
    '    return SqlUnitOfWork(connection)',
    context.settings.memoryRepositories && [
      '',
      '',
      '@pytest.fixture',
      'def memory_uow() -> MemoryUnitOfWork:',
      '    """The in-memory repositories."""',
      '    return MemoryUnitOfWork()',
    ],
    '',
  )
  return { path: 'tests/conftest.py', content }
}

/** Fails when the tests do not run on the database TEST_DATABASE_URL names, so a green run proves which one it was. */
function databaseTest(): GeneratedFile {
  return {
    path: 'tests/test_database.py',
    content: lines(
      '"""The tests run on the database they were asked to."""',
      '',
      'import os',
      '',
      'from app.db import Connection',
      '',
      '# The module of the connection each database gives',
      'DRIVERS = {"postgresql": "psycopg", "mysql": "mysql", "mariadb": "mysql", "sqlite": "sqlite3"}',
      '',
      '',
      'def test_runs_on_the_database_asked(connection: Connection) -> None:',
      '    url = os.environ.get("TEST_DATABASE_URL")',
      '    expected = url.split(":", 1)[0].split("+", 1)[0] if url else "sqlite"',
      '    assert type(connection).__module__.split(".")[0] == DRIVERS[expected]',
      '',
    ),
  }
}

export const sqlOrm: PythonOrm = {
  id: 'sql',
  label: 'SQL',
  databaseFiles,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, with SQL through ${driverLabel(context)}.${context.settings.transactions === 'repository' ? ' Every write is committed at once.' : ' It never commits: the transaction belongs to whoever holds the connection.'}`,
    init: (_context, imports) => {
      imports.from('app.db', 'Connection')
      return ['def __init__(self, connection: Connection) -> None:', '    self._connection = connection']
    },
    body,
    helpers,
  },
  unset: (target) => `${target} is None`,
  unitOfWork,
  conftest: conftestFile,
  databaseTest,
  extraTestFiles: (context) => [schemaFile(context)],
  databaseFixture: 'sql_uow: SqlUnitOfWork',
  dependencies,
  devDependencies: () => [VERSIONS.pytest],
  pytestOptions: () => [],
  defaultUrl,
  layout: () => ['app/db.py              the connection and the helpers that run SQL'],
}
