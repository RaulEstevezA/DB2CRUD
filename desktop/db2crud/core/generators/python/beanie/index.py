"""Beanie 2 on MongoDB as a Python ORM strategy (common/orm.py): the Beanie documents, repositories over them, the
transaction of each operation in a session, and tests on a database made empty for each one. Entities are plain
dataclasses, so services and in-memory repositories need no database (a Beanie document cannot be made without one);
nested documents are dictionaries with a type, inside the entity that holds them. Mirrors
web/src/core/generators/python/beanie/index.ts."""

from ...types import lines
from ..common.context import column_py_type, module_of, path_of, py_type, sql_repository_class
from ..common.documents import inner_first
from ..python import Imports, py_literal
from .models import models_file
from .repository import beanie_body, beanie_helpers

_VERSIONS = {
    "beanie": "beanie>=2.2,<3",
    "pydantic": "pydantic>=2.9,<3",
    "pytest": "pytest>=8.3,<9",
    "asyncio": "pytest-asyncio>=0.24,<2",
}

_URL = "mongodb://localhost:27017/app"


def _db_file() -> dict:
    imports = (
        Imports()
        .module("os")
        .from_("collections.abc", "Iterable")
        .from_("dataclasses", "dataclass")
        .from_("typing", "Any")
        .from_("beanie", "PydanticObjectId", "init_beanie")
        .from_("beanie.odm.utils.encoder", "Encoder")
        .from_("pydantic", "BaseModel", "ValidationError")
        .from_("pymongo", "AsyncMongoClient")
        .from_("pymongo.asynchronous.client_session", "AsyncClientSession")
        .from_("pymongo.errors", "OperationFailure")
        .from_("app.errors", "ConflictError", "FieldError", "ValidationFailedError")
        .from_("app.models", "DOCUMENTS")
    )
    return {
        "path": "app/db.py",
        "content": lines(
            '"""The MongoDB database DATABASE_URL names (see .env.example), through Beanie, and how values and errors are read."""',
            "",
            imports.write("app"),
            "",
            f'DATABASE_URL = os.environ.get("DATABASE_URL", {py_literal(_URL)})',
            "",
            "",
            "@dataclass",
            "class Db:",
            '    """The client of the database and, when there is one, the session whose transaction every query runs in."""',
            "",
            "    client: AsyncMongoClient[dict[str, Any]]",
            "    session: AsyncClientSession | None = None",
            "",
            "",
            "async def open_database(url: str = DATABASE_URL, create_indexes: bool = False) -> AsyncMongoClient[dict[str, Any]]:",
            '    """Opens the database at `url` for the documents; close the client when the application ends. It creates no collection and no index unless it is asked to: the database already exists."""',
            '    client: AsyncMongoClient[dict[str, Any]] = AsyncMongoClient(url, uuidRepresentation="standard", tz_aware=True)',
            "    await init_beanie(database=client.get_default_database(), document_models=DOCUMENTS, skip_indexes=not create_indexes)",
            "    return client",
            "",
            "",
            "def plain(value: Any) -> Any:",
            '    """A value of a document as the entities keep it: identifiers as text, documents as dictionaries with their stored names."""',
            "    if isinstance(value, BaseModel):",
            "        fields = type(value).model_fields",
            "        return {",
            "            (fields[name].alias if name in fields else None) or name: plain(item)",
            "            for name, item in BaseModel.__iter__(value)",
            "            if item is not None",
            "        }",
            "    if isinstance(value, list):",
            "        return [plain(item) for item in value]",
            "    return str(value) if isinstance(value, PydanticObjectId) else value",
            "",
            "",
            "def stored(document: BaseModel) -> dict[str, Any]:",
            '    """A document as the database keeps it: fields without a value are not there."""',
            "    values: dict[str, Any] = Encoder(to_db=True, keep_nulls=False).encode(document)",
            "    return values",
            "",
            "",
            "def changes(before: dict[str, Any], now: dict[str, Any], fields: Iterable[str]) -> dict[str, Any]:",
            '    """The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own."""',
            "    values: dict[str, Any] = {}",
            "    removed: dict[str, Any] = {}",
            "",
            "    def compare(path: str, old: Any, new: Any) -> None:",
            "        if old == new and type(old) is type(new):",
            "            return",
            "        if new is None:",
            '            removed[path] = ""',
            "        elif isinstance(old, dict) and isinstance(new, dict):",
            "            for name in {**old, **new}:",
            '                compare(f"{path}.{name}", old.get(name), new.get(name))',
            "        else:",
            "            values[path] = new",
            "",
            "    for field in fields:",
            "        compare(field, before.get(field), now.get(field))",
            '    return ({"$set": values} if values else {}) | ({"$unset": removed} if removed else {})',
            "",
            "",
            "REFUSALS = (OperationFailure, ValidationError)",
            '"""What a write fails with when the database, or the model of a document, does not take its values."""',
            "",
            "",
            "def refusal(entity: str, error: Exception) -> Exception:",
            '    """The domain error of a refused write: a repeated value, or values the model or the validator of the collection do not take."""',
            "    if isinstance(error, ValidationError):",
            '        problems = [FieldError(".".join(str(part) for part in item["loc"]), item["msg"]) for item in error.errors()]',
            "        return ValidationFailedError(entity, problems)",
            "    if isinstance(error, OperationFailure) and error.code in (11000, 121):",
            '        return ConflictError(entity, f"the database refused the change: {error}")',
            "    return error",
            "",
        ),
    }


