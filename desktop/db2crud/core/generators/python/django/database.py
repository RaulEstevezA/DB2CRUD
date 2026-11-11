"""The database layer of a Django project: app/settings.py, app/models.py and the model of each table. Mirrors
web/src/core/generators/python/django/database.ts."""

from ....js import number_text
from ...types import lines
from ..common.context import find_info, module_of, path_of
from ..python import Imports, js_json, py_literal

URLS = {
    "postgresql": "postgresql://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mysql://app:app@localhost:3306/app",
    "sqlite": "sqlite:///./app.db",
}


def default_url(context: dict) -> str:
    return URLS.get(context["settings"]["database"], URLS["postgresql"])


SETTINGS = [
    '"""Django settings of the data access layer: only what the ORM needs. The database comes from DATABASE_URL;',
    'see .env.example. Import this module from your project\'s settings, or point DJANGO_SETTINGS_MODULE to it."""',
    "",
    "import os",
    "from urllib.parse import unquote, urlsplit",
    "",
    "",
    "def database_from_url(url: str) -> dict[str, str]:",
    '    """A Django database from a URL: postgresql://user:password@host:port/name, mysql://…, sqlite:///path or',
    '    sqlite://:memory:. A driver after the scheme (postgresql+psycopg) is ignored."""',
    "    parts = urlsplit(url)",
    '    scheme = parts.scheme.split("+", 1)[0]',
    '    if scheme == "sqlite":',
    '        return {"ENGINE": "django.db.backends.sqlite3", "NAME": parts.netloc or parts.path[1:] or ":memory:"}',
    '    engine = {"postgresql": "postgresql", "postgres": "postgresql", "mysql": "mysql", "mariadb": "mysql"}[scheme]',
    '    if engine == "mysql":',
    "        # PyMySQL stands in for mysqlclient, which needs a C compiler and the MySQL client library",
    "        import pymysql",
    "",
    "        pymysql.install_as_MySQLdb()",
    "    return {",
    '        "ENGINE": f"django.db.backends.{engine}",',
    '        "NAME": parts.path.lstrip("/"),',
    '        "USER": unquote(parts.username or ""),',
    '        "PASSWORD": unquote(parts.password or ""),',
    '        "HOST": parts.hostname or "",',
    '        "PORT": str(parts.port or ""),',
    "    }",
    "",
    "",
    'SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "only-the-orm-is-used-change-it-in-your-project")',
    'INSTALLED_APPS = ["app"]',
]


def settings_file(context: dict) -> dict:
    content = lines(
        *SETTINGS,
        f'DATABASES = {{"default": database_from_url(os.environ.get("DATABASE_URL", "{default_url(context)}"))}}',
        "USE_TZ = True",
        'TIME_ZONE = "UTC"',
        'DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"',
        "",
    )
    return {"path": "app/settings.py", "content": content}


def models_file(context: dict) -> dict:
    """app/models.py: Django finds the models of an app in this module, so it imports every entity."""
    imports = Imports()
    written = [info for info in context["tables"] if info["writesEntity"]]
    for info in written:
        imports.from_(module_of(context, info, "entity"), info["entity"])
    entities = ", ".join(f'"{info["entity"]}"' for info in written)
    content = lines(
        '"""The models of the app, imported here so Django\'s app registry and the test database know every table."""',
        "",
        imports.write("app"),
        "",
        f"__all__ = [{entities}]",
        "",
    )
    return {"path": "app/models.py", "content": content}


# Fields


def _foreign_key_field(context: dict, info: dict, column: dict) -> dict | None:
    """The Django field of a foreign key column, when the ORM can express it."""
    key = next(
        (
            item
            for item in info["table"]["foreignKeys"]
            if len(item["columns"]) == 1 and item["columns"][0] == column["column"]["name"]
        ),
        None,
    )
    if not key or not column["attr"].endswith("_id") or column["attr"] == "_id":
        return None
    target = find_info(context, key["references"]["table"])
    if (
        not target
        or len(target["key"]) != 1
        or target["key"][0]["column"]["name"] != key["references"]["columns"][0]
        or not target["table"]["primaryKey"]
    ):
        return None
    return {"key": key, "name": column["attr"][:-3], "target": target}


ON_DELETE = {
    "cascade": "CASCADE",
    "set null": "SET_NULL",
    "set default": "SET_DEFAULT",
    "restrict": "RESTRICT",
    "no action": "DO_NOTHING",
}


