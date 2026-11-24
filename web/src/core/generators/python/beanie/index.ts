/**
 * Beanie 2 on MongoDB as a Python ORM strategy (common/orm.ts): the Beanie documents, repositories over them, the
 * transaction of each operation in a session, and tests on a database made empty for each one. Entities are plain
 * dataclasses, so services and in-memory repositories need no database (a Beanie document cannot be made without one);
 * nested documents are dictionaries with a type, inside the entity that holds them.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines, type Line } from '../../types.ts'
import { Imports, pyLiteral } from '../python.ts'
import { columnPyType, moduleOf, pathOf, pyType, sqlRepositoryClass, type Context, type TableInfo } from '../common/context.ts'
import { innerFirst, type NestedType } from '../common/documents.ts'
import type { PythonOrm } from '../common/orm.ts'
import { modelsFile } from './models.ts'
import { beanieBody, beanieHelpers } from './repository.ts'

const VERSIONS = {
  beanie: 'beanie>=2.2,<3',
  pydantic: 'pydantic>=2.9,<3',
  pytest: 'pytest>=8.3,<9',
  asyncio: 'pytest-asyncio>=0.24,<2',
}

const URL = 'mongodb://localhost:27017/app'

function dbFile(): GeneratedFile {
  const imports = new Imports()
    .module('os')
    .from('collections.abc', 'Iterable')
    .from('dataclasses', 'dataclass')
    .from('typing', 'Any')
    .from('beanie', 'PydanticObjectId', 'init_beanie')
    .from('beanie.odm.utils.encoder', 'Encoder')
    .from('pydantic', 'BaseModel', 'ValidationError')
    .from('pymongo', 'AsyncMongoClient')
    .from('pymongo.asynchronous.client_session', 'AsyncClientSession')
    .from('pymongo.errors', 'OperationFailure')
    .from('app.errors', 'ConflictError', 'FieldError', 'ValidationFailedError')
    .from('app.models', 'DOCUMENTS')
  return {
    path: 'app/db.py',
    content: lines(
      '"""The MongoDB database DATABASE_URL names (see .env.example), through Beanie, and how values and errors are read."""',
      '',
      imports.write('app'),
      '',
      `DATABASE_URL = os.environ.get("DATABASE_URL", ${pyLiteral(URL)})`,
      '',
      '',
      '@dataclass',
      'class Db:',
      '    """The client of the database and, when there is one, the session whose transaction every query runs in."""',
      '',
      '    client: AsyncMongoClient[dict[str, Any]]',
      '    session: AsyncClientSession | None = None',
      '',
      '',
      'async def open_database(url: str = DATABASE_URL, create_indexes: bool = False) -> AsyncMongoClient[dict[str, Any]]:',
      '    """Opens the database at `url` for the documents; close the client when the application ends. It creates no collection and no index unless it is asked to: the database already exists."""',
      '    client: AsyncMongoClient[dict[str, Any]] = AsyncMongoClient(url, uuidRepresentation="standard", tz_aware=True)',
      '    await init_beanie(database=client.get_default_database(), document_models=DOCUMENTS, skip_indexes=not create_indexes)',
      '    return client',
      '',
      '',
      'def plain(value: Any) -> Any:',
      '    """A value of a document as the entities keep it: identifiers as text, documents as dictionaries with their stored names."""',
      '    if isinstance(value, BaseModel):',
      '        fields = type(value).model_fields',
      '        return {',
      '            (fields[name].alias if name in fields else None) or name: plain(item)',
      '            for name, item in BaseModel.__iter__(value)',
      '            if item is not None',
      '        }',
      '    if isinstance(value, list):',
      '        return [plain(item) for item in value]',
      '    return str(value) if isinstance(value, PydanticObjectId) else value',
      '',
      '',
      'def stored(document: BaseModel) -> dict[str, Any]:',
      '    """A document as the database keeps it: fields without a value are not there."""',
      '    values: dict[str, Any] = Encoder(to_db=True, keep_nulls=False).encode(document)',
      '    return values',
      '',
      '',
      'def changes(before: dict[str, Any], now: dict[str, Any], fields: Iterable[str]) -> dict[str, Any]:',
      '    """The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own."""',
      '    values: dict[str, Any] = {}',
      '    removed: dict[str, Any] = {}',
      '',
      '    def compare(path: str, old: Any, new: Any) -> None:',
      '        if old == new and type(old) is type(new):',
      '            return',
      '        if new is None:',
      '            removed[path] = ""',
      '        elif isinstance(old, dict) and isinstance(new, dict):',
      '            for name in {**old, **new}:',
      '                compare(f"{path}.{name}", old.get(name), new.get(name))',
      '        else:',
      '            values[path] = new',
      '',
      '    for field in fields:',
      '        compare(field, before.get(field), now.get(field))',
      '    return ({"$set": values} if values else {}) | ({"$unset": removed} if removed else {})',
      '',
      '',
      'REFUSALS = (OperationFailure, ValidationError)',
      '"""What a write fails with when the database, or the model of a document, does not take its values."""',
      '',
      '',
      'def refusal(entity: str, error: Exception) -> Exception:',
      '    """The domain error of a refused write: a repeated value, or values the model or the validator of the collection do not take."""',
      '    if isinstance(error, ValidationError):',
      '        problems = [FieldError(".".join(str(part) for part in item["loc"]), item["msg"]) for item in error.errors()]',
      '        return ValidationFailedError(entity, problems)',
      '    if isinstance(error, OperationFailure) and error.code in (11000, 121):',
      '        return ConflictError(entity, f"the database refused the change: {error}")',
      '    return error',
      '',
    ),
  }
}

function typeBlock(type: NestedType, imports: Imports): Line[] {
  const value = ({ column, nested }: NestedType['fields'][number]) => {
    const py = `${pyType(column.type, imports, nested?.name)}`
    return column.nullable || column.default || column.name === '_id' ? `NotRequired[${py} | None]` : py
  }
  imports.from('typing', 'NotRequired', 'TypedDict')
  return [
    '',
    '',
    `${type.name} = TypedDict(`,
    `    "${type.name}",`,
    '    {',
    ...type.fields.map((field) => `        ${pyLiteral(field.column.name)}: ${value(field)},`),
    '    },',
    ')',
    '"""A document inside another, by the stored names of its fields."""',
  ]
}

function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const module = moduleOf(context, info, 'entity')
  const imports = new Imports()
    .hide(info.columns.map((column) => column.attr))
    .annotations()
    .from('dataclasses', 'dataclass')
  // The types of its documents are of its own module
  const fields = info.columns.map((column) => {
    const own = { ...column, nested: null }
    const type = column.nested ? `${pyType(column.column.type, imports, column.nested.type.name)} | None` : columnPyType(own, imports, true)
    return `    ${column.attr}: ${type} = None`
  })
  const types = info.columns.flatMap((column) =>
    column.nested ? innerFirst(column.nested.type).flatMap((type) => typeBlock(type, imports)) : [],
  )
  const content = lines(
    `"""Entity of the "${info.name}" collection${info.table.comment ? `: ${info.table.comment}` : ''}."""`,
    '',
    imports.write('app'),
    ...types,
    '',
    '',
    '@dataclass(kw_only=True, eq=False)',
    `class ${info.entity}:`,
    `    """A document of the "${info.name}" collection. An attribute stays None until it is set or read."""`,
    '',
    ...fields,
    '',
  )
  return { path: pathOf(module), content }
}

function unitOfWork(context: Context, imports: Imports): Line[] {
  imports
    .from('app.db', 'Db')
    .from('pymongo', 'AsyncMongoClient')
    .from('pymongo.asynchronous.client_session', 'AsyncClientSession')
    .from('typing', 'Any')
  const mode = context.settings.transactions
  return [
    'class SqlUnitOfWork:',
    '    """The repositories over one client and, when there is one, the session whose transaction every query runs in. Make one per request."""',
    '',
    '    def __init__(self, client: AsyncMongoClient[dict[str, Any]], session: AsyncClientSession | None = None) -> None:',
    '        self.db = Db(client, session)',
    ...context.tables.map((info) => `        self.${info.attr} = ${sqlRepositoryClass(info)}(self.db)`),
    '',
    '    @asynccontextmanager',
    '    async def transaction(self) -> AsyncIterator[None]:',
    ...(mode === 'operation'
      ? [
          '        """Runs what is inside it in a transaction, or in the one already open. MongoDB has transactions on replica sets only."""',
          '        if self.db.session is not None:',
          '            yield',
          '            return',
          '        async with self.db.client.start_session() as session, await session.start_transaction():',
          '            self.db.session = session',
          '            try:',
          '                yield',
          '            finally:',
          '                self.db.session = None',
        ]
      : [
          `        """${mode === 'caller' ? 'The transaction belongs to whoever gave its session' : 'Every write is stored at once'}: this only groups the code."""`,
          '        yield',
        ]),
  ]
}

function conftestFile(context: Context): GeneratedFile {
  const imports = new Imports()
    .module('os')
    .module('pytest')
    .module('pytest_asyncio')
    .from('collections.abc', 'AsyncIterator')
    .from('app.db', 'open_database')
    .from('app.unit_of_work', 'SqlUnitOfWork')
  if (context.settings.memoryRepositories) imports.from('app.unit_of_work', 'MemoryUnitOfWork')
  return {
    path: 'tests/conftest.py',
    content: lines(
      '"""Fixtures of the tests: a database with its collections empty, and the units of work."""',
      '',
      imports.write('app'),
      '',
      '',
      '@pytest_asyncio.fixture',
      'async def sql_uow() -> AsyncIterator[SqlUnitOfWork]:',
      '    """The repositories over the MongoDB database TEST_DATABASE_URL names, empty and with the indexes of its documents."""',
      '    url = os.environ.get("TEST_DATABASE_URL")',
      '    if not url:',
      '        pytest.fail("The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)")',
      '    client = await open_database(url)',
      '    await client.drop_database(client.get_default_database().name)',
      '    await client.close()',
      '    client = await open_database(url, create_indexes=True)',
      '    yield SqlUnitOfWork(client)',
      '    await client.close()',
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

/** Fails when the tests do not run on the database TEST_DATABASE_URL names, so a green run proves which one it was. */
function databaseTest(): GeneratedFile {
  return {
    path: 'tests/test_database.py',
    content: lines(
      '"""The tests run on the database they were asked to."""',
      '',
      new Imports()
        .module('os')
        .from('urllib.parse', 'urlparse')
        .from('app.models', 'DOCUMENTS')
        .from('app.unit_of_work', 'SqlUnitOfWork')
        .write('app'),
      '',
      '',
      'async def test_runs_on_the_database_asked(sql_uow: SqlUnitOfWork) -> None:',
      '    name = urlparse(os.environ["TEST_DATABASE_URL"]).path.removeprefix("/")',
      '    assert {document.get_pymongo_collection().database.name for document in DOCUMENTS} == {name}',
      '',
    ),
  }
}

