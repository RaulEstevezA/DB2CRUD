"""Python without an ORM (Strategy of common/orm.py): repositories that write their SQL, through each database's
driver (psycopg 3, MySQL Connector/Python, sqlite3), over one connection; plain dataclasses as entities; a unit of work
that commits or rolls back the connection; and tests on a real database created from the schema's DDL. Synchronous:
the drivers are. Mirrors web/src/core/generators/python/sql/index.ts."""

import re

from ....schema.ddl import create_statements, drop_statements, quote_name, table_name
from ...types import lines
from ..common.context import sql_repository_class
from ..python import Imports, js_json, py_literal
from .database import database_files, default_url, driver_label, mark, reader_of

_VERSIONS = {
    "psycopg": "psycopg[binary]>=3.2,<4",
    "mysql": "mysql-connector-python>=9.1,<10",
    "pydantic": "pydantic>=2.9,<3",
    "pytest": "pytest>=8.3,<9",
}


def _sql(text: str) -> str:
    """A Python string of SQL: between single quotes, so the double quotes of names read as they are."""
    return py_literal(text) if re.search(r"['\\\n]", text) else f"'{text}'"


def _q(context: dict, name: str) -> str:
    return quote_name(context["settings"]["database"], name)


def _table(context: dict, info: dict) -> str:
    return table_name(context["settings"]["database"], info["table"])


def _writable(column: dict) -> bool:
    """A computed column is never written."""
    return not isinstance(column["column"].get("generated"), dict)