def field_name(context: dict, info: dict, column: dict) -> str:
    foreign = _foreign_key_field(context, info, column)
    return foreign["name"] if foreign else column["attr"]


def _field_type(context: dict, column_type: dict, todos: list[str]) -> tuple[str, list[str]]:
    kind = column_type["kind"]
    sql = column_type["sql"]
    if kind == "integer":
        bits = column_type.get("bits")
        return ("SmallIntegerField" if bits == 16 else "BigIntegerField" if bits == 64 else "IntegerField"), []
    if kind == "decimal":
        has_precision = "precision" in column_type
        if not has_precision:
            todos.append(f'"{sql}" declares no precision: 20 digits, 6 decimals are assumed')
        scale = column_type.get("scale", 0 if has_precision else 6)
        return "DecimalField", [f"max_digits={column_type.get('precision', 20)}", f"decimal_places={scale}"]
    if kind == "float":
        return "FloatField", []
    if kind == "text":
        if "length" not in column_type:
            return "TextField", []
        if column_type.get("fixed"):
            todos.append(f'"{sql}" has a fixed length; Django writes it as VARCHAR')
        return "CharField", [f"max_length={column_type['length']}"]
    simple = {
        "boolean": "BooleanField",
        "date": "DateField",
        "time": "TimeField",
        "datetime": "DateTimeField",
        "uuid": "UUIDField",
        "binary": "BinaryField",
        "json": "JSONField",
    }
    if kind in simple:
        return simple[kind], []
    if kind == "array":
        todos.append(
            f'"{sql}" is kept as JSON; use django.contrib.postgres ArrayField on PostgreSQL if you need the native array'
        )
        return "JSONField", []
    if kind == "enum":
        item = next(
            (candidate for candidate in context["schema"]["enums"] if candidate["name"] == column_type["name"]), None
        )
        values = item["values"] if item else []
        length = max([1, *[len(value) for value in values]])
        choices = ", ".join(f"({js_json(value)}, {js_json(value)})" for value in values)
        return "CharField", [f"max_length={length}", f"choices=[{choices}]"]
    todos.append(f'"{sql}" has no Django field here; it is mapped as text')
    return "TextField", []


def _field_line(context: dict, info: dict, column: dict, imports: Imports) -> list[str]:
    db = column["column"]
    todos: list[str] = []
    primary_key = info["table"]["primaryKey"]
    single_key = bool(primary_key) and len(primary_key) == 1 and primary_key[0] == db["name"]
    foreign = _foreign_key_field(context, info, column)
    args: list[str] = []
    if foreign:
        field = "ForeignKey"
        on_delete = ON_DELETE[foreign["key"].get("onDelete") or "no action"]
        args += [js_json(foreign["target"]["entity"]), f"on_delete=models.{on_delete}", 'related_name="+"']
        args.append(f"db_column={js_json(db['name'])}")
    else:
        relation = next((key for key in info["table"]["foreignKeys"] if db["name"] in key["columns"]), None)
        if relation:
            todos.append(
                f"{', '.join(relation['columns'])} points to {relation['references']['table']}; Django can only express "
                "single-column keys named <x>_id to a single-column primary key"
            )
        column_type = db["type"]
        if db.get("generated") == "identity" and single_key:
            bits = column_type.get("bits") if column_type["kind"] == "integer" else None
            field = "SmallAutoField" if bits == 16 else "AutoField" if bits == 32 else "BigAutoField"
        else:
            field, extra = _field_type(context, column_type, todos)
            args += extra
        if column["attr"] != db["name"]:
            args.append(f"db_column={js_json(db['name'])}")
    if single_key:
        args.append("primary_key=True")
    generated = db.get("generated")
    if generated == "uuid":
        imports.module("uuid")
        args.append("default=uuid.uuid4")
    if generated in ("now", "onUpdateNow"):
        imports.from_("django.db.models.functions", "Now")
        args.append("db_default=Now()")
        if generated == "onUpdateNow":
            args.append("auto_now=True")
    if isinstance(generated, dict):
        todos.append(f"computed by the database as {generated['computed']}; never written by the application")
    default = db.get("default")
    if default and default["kind"] == "literal":
        args.append(f"default={py_literal(default['value'])}")
    if default and default["kind"] == "expression":
        todos.append(f"the database fills it with {default['sql']} when it is left out")
    if db["nullable"] and not single_key:
        args += ["null=True", "blank=True"]
    name = foreign["name"] if foreign else column["attr"]
    return [*[f"    # TODO: {todo}" for todo in todos], f"    {name} = models.{field}({', '.join(args)})"]


