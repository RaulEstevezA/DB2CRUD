"""The database layer of a Python project without an ORM: the connection through each database's driver (psycopg 3,
MySQL Connector/Python, sqlite3), the helpers that run SQL and turn values from and to what the driver keeps, and the
entities, plain dataclasses with one attribute per column. Mirrors web/src/core/generators/python/sql/database.ts."""

from ...types import lines
from ..common.context import column_py_type, module_of, path_of, writes_entities
from ..python import Imports


def default_url(context: dict) -> str:
    database = context["settings"]["database"]
    if database == "postgresql":
        return "postgresql://app:app@localhost:5432/app"
    if database in ("mysql", "mariadb"):
        return f"{database}://app:app@localhost:3306/app"
    return "sqlite:///app.db"


def driver_label(context: dict) -> str:
    """The driver's name, for texts."""
    database = context["settings"]["database"]
    if database == "postgresql":
        return "psycopg"
    if database in ("mysql", "mariadb"):
        return "MySQL Connector/Python"
    return "sqlite3"


def mark(context: dict) -> str:
    """The mark of a parameter in the SQL: `%s` (psycopg, MySQL Connector) or `?` (sqlite3)."""
    return "?" if context["settings"]["database"] == "sqlite" else "%s"


def db_file(context: dict) -> dict:
    """app/db.py: the connection, the helpers that run SQL, and the values as the driver keeps them."""
    database = context["settings"]["database"]
    imports = Imports().module("os").from_("typing", "Any").from_("urllib.parse", "unquote", "urlsplit")
    sqlite = database == "sqlite"
    postgres = database == "postgresql"
    if postgres:
        imports.module("psycopg").from_("psycopg.types.json", "Jsonb")
        connect = [
            "def connect(url: str = DATABASE_URL) -> Connection:",
            '    """A connection to the database at `url` (postgresql://user:password@host:port/name)."""',
            "    parts = urlsplit(url)",
            '    return psycopg.connect(parts._replace(scheme="postgresql").geturl())',
        ]
    elif sqlite:
        imports.module("sqlite3")
        connect = [
            "def connect(url: str = DATABASE_URL) -> Connection:",
            '    """A connection to the database file at `url` (sqlite:///path), with foreign keys turned on."""',
            "    path = unquote(urlsplit(url).path)",
            "    # sqlite:///app.db is the file app.db; sqlite:////tmp/app.db is /tmp/app.db",
            '    connection = sqlite3.connect(path[1:] if path.startswith("/") else path)',
            '    connection.execute("PRAGMA foreign_keys = ON")',
            "    return connection",
        ]
    else:
        imports.module("mysql.connector")
        connect = [
            "def connect(url: str = DATABASE_URL) -> Connection:",
            f'    """A connection to the database at `url` ({database}://user:password@host:port/name)."""',
            "    parts = urlsplit(url)",
            "    return mysql.connector.connect(",
            '        host=parts.hostname or "localhost",',
            "        port=parts.port or 3306,",
            '        user=unquote(parts.username or ""),',
            '        password=unquote(parts.password or ""),',
            '        database=parts.path.lstrip("/"),',
            "    )",
        ]
    if not postgres:
        imports.module("json")
    if sqlite:
        imports.from_("datetime", "date", "datetime", "time").from_("decimal", "Decimal").from_("uuid", "UUID")
    elif not postgres:
        imports.from_("uuid", "UUID")
    label = driver_label(context)
    if postgres:
        connection_type = "Connection = psycopg.Connection[tuple[Any, ...]]"
    elif sqlite:
        connection_type = "Connection = sqlite3.Connection"
    else:
        connection_type = "# What mysql.connector.connect() returns"
    integrity = (
        "psycopg.IntegrityError"
        if postgres
        else "sqlite3.IntegrityError"
        if sqlite
        else "mysql.connector.IntegrityError"
    )
    if postgres:
        to_db = ["    if isinstance(value, (dict, list)):", "        return Jsonb(value)", "    return value"]
    else:
        to_db = [
            "    if isinstance(value, (dict, list)):",
            "        return json.dumps(value)",
            "    if isinstance(value, UUID):",
            "        return str(value)",
            *(
                [
                    "    if isinstance(value, Decimal):",
                    "        return str(value)",
                    "    if isinstance(value, (datetime, date, time)):",
                    "        return value.isoformat()",
                ]
                if sqlite
                else []
            ),
            "    return value",
        ]
    times = database not in ("postgresql", "sqlite") and any(
        column["column"]["type"]["kind"] == "time" for info in context["tables"] for column in info["columns"]
    )
    if times:
        imports.from_("datetime", "datetime", "timedelta")
    content = lines(
        f'"""The connection to the database through {label}, and the helpers the repositories run SQL with.',
        "",
        "The URL comes from DATABASE_URL; see .env.example.",
        '"""',
        "",
        imports.write("app"),
        "",
        f'DATABASE_URL = os.environ.get("DATABASE_URL", "{default_url(context)}")',
        "",
        connection_type,
        not postgres and not sqlite and "Connection = Any",
        "",
        f"IntegrityError = {integrity}",
        '"""What the database raises when it refuses a change: a unique value, a foreign key, a check."""',
        "",
        "",
        *connect,
        "",
        "",
        "def fetch_one(connection: Connection, sql: str, params: tuple[Any, ...] = ()) -> tuple[Any, ...] | None:",
        '    """The first row of a query, or None."""',
        "    cursor = connection.cursor()",
        "    try:",
        "        cursor.execute(sql, params) if params else cursor.execute(sql)",
        "        row = cursor.fetchone()",
        "        return tuple(row) if row is not None else None",
        "    finally:",
        "        cursor.close()",
        "",
        "",
        "def fetch_all(connection: Connection, sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:",
        '    """Every row of a query."""',
        "    cursor = connection.cursor()",
        "    try:",
        "        cursor.execute(sql, params) if params else cursor.execute(sql)",
        "        return [tuple(row) for row in cursor.fetchall()]",
        "    finally:",
        "        cursor.close()",
        "",
        "",
        "def execute(connection: Connection, sql: str, params: tuple[Any, ...] = ()) -> int | None:",
        '    """Runs a statement; the id the database gave the new row, when it numbers them."""',
        "    cursor = connection.cursor()",
        "    try:",
        # Without parameters the SQL is sent as it is: a % in it is not a parameter
        "        cursor.execute(sql, params) if params else cursor.execute(sql)",
        # psycopg reads new rows with RETURNING: its cursors keep no last id
        "        return None" if postgres else "        return cursor.lastrowid",
        "    finally:",
        "        cursor.close()",
        "",
        "",
        "def to_db(value: Any) -> Any:",
        f'    """A value as {label} writes it."""',
        to_db,
        # What a driver hands back in another form than the entity's
        not postgres
        and [
            "",
            "",
            "def read_json(value: Any) -> Any:",
            '    """A JSON value: the driver gives its text."""',
            "    return json.loads(value) if isinstance(value, (str, bytes, bytearray)) else value",
            "",
            "",
            "def read_uuid(value: Any) -> Any:",
            '    """A UUID, kept as text."""',
            "    return UUID(str(value)) if value is not None and not isinstance(value, UUID) else value",
            "",
            "",
            "def read_bool(value: Any) -> Any:",
            '    """A boolean, kept as a number."""',
            "    return bool(value) if value is not None else None",
            "",
            "",
            "def read_bytes(value: Any) -> Any:",
            '    """Bytes, which the driver may give as a bytearray."""',
            "    return bytes(value) if value is not None else None",
        ],
        times
        and [
            "",
            "",
            "def read_time(value: Any) -> Any:",
            '    """A time of the day, which the driver gives as the time since midnight."""',
            "    return (datetime.min + value).time() if isinstance(value, timedelta) else value",
        ],
        sqlite
        and [
            "",
            "",
            "def read_decimal(value: Any) -> Any:",
            '    """A decimal, which SQLite keeps as a number or a text."""',
            "    return Decimal(str(value)) if value is not None else None",
            "",
            "",
            "def read_datetime(value: Any) -> Any:",
            '    """A date and time, kept as ISO text."""',
            "    return datetime.fromisoformat(value) if isinstance(value, str) else value",
            "",
            "",
            "def read_date(value: Any) -> Any:",
            '    """A date, kept as ISO text."""',
            "    return date.fromisoformat(value) if isinstance(value, str) else value",
            "",
            "",
            "def read_time(value: Any) -> Any:",
            '    """A time of the day, kept as ISO text."""',
            "    return time.fromisoformat(value) if isinstance(value, str) else value",
        ],
        "",
    )
    return {"path": "app/db.py", "content": content}


