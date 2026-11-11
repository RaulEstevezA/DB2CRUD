/**
 * Python + SQLAlchemy 2 (Strategy of common/orm.ts): the engine, sessions and declarative base, entities
 * faithful to the database, repositories with select(), a unit of work over one session, and tests on a
 * real database. Synchronous (Session) or asynchronous (AsyncSession).
 */
import type { Line } from '../../types.ts'
import type { Imports } from '../python.ts'
import { sqlRepositoryClass, writesEntities, type Context } from '../common/context.ts'
import type { PythonOrm } from '../common/orm.ts'
import { dbFile, defaultUrl, entityFiles } from './database.ts'
import { sqlBody } from './repository.ts'
import { conftestFile, databaseTest } from './tests.ts'

const VERSIONS = {
  sqlalchemy: 'sqlalchemy>=2.0.36,<2.1',
  psycopg: 'psycopg[binary]>=3.2,<4',
  pymysql: 'pymysql>=1.1,<2',
  cryptography: 'cryptography>=43',
  aiosqlite: 'aiosqlite>=0.20,<1',
  aiomysql: 'aiomysql>=0.2,<1',
  greenlet: 'greenlet>=3.1',
  pydantic: 'pydantic>=2.9,<3',
  pytest: 'pytest>=8.3,<9',
  pytestAsyncio: 'pytest-asyncio>=0.24,<1',
}

function dependencies(context: Context): string[] {
  const { database, serviceTypes, dtoKind } = context.settings
  const deps = [VERSIONS.sqlalchemy]
  if (database === 'postgresql') deps.push(VERSIONS.psycopg)
  if (database === 'mysql' || database === 'mariadb') deps.push(VERSIONS.pymysql, VERSIONS.cryptography)
  if (context.async) {
    deps.push(VERSIONS.greenlet)
    if (database === 'sqlite') deps.push(VERSIONS.aiosqlite)
    if (database === 'mysql' || database === 'mariadb') deps.push(VERSIONS.aiomysql)
  }
  if (serviceTypes === 'dtos' && dtoKind === 'pydantic') deps.push(VERSIONS.pydantic)
  return deps
}

function devDependencies(context: Context): string[] {
  // The tests run on SQLite unless TEST_DATABASE_URL names another database
  const deps = [VERSIONS.pytest]
  if (context.async) deps.push(VERSIONS.pytestAsyncio, VERSIONS.aiosqlite)
  return deps
}

/** The class SqlUnitOfWork: the repositories over one session, and the transaction of each operation. */
function unitOfWork(context: Context, imports: Imports): Line[] {
  const sessionType = context.async ? 'AsyncSession' : 'Session'
  imports.from(context.async ? 'sqlalchemy.ext.asyncio' : 'sqlalchemy.orm', sessionType)
  const tables = context.tables
  const contextManager = context.async ? 'asynccontextmanager' : 'contextmanager'
  const iterator = context.async ? 'AsyncIterator' : 'Iterator'
  const a = context.async ? 'await ' : ''
  const def = context.async ? 'async def' : 'def'
  return [
    'class SqlUnitOfWork:',
    `    """The repositories over one ${sessionType}."""`,
    '',
    `    def __init__(self, session: ${sessionType}) -> None:`,
    '        self.session = session',
    ...tables.map((info) => `        self.${info.attr} = ${sqlRepositoryClass(info)}(session)`),
    '',
    `    @${contextManager}`,
    `    ${def} transaction(self) -> ${iterator}[None]:`,
    '        """Commits what runs inside it, or rolls it back if it fails."""',
    '        try:',
    '            yield',
    '        except BaseException:',
    `            ${a}self.session.rollback()`,
    '            raise',
    context.settings.transactions === 'operation'
      ? `        ${a}self.session.commit()`
      : '        # The commit belongs to whoever holds the session',
  ]
}

export const sqlalchemyOrm: PythonOrm = {
  id: 'sqlalchemy',
  label: 'SQLAlchemy 2',
  databaseFiles: (context) => [dbFile(context), ...entityFiles(context)],
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, through a ${context.async ? 'AsyncSession' : 'Session'}.${context.settings.transactions === 'repository' ? ' Every write is committed at once.' : ' It never commits: the transaction belongs to whoever holds the session.'}`,
    init: (context, imports) => {
      const sessionType = context.async ? 'AsyncSession' : 'Session'
      imports.from(context.async ? 'sqlalchemy.ext.asyncio' : 'sqlalchemy.orm', sessionType)
      return [`def __init__(self, session: ${sessionType}) -> None:`, '    self._session = session']
    },
    body: sqlBody,
  },
  unset: (target) => `${target} is None`,
  unitOfWork,
  conftest: conftestFile,
  databaseTest,
  databaseFixture: 'sql_uow: SqlUnitOfWork',
  dependencies,
  devDependencies,
  pytestOptions: (context) => [
    context.async && 'asyncio_mode = "auto"',
    context.async && 'asyncio_default_fixture_loop_scope = "function"',
  ],
  defaultUrl,
  layout: (context) => ['app/db.py              engine, sessions' + (writesEntities(context) ? ' and the declarative base' : '')],
}
