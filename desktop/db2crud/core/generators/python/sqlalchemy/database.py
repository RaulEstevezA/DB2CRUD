"""app/db.py (engine, sessions and the declarative base) and the entity of each table: exact table and column names,
precise types and every constraint of the input. Mirrors web/src/core/generators/python/sqlalchemy/database.ts."""

from ...types import lines
from ..common.context import column_py_type, module_of, path_of, writes_entities
from ..python import Imports, js_json, py_literal

SYNC_URLS = {
    "postgresql": "postgresql+psycopg://app:app@localhost:5432/app",
    "mysql": "mysql+pymysql://app:app@localhost:3306/app",
    "mariadb": "mysql+pymysql://app:app@localhost:3306/app",
    "sqlite": "sqlite:///./app.db",
}


def default_url(context: dict) -> str:
    return SYNC_URLS.get(context["settings"]["database"], SYNC_URLS["postgresql"])


def db_file(context: dict) -> dict:
    imports = Imports().module("os")
    base = writes_entities(context)
    is_async = context["async"]
    if is_async:
        imports.from_("sqlalchemy", "event").from_(
            "sqlalchemy.ext.asyncio", "AsyncEngine", "AsyncSession", "async_sessionmaker", "create_async_engine"
        )
    else:
        imports.from_("sqlalchemy", "Engine", "create_engine", "event").from_(
            "sqlalchemy.orm", "Session", "sessionmaker"
        )
    if base:
        imports.from_("sqlalchemy.orm", "DeclarativeBase")
    engine = "AsyncEngine" if is_async else "Engine"
    base_text = " and the declarative base of the entities" if base else ""
    content = lines(
        f'"""Database engine, sessions{base_text} (SQLAlchemy 2{", asynchronous" if is_async else ""}).',
        "",
        "The URL comes from DATABASE_URL; see .env.example.",
        '"""',
        "",
        imports.write("app"),
        "",
        f'DATABASE_URL = os.environ.get("DATABASE_URL", "{default_url(context)}")',
        "",
        base and ["", "class Base(DeclarativeBase):", '    """Base of every entity."""', ""],
        is_async
        and [
            "",
            "# The asynchronous driver of each database the synchronous URLs name",
            '_ASYNC_DRIVERS = {"sqlite": "sqlite+aiosqlite", "sqlite+pysqlite": "sqlite+aiosqlite", '
            '"mysql+pymysql": "mysql+aiomysql", "mariadb+pymysql": "mysql+aiomysql"}',
            "",
            "",
            "def async_url(url: str) -> str:",
            '    """The same database with an asynchronous driver: psycopg already is one."""',
            '    scheme, separator, rest = url.partition("://")',
            "    return _ASYNC_DRIVERS.get(scheme, scheme) + separator + rest",
        ],
        "",
        "",
        f"def create_db_engine(url: str = DATABASE_URL) -> {engine}:",
        '    """An engine for the database at `url`. SQLite gets foreign keys turned on, as other databases have them."""',
        '    engine = create_async_engine(async_url(url), pool_pre_ping=not url.startswith("sqlite"))'
        if is_async
        else '    engine = create_engine(url, pool_pre_ping=not url.startswith("sqlite"))',
        '    if url.startswith("sqlite"):',
        "",
        f'        @event.listens_for(engine{".sync_engine" if is_async else ""}, "connect")',
        "        def _foreign_keys(connection, _record) -> None:  # type: ignore[no-untyped-def]",
        "            cursor = connection.cursor()",
        '            cursor.execute("PRAGMA foreign_keys=ON")',
        "            cursor.close()",
        "",
        "    return engine",
        "",
        "",
        "def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:"
        if is_async
        else "def create_session_factory(engine: Engine) -> sessionmaker[Session]:",
        '    """Sessions that keep loaded rows readable after a commit."""',
        "    return async_sessionmaker(engine, expire_on_commit=False)"
        if is_async
        else "    return sessionmaker(engine, expire_on_commit=False)",
        "",
    )
    return {"path": "app/db.py", "content": content}


# Entities