def _type_block(nested: dict, imports: Imports) -> list:
    imports.from_("typing", "NotRequired", "TypedDict")

    def value(field: dict) -> str:
        column = field["column"]
        py = py_type(column["type"], imports, field["nested"]["name"] if field["nested"] else None)
        if column["nullable"] or column.get("default") or column["name"] == "_id":
            return f"NotRequired[{py} | None]"
        return py

    return [
        "",
        "",
        f"{nested['name']} = TypedDict(",
        f'    "{nested["name"]}",',
        "    {",
        *(f"        {py_literal(field['column']['name'])}: {value(field)}," for field in nested["fields"]),
        "    },",
        ")",
        '"""A document inside another, by the stored names of its fields."""',
    ]


def _entity_file(context: dict, info: dict) -> dict:
    imports = (
        Imports().hide([column["attr"] for column in info["columns"]]).annotations().from_("dataclasses", "dataclass")
    )
    # The types of its documents are of its own module
    fields = []
    types: list = []
    for column in info["columns"]:
        if column["nested"]:
            nested = column["nested"]["type"]
            py = f"{py_type(column['column']['type'], imports, nested['name'])} | None"
            for one in inner_first(nested):
                types += _type_block(one, imports)
        else:
            py = column_py_type(column, imports, True)
        fields.append(f"    {column['attr']}: {py} = None")
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    content = lines(
        f'"""Entity of the "{info["name"]}" collection{comment}."""',
        "",
        imports.write("app"),
        *types,
        "",
        "",
        "@dataclass(kw_only=True, eq=False)",
        f"class {info['entity']}:",
        f'    """A document of the "{info["name"]}" collection. An attribute stays None until it is set or read."""',
        "",
        *fields,
        "",
    )
    return {"path": path_of(module_of(context, info, "entity")), "content": content}


def _unit_of_work(context: dict, imports: Imports) -> list:
    (
        imports.from_("app.db", "Db")
        .from_("pymongo", "AsyncMongoClient")
        .from_("pymongo.asynchronous.client_session", "AsyncClientSession")
        .from_("typing", "Any")
    )
    mode = context["settings"]["transactions"]
    if mode == "operation":
        transaction = [
            '        """Runs what is inside it in a transaction, or in the one already open. MongoDB has transactions on replica sets only."""',
            "        if self.db.session is not None:",
            "            yield",
            "            return",
            "        async with self.db.client.start_session() as session, await session.start_transaction():",
            "            self.db.session = session",
            "            try:",
            "                yield",
            "            finally:",
            "                self.db.session = None",
        ]
    else:
        owner = (
            "The transaction belongs to whoever gave its session"
            if mode == "caller"
            else "Every write is stored at once"
        )
        transaction = [f'        """{owner}: this only groups the code."""', "        yield"]
    return [
        "class SqlUnitOfWork:",
        '    """The repositories over one client and, when there is one, the session whose transaction every query runs in. Make one per request."""',
        "",
        "    def __init__(self, client: AsyncMongoClient[dict[str, Any]], session: AsyncClientSession | None = None) -> None:",
        "        self.db = Db(client, session)",
        *(f"        self.{info['attr']} = {sql_repository_class(info)}(self.db)" for info in context["tables"]),
        "",
        "    @asynccontextmanager",
        "    async def transaction(self) -> AsyncIterator[None]:",
        *transaction,
    ]