_READERS = {
    "json": "read_json",
    "array": "read_json",
    "uuid": "read_uuid",
    "boolean": "read_bool",
    "binary": "read_bytes",
    "time": "read_time",
}
_SQLITE_READERS = {
    "decimal": "read_decimal",
    "datetime": "read_datetime",
    "date": "read_date",
}


def reader_of(context: dict, kind: str) -> str | None:
    """The reader a value of a column goes through, when the driver hands it in another form; None when it does
    not."""
    database = context["settings"]["database"]
    if database == "postgresql":
        return None
    if kind in _READERS:
        return _READERS[kind]
    return _SQLITE_READERS.get(kind) if database == "sqlite" else None


def entity_file(context: dict, info: dict) -> dict:
    """The entity of a table: a dataclass with one attribute per column, None until it is set or read."""
    imports = Imports().annotations().from_("dataclasses", "dataclass")
    fields = [f"    {column['attr']}: {column_py_type(column, imports, True)} = None" for column in info["columns"]]
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    content = lines(
        f'"""Entity of the "{info["name"]}" table{comment}."""',
        "",
        imports.write("app"),
        "",
        "",
        "@dataclass(kw_only=True)",
        f"class {info['entity']}:",
        f'    """A row of the "{info["name"]}" table. An attribute stays None until it is set or read."""',
        "",
        *fields,
        "",
    )
    return {"path": path_of(module_of(context, info, "entity")), "content": content}


def database_files(context: dict) -> list[dict]:
    entities = (
        [entity_file(context, info) for info in context["tables"] if info["writesEntity"]]
        if writes_entities(context)
        else []
    )
    return [db_file(context), *entities]
