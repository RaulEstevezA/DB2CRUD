/**
 * Python + Django 5.2 ORM (Strategy of common/orm.ts): settings with the database from DATABASE_URL, a model per
 * table faithful to the database, repositories on the model managers, a unit of work whose transactions are
 * `transaction.atomic`, and tests with pytest-django on a test database created from the models. Synchronous
 * only: Django's asynchronous ORM cannot hold a transaction.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { Imports } from '../python.ts'
import { sqlRepositoryClass, writesEntities, type Context, type TableInfo } from '../common/context.ts'
import type { PythonOrm, RepositoryMethod } from '../common/orm.ts'
import { databaseFiles, defaultUrl } from './database.ts'

const VERSIONS = {
  django: 'django>=5.2,<5.3',
  psycopg: 'psycopg[binary]>=3.2,<4',
  pymysql: 'pymysql>=1.1,<2',
  cryptography: 'cryptography>=43',
  pydantic: 'pydantic>=2.9,<3',
  pytest: 'pytest>=8.3,<9',
  pytestDjango: 'pytest-django>=4.9,<5',
}

function dependencies(context: Context): string[] {
  const { database, serviceTypes, dtoKind } = context.settings
  const deps = [VERSIONS.django]
  if (database === 'postgresql') deps.push(VERSIONS.psycopg)
  if (database === 'mysql' || database === 'mariadb') deps.push(VERSIONS.pymysql, VERSIONS.cryptography)
  if (serviceTypes === 'dtos' && dtoKind === 'pydantic') deps.push(VERSIONS.pydantic)
  return deps
}

// Repositories

/** The lookups that leave out rows marked as deleted. */
function softLookup(info: TableInfo): string | null {
  if (!info.soft) return null
  return info.soft.column.type.kind === 'boolean' ? `${info.soft.attr}=False` : `${info.soft.attr}__isnull=True`
}

const keyOrder = (info: TableInfo) => info.key.map((column) => JSON.stringify(column.attr)).join(', ')

function filter(info: TableInfo, lookups: string[]): string {
  const all = [...lookups, softLookup(info)].filter((item): item is string => item !== null)
  return all.length > 0 ? `.filter(${all.join(', ')})` : '.all()'
}

/** Rows after a key, in key order: `a > x OR (a = x AND b > y)`. */
function after(info: TableInfo): string {
  const keys = info.key.map((column) => column.attr)
  const terms = keys.map((key, index) => {
    const equal = keys.slice(0, index).map((previous, position) => `${previous}=after[${position}]`)
    return `Q(${[...equal, `${key}__gt=after[${index}]`].join(', ')})`
  })
  return terms.join(' | ')
}

