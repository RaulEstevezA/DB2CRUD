/**
 * The fixtures of a SQLAlchemy project's tests: an engine on TEST_DATABASE_URL (SQLite in a temporary file
 * otherwise) with the tables created from the entities, a unit of work over a session, the in-memory one; and
 * the test that proves which database they ran on.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { Imports } from '../python.ts'
import { moduleOf, type Context } from '../common/context.ts'

const def = (context: Context) => (context.async ? 'async def' : 'def')

export function conftestFile(context: Context): GeneratedFile {
  const imports = new Imports().module('os').module('pytest')
  imports.from('app.db', 'Base', 'create_db_engine', 'create_session_factory').from('app.unit_of_work', 'SqlUnitOfWork')
  if (context.settings.memoryRepositories) imports.from('app.unit_of_work', 'MemoryUnitOfWork')
  for (const info of context.tables) if (info.writesEntity) imports.from(moduleOf(context, info, 'entity'), info.entity)
  const async = context.async
  if (async) imports.module('pytest_asyncio').from('collections.abc', 'AsyncIterator')
  else imports.from('collections.abc', 'Iterator')
  const fixture = async ? '@pytest_asyncio.fixture' : '@pytest.fixture'
  const content = lines(
    '"""Fixtures of the tests: a database created from the entities, and the units of work."""',
    '',
    imports.write('app'),
    '',
    '# Every entity is imported above, so the metadata knows every table',
    '',
    '',
    fixture,
    async ? 'async def engine(tmp_path):  # type: ignore[no-untyped-def]' : 'def engine(tmp_path):  # type: ignore[no-untyped-def]',
    '    """The test database, empty: TEST_DATABASE_URL, or SQLite in a temporary file."""',
    '    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / \'test.db\'}"',
    '    engine = create_db_engine(url)',
    async
      ? [
          '    async with engine.begin() as connection:',
          '        await connection.run_sync(Base.metadata.drop_all)',
          '        await connection.run_sync(Base.metadata.create_all)',
          '    yield engine',
          '    async with engine.begin() as connection:',
          '        await connection.run_sync(Base.metadata.drop_all)',
          '    await engine.dispose()',
        ]
      : [
          '    Base.metadata.drop_all(engine)',
          '    Base.metadata.create_all(engine)',
          '    yield engine',
          '    Base.metadata.drop_all(engine)',
          '    engine.dispose()',
        ],
    '',
    '',
    fixture,
    async
      ? 'async def sql_uow(engine) -> AsyncIterator[SqlUnitOfWork]:  # type: ignore[no-untyped-def]'
      : 'def sql_uow(engine) -> Iterator[SqlUnitOfWork]:  # type: ignore[no-untyped-def]',
    '    """The repositories over a session of the test database."""',
    async
      ? ['    async with create_session_factory(engine)() as session:', '        yield SqlUnitOfWork(session)']
      : ['    with create_session_factory(engine)() as session:', '        yield SqlUnitOfWork(session)'],
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
export function databaseTest(context: Context): GeneratedFile {
  return {
    path: 'tests/test_database.py',
    content: lines(
      '"""The tests run on the database they were asked to."""',
      '',
      'import os',
      '',
      '',
      `${def(context)} test_runs_on_the_database_asked(engine) -> None:  # type: ignore[no-untyped-def]`,
      '    url = os.environ.get("TEST_DATABASE_URL")',
      '    expected = url.split(":", 1)[0].split("+", 1)[0] if url else "sqlite"',
      '    assert engine.dialect.name == expected',
      '',
    ),
  }
}