export const beanieOrm: PythonOrm = {
  id: 'beanie',
  label: 'Beanie 2',
  documents: true,
  ownModels: true,
  prefix: 'Mongo',
  databaseFiles: (context) => [
    dbFile(),
    modelsFile(context),
    ...context.tables.filter((info) => info.writesEntity).map((info) => entityFile(context, info)),
  ],
  repository: {
    doc: (context, info) =>
      `Keeps ${info.name} documents in the database, through Beanie.${context.settings.transactions === 'repository' ? ' Every write is stored at once.' : ' Queries run in the session of the unit of work, when there is one.'}`,
    init: (_context, imports) => {
      imports.from('app.db', 'Db')
      return ['def __init__(self, db: Db) -> None:', '    self._db = db']
    },
    body: beanieBody,
    helpers: beanieHelpers,
  },
  unset: (target) => `${target} is None`,
  unitOfWork,
  conftest: conftestFile,
  databaseTest,
  databaseFixture: 'sql_uow: SqlUnitOfWork',
  dependencies: () => [VERSIONS.beanie, VERSIONS.pydantic],
  devDependencies: () => [VERSIONS.pytest, VERSIONS.asyncio],
  pytestOptions: () => ['asyncio_mode = "auto"'],
  defaultUrl: () => URL,
  layout: () => [
    'app/db.py              the database, how values and errors are read, and what changed in a document',
    'app/models.py          the Beanie documents, as the database has them',
    'app/documents.py       the rules of the documents inside others',
  ],
}