def _sa_type(column_type: dict, imports: Imports, key: bool) -> str:
    def sa(name: str) -> str:
        imports.from_("sqlalchemy", name)
        return name

    kind = column_type["kind"]
    if kind == "integer":
        bits = column_type.get("bits")
        # SQLite only numbers rows by itself on INTEGER PRIMARY KEY
        if bits == 64 and key:
            return f'{sa("BigInteger")}().with_variant({sa("Integer")}(), "sqlite")'
        return f"{sa('SmallInteger' if bits == 16 else 'BigInteger' if bits == 64 else 'Integer')}()"
    if kind == "decimal":
        if "precision" in column_type:
            return f"{sa('Numeric')}({column_type['precision']}, {column_type.get('scale', 0)})"
        return f"{sa('Numeric')}()"
    if kind == "float":
        return f"{sa('Float')}()" if column_type.get("bits") == 32 else f"{sa('Double')}()"
    if kind == "text":
        if "length" not in column_type:
            return f"{sa('Text')}()"
        return f"{sa('CHAR' if column_type.get('fixed') else 'String')}({column_type['length']})"
    if kind in ("boolean", "date", "uuid"):
        return f"{sa({'boolean': 'Boolean', 'date': 'Date', 'uuid': 'Uuid'}[kind])}()"
    if kind in ("time", "datetime"):
        name = "Time" if kind == "time" else "DateTime"
        return f"{sa(name)}(timezone={'True' if column_type['timezone'] else 'False'})"
    if kind == "binary":
        if "length" in column_type:
            return f"{sa('LargeBinary')}({column_type['length']})"
        return f"{sa('LargeBinary')}()"
    if kind in ("json", "array"):
        # Arrays are portable as JSON; a native PostgreSQL array is a decision for the user
        return f"{sa('JSON')}()"
    if kind == "enum":
        return f"{sa('String')}({max(1, len(column_type['name']))})"
    return f"{sa('Text')}()"


def _enum_type(context: dict, column_type: dict, imports: Imports) -> str:
    item = next(
        (candidate for candidate in context["schema"]["enums"] if candidate["name"] == column_type["name"]), None
    )
    if not item:
        return _sa_type({"sql": column_type["sql"], "kind": "text"}, imports, False)
    imports.from_("sqlalchemy", "Enum")
    return f"Enum({', '.join(js_json(value) for value in item['values'])}, name={js_json(item['name'])})"


def _foreign_key(key: dict, imports: Imports) -> str:
    imports.from_("sqlalchemy", "ForeignKey")
    references = key["references"]
    namespace = f"{references['schema']}." if references.get("schema") else ""
    options = [js_json(f"{namespace}{references['table']}.{references['columns'][0]}")]
    if key.get("name"):
        options.append(f"name={js_json(key['name'])}")
    if key.get("onDelete"):
        options.append(f"ondelete={js_json(key['onDelete'].upper())}")
    if key.get("onUpdate"):
        options.append(f"onupdate={js_json(key['onUpdate'].upper())}")
    return f"ForeignKey({', '.join(options)})"


def _column_line(context: dict, info: dict, column: dict, imports: Imports) -> list:
    db = column["column"]
    primary_key = info["table"]["primaryKey"]
    is_key = primary_key is not None and db["name"] in primary_key
    column_type = db["type"]
    sa_type = (
        _enum_type(context, column_type, imports)
        if column_type["kind"] == "enum"
        else _sa_type(column_type, imports, is_key)
    )
    args = []
    if column["attr"] != db["name"]:
        args.append(js_json(db["name"]))
    args.append(sa_type)
    single_key = next(
        (key for key in info["table"]["foreignKeys"] if len(key["columns"]) == 1 and key["columns"][0] == db["name"]),
        None,
    )
    if single_key:
        args.append(_foreign_key(single_key, imports))
    if is_key:
        args.append("primary_key=True")
    generated = db.get("generated")
    if generated == "identity":
        args.append("autoincrement=True")
    if generated == "uuid":
        imports.from_("uuid", "uuid4")
        args.append("default=uuid4")
    if generated in ("now", "onUpdateNow"):
        imports.from_("sqlalchemy", "func")
        args.append("server_default=func.now()")
        if generated == "onUpdateNow":
            args.append("onupdate=func.now()")
    if isinstance(generated, dict):
        imports.from_("sqlalchemy", "Computed")
        args.append(f"Computed({js_json(generated['computed'])})")
    default = db.get("default")
    if default and default["kind"] == "literal":
        args.append(f"default={py_literal(default['value'])}")
    if default and default["kind"] == "expression":
        imports.from_("sqlalchemy", "text")
        args.append(f"server_default=text({js_json(default['sql'])})")
    if not is_key:
        args.append(f"nullable={'True' if db['nullable'] else 'False'}")
    todo = (
        f'    # TODO: "{column_type["sql"]}" has no SQLAlchemy type here; it is mapped as text'
        if column_type["kind"] == "unknown"
        else None
    )
    array = (
        f'    # TODO: "{column_type["sql"]}" is mapped as JSON; use sqlalchemy.ARRAY on PostgreSQL if you need the native array'
        if column_type["kind"] == "array"
        else None
    )
    imports.from_("sqlalchemy.orm", "Mapped", "mapped_column")
    return [
        todo,
        array,
        f"    {column['attr']}: Mapped[{column_py_type(column, imports)}] = mapped_column({', '.join(args)})",
    ]