def _changeable(info: dict, column: dict) -> bool:
    """Neither the key of a stored row, nor what the database fills on change."""
    return (
        _writable(column)
        and not any(column is key for key in info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    )


def _returns(context: dict) -> bool:
    return context["settings"]["database"] not in ("mysql", "mariadb")


def _select_list(context: dict, info: dict) -> str:
    """`"id", "name"`: the columns every read selects, in the order `_entity` takes them."""
    return ", ".join(_q(context, column["column"]["name"]) for column in info["columns"])


def _soft_condition(context: dict, info: dict) -> str | None:
    """The condition that leaves out rows marked as deleted."""
    soft = info.get("soft")
    if not soft:
        return None
    column = _q(context, soft["column"]["name"])
    return f"{column} = FALSE" if soft["column"]["type"]["kind"] == "boolean" else f"{column} IS NULL"


def _where(conditions: list[str | None]) -> str:
    present = [item for item in conditions if item is not None]
    return f" WHERE {' AND '.join(present)}" if present else ""


def _equals(context: dict, columns: list[dict]) -> list[str]:
    return [f"{_q(context, column['column']['name'])} = {mark(context)}" for column in columns]


def _order_by(context: dict, info: dict) -> str:
    return f" ORDER BY {', '.join(_q(context, column['column']['name']) for column in info['key'])}"


def _params(values: list[str]) -> str:
    return "()" if not values else f"({', '.join(values)},)"


def _to_db(expression: str) -> str:
    return f"to_db({expression})"


def _is_array(context: dict, column: dict) -> bool:
    """psycopg writes a list as an array of PostgreSQL by itself: to_db would make it JSON."""
    return context["settings"]["database"] == "postgresql" and column["column"]["type"]["kind"] == "array"


def _key_params(info: dict, target: str = "entity") -> str:
    """The key of the entity as the parameters of a query."""
    return _params([_to_db(f"{target}.{column['attr']}") for column in info["key"]])


def _helpers(context: dict, info: dict, imports: Imports) -> list:
    """The module-level helpers of a repository: the columns it selects and the entity of a row."""
    values = []
    for index, column in enumerate(info["columns"]):
        reader = reader_of(context, column["column"]["type"]["kind"])
        if reader:
            imports.from_("app.db", reader)
        value = f"{reader}(row[{index}])" if reader else f"row[{index}]"
        values.append(f"        {column['attr']}={value},")
    imports.from_("typing", "Any")
    return [
        "",
        "",
        f"_COLUMNS = {_sql(_select_list(context, info))}",
        "",
        "",
        f"def _entity(row: tuple[Any, ...]) -> {info['entity']}:",
        f'    """The {info["entity"]} of a row read with _COLUMNS."""',
        f"    return {info['entity']}(",
        *values,
        "    )",
    ]


def _write(context: dict, info: dict, action: list, imports: Imports, after: list | None = None) -> list:
    """A write, with a refusal of the database turned into a ConflictError (and committed when every write is its
    own)."""
    imports.from_("app.db", "IntegrityError").from_("app.errors", "ConflictError")
    return [
        "try:",
        *[f"    {line}" if isinstance(line, str) else line for line in action],
        "except IntegrityError as error:",
        "    self._connection.rollback()",
        f'    raise ConflictError("{info["entity"]}", "the database refused the change: " + str(error)) from error',
        context["settings"]["transactions"] == "repository" and "self._connection.commit()",
        *(after or []),
    ]


def _read_back(context: dict, info: dict, target: str) -> list:
    """Reads a stored row again by its key, without the soft-delete filter."""
    where = _sql(f" FROM {_table(context, info)}{_where(_equals(context, info['key']))}")
    return [
        f"row = fetch_one(self._connection, 'SELECT ' + _COLUMNS + {where}, {_key_params(info, target)})",
        "if row is None:",
        f'    raise LookupError("The {info["entity"]} just written is not there")',
        "return _entity(row)",
    ]


def _body(context: dict, info: dict, method: dict, imports: Imports) -> list:
    imports.from_("app.db", "fetch_one", "fetch_all", "execute", "to_db")
    source = f" FROM {_table(context, info)}"

    def select(rest: str) -> str:
        return f"'SELECT ' + _COLUMNS + {_sql(f'{source}{rest}')}"

    by_columns = [
        next(column for column in info["columns"] if column["column"]["name"] == name)
        for name in method["query"]["columns"]
    ]
    by_params = _params([_to_db(column["attr"]) for column in by_columns])
    soft = _soft_condition(context, info)
    m = mark(context)
    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        return [
            f"row = fetch_one(self._connection, {select(_where([*_equals(context, by_columns), soft]))}, {by_params})",
            "return _entity(row) if row is not None else None",
        ]
    if kind in ("listByParent", "findAllBy"):
        rest = f"{_where([*_equals(context, by_columns), soft])}{_order_by(context, info)}"
        return [
            f"rows = fetch_all(self._connection, {select(rest)}, {by_params})",
            "return [_entity(row) for row in rows]",
        ]
    if kind == "list":
        where = _where([soft])
        paging = context["settings"]["paging"]
        if paging == "offset":
            return [
                f"rows = fetch_all(self._connection, {select(f'{where}{_order_by(context, info)} LIMIT {m} OFFSET {m}')}"
                ", (limit, offset))",
                f"counted = fetch_one(self._connection, {_sql(f'SELECT COUNT(*){source}{where}')})",
                "total = int(counted[0]) if counted is not None else 0",
                "return Page(items=[_entity(row) for row in rows], total=total, offset=offset, limit=limit)",
            ]
        if paging == "cursor":
            key = [_q(context, column["column"]["name"]) for column in info["key"]]
            after = f"{key[0]} > {m}" if len(key) == 1 else f"({', '.join(key)}) > ({', '.join(m for _ in key)})"
            last = ", ".join(f"items[-1].{column['attr']}" for column in info["key"])
            return [
                f"condition = {_sql(_where([soft, after]))} if after is not None else {_sql(where)}",
                "values = tuple(to_db(value) for value in after) if after is not None else ()",
                f"rows = fetch_all(self._connection, 'SELECT ' + _COLUMNS + {_sql(source)} + condition + "
                f"{_sql(f'{_order_by(context, info)} LIMIT {m}')}, (*values, limit + 1))",
                "items = [_entity(row) for row in rows[:limit]]",
                f"last = ({last},) if len(rows) > limit else None",
                "return CursorPage(items=items, next=last)",
            ]
        return [
            f"rows = fetch_all(self._connection, {select(f'{where}{_order_by(context, info)}')})",
            "return [_entity(row) for row in rows]",
        ]
    if kind == "insert":
        columns = [column for column in info["columns"] if _writable(column)]
        uuids = [column for column in columns if column["column"].get("generated") == "uuid"]
        if uuids:
            imports.from_("uuid", "uuid4")
        identity = (
            info["key"][0]
            if len(info["key"]) == 1 and info["key"][0]["column"].get("generated") == "identity"
            else None
        )
        # Values left None take the database's default
        prepare = [
            *[
                line
                for column in uuids
                for line in (f"if entity.{column['attr']} is None:", f"    entity.{column['attr']} = uuid4()")
            ],
            "given = [",
            *(f"    ({_sql(_q(context, column['column']['name']))}, entity.{column['attr']})," for column in columns),
            "]",
            "given = [(column, value) for column, value in given if value is not None]",
            'names = ", ".join(column for column, _ in given)',
            f'marks = ", ".join({_sql(m)} for _ in given)',
        ]
        arrays = [_sql(_q(context, column["column"]["name"])) for column in columns if _is_array(context, column)]
        values = (
            f"tuple(value if column in {_params(arrays)} else to_db(value) for column, value in given)"
            if arrays
            else "tuple(to_db(value) for _, value in given)"
        )
        into = f"INSERT INTO {_table(context, info)}"
        if _returns(context):
            defaults = f"{into} DEFAULT VALUES RETURNING "
            return _write(
                context,
                info,
                [
                    *prepare,
                    "sql = (",
                    f"    f{_sql(f'{into} ({{names}}) VALUES ({{marks}}) RETURNING ')} if given else {_sql(defaults)}",
                    ") + _COLUMNS",
                    f"row = fetch_one(self._connection, sql, {values})",
                ],
                imports,
                [
                    "if row is None:",
                    f'    raise LookupError("The {info["entity"]} just written is not there")',
                    "return _entity(row)",
                ],
            )
        return _write(
            context,
            info,
            [
                *prepare,
                f"new_id = execute(self._connection, f{_sql(f'{into} ({{names}}) VALUES ({{marks}})')}, {values})",
                identity and f"if entity.{identity['attr']} is None:",
                identity and f"    entity.{identity['attr']} = new_id",
            ],
            imports,
            _read_back(context, info, "entity"),
        )
    if kind == "update":
        changes = [column for column in info["columns"] if _changeable(info, column)]
        stamps = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
        sets = [
            *(f"{_q(context, column['column']['name'])} = {m}" for column in changes),
            *(f"{_q(context, column['column']['name'])} = CURRENT_TIMESTAMP" for column in stamps),
        ]
        if not sets:
            return _read_back(context, info, "entity")
        values = _params(
            [
                *(
                    f"entity.{column['attr']}" if _is_array(context, column) else _to_db(f"entity.{column['attr']}")
                    for column in changes
                ),
                *(_to_db(f"entity.{column['attr']}") for column in info["key"]),
            ]
        )
        statement = f"UPDATE {_table(context, info)} SET {', '.join(sets)}{_where(_equals(context, info['key']))}"
        return _write(
            context,
            info,
            [f"execute(self._connection, {_sql(statement)}, {values})"],
            imports,
            _read_back(context, info, "entity"),
        )
    if kind == "delete":
        statement = f"DELETE{source}{_where(_equals(context, info['key']))}"
        return _write(
            context,
            info,
            [f"execute(self._connection, {_sql(statement)}, {_key_params(info)})"],
            imports,
        )
    return ["raise NotImplementedError"]


def _dependencies(context: dict) -> list[str]:
    settings = context["settings"]
    deps = []
    if settings["database"] == "postgresql":
        deps.append(_VERSIONS["psycopg"])
    if settings["database"] in ("mysql", "mariadb"):
        deps.append(_VERSIONS["mysql"])
    if settings["serviceTypes"] == "dtos" and settings["dtoKind"] == "pydantic":
        deps.append(_VERSIONS["pydantic"])
    return deps


def _unit_of_work(context: dict, imports: Imports) -> list:
    """The class SqlUnitOfWork: the repositories over one connection, and the transaction of each operation."""
    imports.from_("app.db", "Connection").from_("collections.abc", "Iterator").from_("contextlib", "contextmanager")
    return [
        "class SqlUnitOfWork:",
        f'    """The repositories over one connection of {driver_label(context)}."""',
        "",
        "    def __init__(self, connection: Connection) -> None:",
        "        self.connection = connection",
        *(f"        self.{info['attr']} = {sql_repository_class(info)}(connection)" for info in context["tables"]),
        "",
        "    @contextmanager",
        "    def transaction(self) -> Iterator[None]:",
        '        """Commits what runs inside it, or rolls it back if it fails."""',
        "        try:",
        "            yield",
        "        except BaseException:",
        "            self.connection.rollback()",
        "            raise",
        "        self.connection.commit()"
        if context["settings"]["transactions"] == "operation"
        else "        # The commit belongs to whoever holds the connection",
    ]


def _schema_file(context: dict) -> dict:
    """tests/schema.py: the SQL that removes and creates the tables of the test database."""
    database = context["settings"]["database"]

    def listed(name: str, doc: str, statements: list[str]) -> list[str]:
        return [f"{name} = [", *(f"    {js_json(statement)}," for statement in statements), "]", f'"""{doc}"""']

    return {
        "path": "tests/schema.py",
        "content": lines(
            '"""The tables of the test database, as the schema DB2CRUD read has them."""',
            "",
            *listed(
                "DROP",
                "Removes every table, so the database starts empty.",
                drop_statements(context["schema"], database),
            ),
            "",
            *listed(
                "CREATE",
                "Creates every table, in an order the database accepts.",
                create_statements(context["schema"], database),
            ),
            "",
        ),
    }


def _conftest_file(context: dict) -> dict:
    imports = Imports().module("os").module("pytest").from_("collections.abc", "Iterator")
    imports.from_("app.db", "Connection", "connect", "execute").from_("app.unit_of_work", "SqlUnitOfWork").from_(
        "tests.schema", "CREATE", "DROP"
    )
    if context["settings"]["memoryRepositories"]:
        imports.from_("app.unit_of_work", "MemoryUnitOfWork")
    content = lines(
        '"""Fixtures of the tests: a database created from the schema, and the units of work."""',
        "",
        imports.write("app"),
        "",
        "",
        "@pytest.fixture",
        "def connection(tmp_path) -> Iterator[Connection]:  # type: ignore[no-untyped-def]",
        '    """The test database, empty: TEST_DATABASE_URL, or SQLite in a temporary file."""',
        '    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / \'test.db\'}"',
        "    connection = connect(url)",
        "    for statement in DROP + CREATE:",
        "        execute(connection, statement)",
        "    connection.commit()",
        "    yield connection",
        "    connection.rollback()",
        "    for statement in DROP:",
        "        execute(connection, statement)",
        "    connection.commit()",
        "    connection.close()",
        "",
        "",
        "@pytest.fixture",
        "def sql_uow(connection: Connection) -> SqlUnitOfWork:",
        '    """The repositories over the test database."""',
        "    return SqlUnitOfWork(connection)",
        context["settings"]["memoryRepositories"]
        and [
            "",
            "",
            "@pytest.fixture",
            "def memory_uow() -> MemoryUnitOfWork:",
            '    """The in-memory repositories."""',
            "    return MemoryUnitOfWork()",
        ],
        "",
    )
    return {"path": "tests/conftest.py", "content": content}


def _database_test(_context: dict) -> dict:
    """Fails when the tests do not run on the database TEST_DATABASE_URL names, so a green run proves which one it
    was."""
    return {
        "path": "tests/test_database.py",
        "content": lines(
            '"""The tests run on the database they were asked to."""',
            "",
            "import os",
            "",
            "from app.db import Connection",
            "",
            "# The module of the connection each database gives",
            'DRIVERS = {"postgresql": "psycopg", "mysql": "mysql", "mariadb": "mysql", "sqlite": "sqlite3"}',
            "",
            "",
            "def test_runs_on_the_database_asked(connection: Connection) -> None:",
            '    url = os.environ.get("TEST_DATABASE_URL")',
            '    expected = url.split(":", 1)[0].split("+", 1)[0] if url else "sqlite"',
            '    assert type(connection).__module__.split(".")[0] == DRIVERS[expected]',
            "",
        ),
    }


def _doc(context: dict, info: dict) -> str:
    commits = (
        " Every write is committed at once."
        if context["settings"]["transactions"] == "repository"
        else " It never commits: the transaction belongs to whoever holds the connection."
    )
    return f"Keeps {info['name']} rows in the database, with SQL through {driver_label(context)}.{commits}"


def _init(_context: dict, imports: Imports) -> list:
    imports.from_("app.db", "Connection")
    return ["def __init__(self, connection: Connection) -> None:", "    self._connection = connection"]


SQL_ORM = {
    "id": "sql",
    "label": "SQL",
    "databaseFiles": database_files,
    "repository": {"doc": _doc, "init": _init, "body": _body, "helpers": _helpers},
    "unset": lambda target, _imports: f"{target} is None",
    "unitOfWork": _unit_of_work,
    "conftest": _conftest_file,
    "databaseTest": _database_test,
    "extraTestFiles": lambda context: [_schema_file(context)],
    "databaseFixture": "sql_uow: SqlUnitOfWork",
    "dependencies": _dependencies,
    "devDependencies": lambda _context: [_VERSIONS["pytest"]],
    "pytestOptions": lambda _context: [],
    "defaultUrl": default_url,
    "layout": lambda _context: ["app/db.py              the connection and the helpers that run SQL"],
}