_OPS = {">": "gt", ">=": "gte", "<": "lt", "<=": "lte"}


def _check_constraint(context: dict, info: dict, check: dict, index: int, imports: Imports) -> str | None:
    parsed = check.get("parsed")
    if not parsed or parsed["kind"] == "length":
        return None
    column = next((item for item in info["columns"] if item["column"]["name"] == parsed["column"]), None)
    if not column:
        return None
    field = field_name(context, info, column)
    if parsed["kind"] == "in":
        lookup = f"{field}__in=[{', '.join(js_json(value) for value in parsed['values'])}]"
    else:
        lookup = f"{field}__{_OPS[parsed['op']]}={number_text(parsed['value'])}"
    imports.from_("django.db.models", "Q")
    name = check.get("name") or f"ck_{info['name']}_{parsed['column']}_{index}"
    return f"models.CheckConstraint(condition=Q({lookup}), name={js_json(name)})"


def _index_name(name: str) -> str:
    """Django refuses index names longer than 30 characters."""
    return name if len(name) <= 30 else name[:30]


def entity_file(context: dict, info: dict) -> dict:
    imports = Imports().from_("django.db", "models")
    fields = [line for column in info["columns"] for line in _field_line(context, info, column, imports)]
    table = info["table"]

    def column_of(name: str) -> dict:
        return next(column for column in info["columns"] if column["column"]["name"] == name)

    def names(columns: list[str]) -> str:
        return ", ".join(js_json(field_name(context, info, column_of(name))) for name in columns)

    def attrs(columns: list[str]) -> str:
        return ", ".join(js_json(column_of(name)["attr"]) for name in columns)

    constraints = []
    todos = []
    for unique in table["uniques"]:
        name = unique.get("name") or f"uq_{info['name']}_{'_'.join(unique['columns'])}"
        constraints.append(f"models.UniqueConstraint(fields=[{names(unique['columns'])}], name={js_json(name)})")
    for index, check in enumerate(table["checks"]):
        constraint = _check_constraint(context, info, check, index, imports)
        if constraint:
            constraints.append(constraint)
        else:
            todos.append(f"CHECK ({check['sql']}) is kept by the database; Django cannot express it")
    indexes = []
    for index in table["indexes"]:
        name = index.get("name") if index.get("name") is not None else f"ix_{info['name']}_{'_'.join(index['columns'])}"
        indexes.append(f"models.Index(fields=[{names(index['columns'])}], name={js_json(_index_name(name))})")
    if table.get("schema"):
        todos.append(f'the table is in the "{table["schema"]}" schema; set the search path or db_table for it')
    composite = len(table["primaryKey"]) > 1 if table["primaryKey"] else True
    comment = f": {table['comment']}" if table.get("comment") else ""
    key = attrs([column["column"]["name"] for column in info["key"]])
    content = lines(
        f'"""Entity of the "{info["name"]}" table{comment}."""',
        "",
        imports.write("app"),
        "",
        "",
        f"class {info['entity']}(models.Model):",
        f'    """A row of the "{info["name"]}" table."""',
        "",
        composite
        and [
            not table["primaryKey"]
            and "    # The table has no primary key: rows are told apart by all their columns, for reading only",
            f"    pk = models.CompositePrimaryKey({key})",
        ],
        fields,
        "",
        "    class Meta:",
        f"        db_table = {js_json(info['name'])}",
        not table["primaryKey"]
        and [
            "        # Read only: Django never creates or changes this table, so the key above stays in the ORM",
            "        managed = False",
        ],
        *[f"        # TODO: {todo}" for todo in todos],
        bool(constraints)
        and ["        constraints = [", *[f"            {item}," for item in constraints], "        ]"],
        bool(indexes) and ["        indexes = [", *[f"            {item}," for item in indexes], "        ]"],
        "",
    )
    return {"path": path_of(module_of(context, info, "entity")), "content": content}


def database_files(context: dict) -> list[dict]:
    written = [entity_file(context, info) for info in context["tables"] if info["writesEntity"]]
    return [settings_file(context), models_file(context), *written]