def _conftest_file(context: dict) -> dict:
    memory = context["settings"]["memoryRepositories"]
    imports = (
        Imports()
        .module("os")
        .module("pytest")
        .module("pytest_asyncio")
        .from_("collections.abc", "AsyncIterator")
        .from_("app.db", "open_database")
        .from_("app.unit_of_work", "SqlUnitOfWork")
    )
    if memory:
        imports.from_("app.unit_of_work", "MemoryUnitOfWork")
    return {
        "path": "tests/conftest.py",
        "content": lines(
            '"""Fixtures of the tests: a database with its collections empty, and the units of work."""',
            "",
            imports.write("app"),
            "",
            "",
            "@pytest_asyncio.fixture",
            "async def sql_uow() -> AsyncIterator[SqlUnitOfWork]:",
            '    """The repositories over the MongoDB database TEST_DATABASE_URL names, empty and with the indexes of its documents."""',
            '    url = os.environ.get("TEST_DATABASE_URL")',
            "    if not url:",
            '        pytest.fail("The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)")',
            "    client = await open_database(url)",
            "    await client.drop_database(client.get_default_database().name)",
            "    await client.close()",
            "    client = await open_database(url, create_indexes=True)",
            "    yield SqlUnitOfWork(client)",
            "    await client.close()",
            memory
            and [
                "",
                "",
                "@pytest.fixture",
                "def memory_uow() -> MemoryUnitOfWork:",
                '    """The in-memory repositories."""',
                "    return MemoryUnitOfWork()",
            ],
            "",
        ),
    }


def _database_test(_context: dict) -> dict:
    """Fails when the tests do not run on the database TEST_DATABASE_URL names, so a green run proves which one it
    was."""
    imports = (
        Imports()
        .module("os")
        .from_("urllib.parse", "urlparse")
        .from_("app.models", "DOCUMENTS")
        .from_("app.unit_of_work", "SqlUnitOfWork")
    )
    return {
        "path": "tests/test_database.py",
        "content": lines(
            '"""The tests run on the database they were asked to."""',
            "",
            imports.write("app"),
            "",
            "",
            "async def test_runs_on_the_database_asked(sql_uow: SqlUnitOfWork) -> None:",
            '    name = urlparse(os.environ["TEST_DATABASE_URL"]).path.removeprefix("/")',
            "    assert {document.get_pymongo_collection().database.name for document in DOCUMENTS} == {name}",
            "",
        ),
    }


def _doc(context: dict, info: dict) -> str:
    how = (
        "Every write is stored at once."
        if context["settings"]["transactions"] == "repository"
        else "Queries run in the session of the unit of work, when there is one."
    )
    return f"Keeps {info['name']} documents in the database, through Beanie. {how}"


def _init(_context: dict, imports: Imports) -> list:
    imports.from_("app.db", "Db")
    return ["def __init__(self, db: Db) -> None:", "    self._db = db"]


BEANIE_ORM = {
    "id": "beanie",
    "label": "Beanie 2",
    "documents": True,
    "ownModels": True,
    "prefix": "Mongo",
    "databaseFiles": lambda context: [
        _db_file(),
        models_file(context),
        *(_entity_file(context, info) for info in context["tables"] if info["writesEntity"]),
    ],
    "repository": {"doc": _doc, "init": _init, "body": beanie_body, "helpers": beanie_helpers},
    "unset": lambda target, _imports: f"{target} is None",
    "unitOfWork": _unit_of_work,
    "conftest": _conftest_file,
    "databaseTest": _database_test,
    "databaseFixture": "sql_uow: SqlUnitOfWork",
    "dependencies": lambda _context: [_VERSIONS["beanie"], _VERSIONS["pydantic"]],
    "devDependencies": lambda _context: [_VERSIONS["pytest"], _VERSIONS["asyncio"]],
    "pytestOptions": lambda _context: ['asyncio_mode = "auto"'],
    "defaultUrl": lambda _context: _URL,
    "layout": lambda _context: [
        "app/db.py              the database, how values and errors are read, and what changed in a document",
        "app/models.py          the Beanie documents, as the database has them",
        "app/documents.py       the rules of the documents inside others",
    ],
}