def _quote_list(names: list[str]) -> str:
    return ", ".join(js_json(name) for name in names)


def _table_args(info: dict, imports: Imports) -> list[str]:
    table = info["table"]
    args = []
    for key in [item for item in table["foreignKeys"] if len(item["columns"]) > 1]:
        imports.from_("sqlalchemy", "ForeignKeyConstraint")
        references = key["references"]
        target = (f"{references['schema']}." if references.get("schema") else "") + references["table"]
        options = [
            f"[{_quote_list(key['columns'])}]",
            f"[{', '.join(js_json(f'{target}.{column}') for column in references['columns'])}]",
        ]
        if key.get("name"):
            options.append(f"name={js_json(key['name'])}")
        if key.get("onDelete"):
            options.append(f"ondelete={js_json(key['onDelete'].upper())}")
        args.append(f"ForeignKeyConstraint({', '.join(options)})")
    for unique in table["uniques"]:
        imports.from_("sqlalchemy", "UniqueConstraint")
        name = f", name={js_json(unique['name'])}" if unique.get("name") else ""
        args.append(f"UniqueConstraint({_quote_list(unique['columns'])}{name})")
    for index in table["indexes"]:
        imports.from_("sqlalchemy", "Index")
        name = index["name"] if index.get("name") is not None else f"ix_{table['name']}_{'_'.join(index['columns'])}"
        args.append(f"Index({js_json(name)}, {_quote_list(index['columns'])})")
    for check in table["checks"]:
        imports.from_("sqlalchemy", "CheckConstraint")
        name = f", name={js_json(check['name'])}" if check.get("name") else ""
        args.append(f"CheckConstraint({js_json(check['sql'])}{name})")
    return args


def entity_file(context: dict, info: dict) -> dict:
    imports = Imports().from_("app.db", "Base")
    columns = [line for column in info["columns"] for line in _column_line(context, info, column, imports)]
    args = _table_args(info, imports)
    table = info["table"]
    namespace = f'{{"schema": {js_json(table["schema"])}}}' if table.get("schema") else None
    items = [*args, *([namespace] if namespace else [])]
    only_namespace = len(items) == 1 and namespace is not None
    comment = f": {table['comment']}" if table.get("comment") else ""
    content = lines(
        f'"""Entity of the "{info["name"]}" table{comment}."""',
        "",
        imports.write("app"),
        "",
        "",
        f"class {info['entity']}(Base):",
        f'    """A row of the "{info["name"]}" table."""',
        "",
        f"    __tablename__ = {js_json(info['name'])}",
        f"    __table_args__ = {namespace}" if only_namespace else None,
        ["    __table_args__ = (", *[f"        {arg}," for arg in items], "    )"]
        if items and not only_namespace
        else None,
        "",
        columns,
        table["primaryKey"] is None
        and [
            "",
            "    # The table has no primary key: rows are told apart by all their columns, for reading only",
            f'    __mapper_args__ = {{"primary_key": [{", ".join(column["attr"] for column in info["columns"])}]}}'
            "  # noqa: RUF012",
        ],
        "",
    )
    return {"path": path_of(module_of(context, info, "entity")), "content": content}


def entity_files(context: dict) -> list[dict]:
    return [entity_file(context, info) for info in context["tables"] if info["writesEntity"]]