function body(context: Context, info: TableInfo, method: RepositoryMethod, imports: Imports): Line[] {
  const entity = info.entity
  const equals = method.params.map((param) => `${param.name}=${param.name}`)
  const objects = `${entity}.objects`
  const write = (action: string, refresh: boolean): Line[] => {
    imports.from('django.db', 'IntegrityError', 'transaction').from('app.errors', 'ConflictError')
    return [
      'try:',
      '    with transaction.atomic():',
      `        ${action}`,
      'except IntegrityError as error:',
      `    raise ConflictError("${entity}", "the database refused the change: " + str(error)) from error`,
      // Values the database fills (db_default) are read back, so a later read gives the same row
      refresh && 'entity.refresh_from_db()',
    ]
  }
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return ${objects}${filter(info, equals)}.first()`]
    case 'listByParent':
    case 'findAllBy':
      return [`return list(${objects}${filter(info, equals)}.order_by(${keyOrder(info)}))`]
    case 'list': {
      const base = `query = ${objects}${filter(info, [])}.order_by(${keyOrder(info)})`
      if (context.settings.paging === 'offset')
        return [
          base,
          'total = query.count()',
          'return Page(items=list(query[offset : offset + limit]), total=total, offset=offset, limit=limit)',
        ]
      if (context.settings.paging === 'cursor') {
        imports.from('django.db.models', 'Q')
        return [
          base,
          'if after is not None:',
          `    query = query.filter(${after(info)})`,
          'rows = list(query[: limit + 1])',
          'more = len(rows) > limit',
          'rows = rows[:limit]',
          `last = (${info.key.map((column) => `rows[-1].${column.attr}`).join(', ')},) if more else None`,
          'return CursorPage(items=rows, next=last)',
        ]
      }
      return [base, 'return list(query)']
    }
    case 'insert':
      return [...write('entity.save(force_insert=True)', true), 'return entity']
    case 'update':
      return [...write('entity.save()', true), 'return entity']
    case 'delete':
      return write('entity.delete()', false)
    default:
      return ['raise NotImplementedError']
  }
}

// Unit of work

function unitOfWork(context: Context, imports: Imports): Line[] {
  imports.from('contextlib', 'contextmanager').from('collections.abc', 'Iterator')
  const operation = context.settings.transactions === 'operation'
  if (operation) imports.from('django.db', 'transaction')
  return [
    'class SqlUnitOfWork:',
    '    """The repositories over the Django database connection."""',
    '',
    '    def __init__(self) -> None:',
    ...context.tables.map((info) => `        self.${info.attr} = ${sqlRepositoryClass(info)}()`),
    '',
    '    @contextmanager',
    '    def transaction(self) -> Iterator[None]:',
    ...(operation
      ? [
          '        """Commits what runs inside it, or rolls it back if it fails (transaction.atomic)."""',
          '        with transaction.atomic():',
          '            yield',
        ]
      : ['        """Groups the code: the transaction belongs to whoever calls the services, or to each write."""', '        yield']),
  ]
}

// Tests

function conftest(context: Context): GeneratedFile {
  const imports = new Imports().module('pytest').from('app.unit_of_work', 'SqlUnitOfWork')
  if (context.settings.memoryRepositories) imports.from('app.unit_of_work', 'MemoryUnitOfWork')
  return {
    path: 'tests/conftest.py',
    content: lines(
      '"""Fixtures of the tests: the test database pytest-django creates from the models, and the units of work."""',
      '',
      imports.write('app'),
      '',
      '',
      '@pytest.fixture',
      'def sql_uow(db) -> SqlUnitOfWork:  # type: ignore[no-untyped-def]',
      '    """The repositories over the test database; every test runs in a transaction rolled back after it."""',
      '    return SqlUnitOfWork()',
      context.settings.memoryRepositories && [
        '',
        '',
        '@pytest.fixture',
        'def memory_uow() -> MemoryUnitOfWork:',
        '    """The in-memory repositories."""',
        '    return MemoryUnitOfWork()',
      ],
      '',
    ),
  }
}

/** The settings of the tests: the project's, on TEST_DATABASE_URL or SQLite in memory. */
function testSettings(): GeneratedFile {
  return {
    path: 'tests/settings.py',
    content: lines(
      '"""Settings of the tests: the project\'s, on TEST_DATABASE_URL, or SQLite in memory (pytest-django creates the',
      'test database from the models and empties it)."""',
      '',
      'import os',
      '',
      'from app.settings import *  # noqa: F403',
      'from app.settings import database_from_url',
      '',
      'DATABASES = {"default": database_from_url(os.environ.get("TEST_DATABASE_URL") or "sqlite://:memory:")}',
      '',
    ),
  }
}

function databaseTest(): GeneratedFile {
  return {
    path: 'tests/test_database.py',
    content: lines(
      '"""The tests run on the database they were asked to."""',
      '',
      'import os',
      '',
      'from django.db import connection',
      '',
      '',
      'def test_runs_on_the_database_asked(db) -> None:  # type: ignore[no-untyped-def]',
      '    url = os.environ.get("TEST_DATABASE_URL")',
      '    expected = url.split(":", 1)[0].split("+", 1)[0] if url else "sqlite"',
      '    # Django runs MariaDB with its MySQL backend',
      '    assert connection.vendor == ("mysql" if expected == "mariadb" else expected)',
      '',
    ),
  }
}

export const djangoOrm: PythonOrm = {
  id: 'django',
  label: 'the Django 5.2 ORM',
  databaseFiles,
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} rows in the database, through the ${info.entity} model.${context.settings.transactions === 'operation' ? ' Its writes join the transaction of the operation.' : ''}`,
    init: () => [],
    body,
  },
  unset: (target, imports) => {
    // A field with db_default holds a DatabaseDefault until the row is stored
    imports.from('django.db.models.expressions', 'DatabaseDefault')
    return `${target} is None or isinstance(${target}, DatabaseDefault)`
  },
  unitOfWork,
  conftest: (context) => conftest(context),
  databaseTest: () => databaseTest(),
  extraTestFiles: () => [testSettings()],
  databaseFixture: 'sql_uow: SqlUnitOfWork',
  dependencies,
  devDependencies: () => [VERSIONS.pytest, VERSIONS.pytestDjango],
  pytestOptions: () => ['DJANGO_SETTINGS_MODULE = "tests.settings"'],
  defaultUrl,
  layout: (context) =>
    [
      'app/settings.py        Django settings: the database comes from DATABASE_URL',
      writesEntities(context) && "app/models.py          imports every entity, for Django's app registry",
    ].filter((line): line is string => typeof line === 'string'),
}
