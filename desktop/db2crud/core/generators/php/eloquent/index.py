"""Eloquent 12 (illuminate/database, without Laravel) as a PHP ORM strategy (common/orm.py): models with their casts, a
connection opened from DATABASE_URL through Capsule, repositories over the query builder that write by every column of
the key, the transaction of each operation on the connection, and tests whose tables the schema builder creates as the
database has them. Mirrors web/src/core/generators/php/eloquent/index.ts."""

import re

from ....js import number_text
from ..common.context import (
    class_name,
    column_of,
    error_class,
    find_info,
    ind,
    namespace_of,
    path_of,
    php_file,
    sql_repository_class,
)
from ..common.php import PhpUses, php_literal, php_string
from ..common.repositories import filled_by_database, uuid_fills
from ..common.support import repository_assignments, repository_properties
from ..common.tests import TESTS_NS, schemas_of, test_file
from .models import eloquent_model_file, eloquent_php_type

URLS = {
    "postgresql": "postgresql://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mariadb://app:app@localhost:3306/app",
    "sqlite": "sqlite:///app.db",
}

DRIVERS = {"postgresql": "pdo_pgsql", "mysql": "pdo_mysql", "mariadb": "pdo_mysql", "sqlite": "pdo_sqlite"}


def _url(context: dict) -> str:
    return URLS.get(context["settings"]["database"], URLS["postgresql"])


def _database_file(context: dict) -> dict:
    return php_file(
        path_of(context["base"], "Database"),
        context["base"],
        "\n".join(["use Illuminate\\Database\\Capsule\\Manager;", "use Illuminate\\Database\\Connection;"]),
        [
            "/** The database DATABASE_URL names, through Eloquent. It never migrates: the database already exists. */",
            "final class Database",
            "{",
            f"    public const DEFAULT_URL = {php_string(_url(context))};",
            "",
            "    /** The URL of DATABASE_URL, or the default one. */",
            "    public static function url(): string",
            "    {",
            "        $url = getenv('DATABASE_URL');",
            "        return is_string($url) && $url !== '' ? $url : self::DEFAULT_URL;",
            "    }",
            "",
            "    /** A connection to the database at $url (DATABASE_URL when null); the models use it from then on. */",
            "    public static function open(?string $url = null): Connection",
            "    {",
            "        $capsule = new Manager();",
            "        $capsule->addConnection(self::config($url ?? self::url()));",
            "        $capsule->bootEloquent();",
            "        return $capsule->getConnection();",
            "    }",
            "",
            "    /**",
            "     * The settings of the connection to a URL: postgresql://, mysql://, mariadb:// or sqlite:///<path> "
            "(sqlite:///:memory: for one in memory).",
            "     *",
            "     * @return array<string, mixed>",
            "     */",
            "    public static function config(string $url): array",
            "    {",
            "        if (str_starts_with($url, 'sqlite:')) {",
            "            $path = substr($url, strlen('sqlite:///'));",
            "            return ['driver' => 'sqlite', 'database' => $path !== '' ? $path : ':memory:', "
            "'foreign_key_constraints' => true];",
            "        }",
            "        return ['url' => $url];",
            "    }",
            "}",
        ],
    )


# Repositories


def _model(info: dict) -> str:
    return f"{info['entity']}::query()"


def _soft_calls(info: dict) -> list[str]:
    """The calls that leave out rows marked as deleted."""
    if not info["soft"]:
        return []
    name = php_string(info["soft"]["column"]["name"])
    if info["soft"]["column"]["type"]["kind"] == "boolean":
        return [f"->where(fn ($query) => $query->where({name}, false)->orWhereNull({name}))"]
    return [f"->whereNull({name})"]


def _equals(columns: list[dict], value) -> list[str]:
    return [f"->where({php_string(column['column']['name'])}, {value(column)})" for column in columns]


def _order_by(info: dict) -> list[str]:
    return [f"->orderBy({php_string(column['column']['name'])})" for column in info["key"]]


def _chain(start: str, calls: list[str]) -> list[str]:
    """A statement of chained calls, one per line."""
    return [start, *(f"    {call}{';' if index == len(calls) - 1 else ''}" for index, call in enumerate(calls))]


def _by_key(info: dict) -> list[str]:
    """The rows of the key of an entity as it was read: where it is, even when its key changed."""
    return _equals(info["key"], lambda column: f"$entity->getOriginal({php_string(column['column']['name'])})")


def _body(context: dict, info: dict, method: dict, uses: PhpUses) -> list:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    given = _equals(columns, lambda column: f"${column['field']}")
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return _chain(f"return {_model(info)}", [*given, *_soft_calls(info), "->first()"])
    if kind in ("listByParent", "findAllBy"):
        return _chain(f"return {_model(info)}", [*given, *_soft_calls(info), *_order_by(info), "->get()", "->all()"])
    if kind == "list":
        if _soft_calls(info):
            start = _chain(f"$query = {_model(info)}", _soft_calls(info))
        else:
            start = [f"$query = {_model(info)};"]
        if paging == "offset":
            return [
                *start,
                "$total = (clone $query)->count();",
                *_chain(
                    "$items = $query", [*_order_by(info), "->offset($offset)", "->limit($limit)", "->get()", "->all()"]
                ),
                "return new Page($items, $total, $offset, $limit);",
            ]
        if paging == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            key = info["key"]
            terms = []
            for index, column in enumerate(key):
                before = "".join(
                    f"->where({php_string(item['column']['name'])}, $after[{position}])"
                    for position, item in enumerate(key[:index])
                )
                terms.append(
                    f"fn ($query) => $query{before}->where({php_string(column['column']['name'])}, '>', $after[{index}])"
                )
            if len(key) == 1:
                condition = f"    $query->where({php_string(key[0]['column']['name'])}, '>', $after[0]);"
            else:
                joined = "".join(
                    f"->{'where' if index == 0 else 'orWhere'}({term})" for index, term in enumerate(terms)
                )
                condition = f"    $query->where(fn ($query) => $query{joined});"
            last = ", ".join(f"$items[$limit - 1]->{column['prop']}" for column in key)
            return [
                *start,
                "if ($after !== null) {",
                condition,
                "}",
                *_chain("$rows = $query", [*_order_by(info), "->limit($limit + 1)", "->get()", "->all()"]),
                "$items = array_slice($rows, 0, $limit);",
                f"return new CursorPage($items, count($rows) > $limit ? [{last}] : null);",
            ]
        return _chain(f"return {_model(info)}", [*_soft_calls(info), *_order_by(info), "->get()", "->all()"])
    if kind == "insert":
        # What the database filled is read back, by the key the row now has
        reload = info["table"]["primaryKey"] is not None and len(filled_by_database(info)) > 0
        read_back = []
        if reload:
            read_back = [
                *_chain(
                    f"$stored = {_model(info)}",
                    [*_equals(info["key"], lambda column: f"$entity->{column['prop']}"), "->firstOrFail()"],
                ),
                "$entity->setRawAttributes($stored->getAttributes(), true);",
            ]
        return [
            *uuid_fills(context, info, uses),
            "$this->write(fn () => $entity->save());",
            *read_back,
            "return $entity;",
        ]
    if kind == "update":
        return [
            "$changes = $entity->getDirty();",
            "if ($changes !== []) {",
            *ind(_chain(f"$this->write(fn () => {_model(info)}", [*_by_key(info), "->update($changes))"]), 4),
            "}",
            "$entity->syncOriginal();",
            "return $entity;",
        ]
    if kind == "delete":
        return [
            *_chain(f"$this->write(fn () => {_model(info)}", [*_by_key(info), "->delete())"]),
            "$entity->exists = false;",
        ]
    return ["throw new \\LogicException('not supported');"]


def _helpers(context: dict, info: dict, uses: PhpUses) -> list:
    if not any(item["kind"] in ("insert", "update", "delete") for item in info["queries"]):
        return []
    uses.add("Illuminate\\Database\\QueryException", error_class(context, "ConflictException"))
    return [
        "    /** Runs a write; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */",
        "    private function write(callable $change): void",
        "    {",
        "        try {",
        "            $change();",
        "        } catch (QueryException $error) {",
        "            // SQLSTATE class 23: the change breaks a constraint",
        "            if (!str_starts_with((string) $error->getCode(), '23')) {",
        "                throw $error;",
        "            }",
        f"            throw new ConflictException({php_string(info['entity'])}, 'the database refused the change: ' . "
        "$error->getMessage());",
        "        }",
        "    }",
    ]


def _unit_of_work(context: dict, uses: PhpUses) -> list:
    uses.add("Illuminate\\Database\\Connection")
    properties = repository_properties(context, uses, lambda info: info["attr"])
    for info in context["tables"]:
        uses.add(class_name(namespace_of(context, info, "repository"), sql_repository_class(info)))
    if context["settings"]["transactions"] == "operation":
        transaction = [
            "        // Joins the transaction already open",
            "        if ($this->db->transactionLevel() > 0) {",
            "            return $work($this);",
            "        }",
            "        return $this->db->transaction(fn () => $work($this));",
        ]
    else:
        transaction = ["        return $work($this);"]
    return [
        "/** The repositories over the connection the models use, and its transaction. */",
        "final class SqlUnitOfWork implements UnitOfWork",
        "{",
        *ind(properties, 4),
        "",
        "    public function __construct(public readonly Connection $db)",
        "    {",
        *ind(repository_assignments(context, lambda info: f"new {sql_repository_class(info)}()"), 8),
        "    }",
        "",
        "    public function transaction(callable $work): mixed",
        "    {",
        *transaction,
        "    }",
        "}",
    ]


# Tests: the tables, created with the schema builder

NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}

ACTIONS = {
    "cascade": "cascade",
    "set null": "set null",
    "set default": "set default",
    "restrict": "restrict",
    "no action": "no action",
}


def _single_key_is(table: dict, name: str) -> bool:
    key = table["primaryKey"]
    return key is not None and len(key) == 1 and key[0] == name


def _column_call(context: dict, table: dict, column: dict, native_enum: bool) -> str:
    """The Blueprint call that creates a column."""
    name = php_string(column["name"])
    column_type = column["type"]
    kind = column_type["kind"]
    identity = column.get("generated") == "identity" and _single_key_is(table, column["name"])
    if kind == "integer":
        # An identity key keeps its signed type (increments() would make it unsigned, unlike the columns pointing to it)
        method = {64: "bigInteger", 16: "smallInteger"}.get(column_type["bits"], "integer")
        return f"$table->{method}({name}{', true' if identity else ''})"
    if kind == "decimal":
        precision = column_type.get("precision")
        scale = column_type.get("scale")
        return f"$table->decimal({name}, {10 if precision is None else precision}, {0 if scale is None else scale})"
    if kind == "float":
        return f"$table->float({name})" if column_type["bits"] == 32 else f"$table->double({name})"
    if kind == "text":
        if column_type.get("length") is None:
            return f"$table->text({name})"
        return f"$table->{'char' if column_type.get('fixed') else 'string'}({name}, {column_type['length']})"
    if kind == "boolean":
        return f"$table->boolean({name})"
    if kind == "date":
        return f"$table->date({name})"
    if kind == "time":
        return f"$table->{'timeTz' if column_type.get('timezone') else 'time'}({name})"
    if kind == "datetime":
        return f"$table->{'dateTimeTz' if column_type.get('timezone') else 'dateTime'}({name})"
    if kind == "uuid":
        return f"$table->uuid({name})"
    if kind == "binary":
        return f"$table->binary({name})"
    if kind in ("json", "array"):
        jsonb = context["settings"]["database"] == "postgresql" and re.search(
            "jsonb", column_type["sql"], re.IGNORECASE
        )
        return f"$table->{'jsonb' if jsonb else 'json'}({name})"
    if kind == "enum":
        item = next((item for item in context["schema"]["enums"] if item["name"] == column_type["name"]), None)
        values = item["values"] if item else []
        # An enum of PostgreSQL is a type of its own: the column becomes it once the table exists
        if native_enum and context["settings"]["database"] != "postgresql":
            return f"$table->enum({name}, [{', '.join(php_string(value) for value in values)}])"
        return f"$table->string({name})"
    return f"$table->string({name})"


def _column_modifiers(column: dict) -> str:
    calls = []
    generated = column.get("generated")
    default = column.get("default")
    if column["nullable"]:
        calls.append("->nullable()")
    if generated == "now":
        calls.append("->useCurrent()")
    elif generated == "onUpdateNow":
        calls.extend(["->useCurrent()", "->useCurrentOnUpdate()"])
    elif isinstance(generated, dict):
        calls.append(f"->storedAs({php_string(generated['computed'])})")
    elif default and default["kind"] == "literal":
        calls.append(f"->default({php_literal(default['value'])})")
    elif default and default["kind"] == "expression":
        calls.append(f"->default(new Expression({php_string(default['sql'])}))")
    if column.get("comment"):
        calls.append(f"->comment({php_string(column['comment'])})")
    return "".join(calls)


def _creation_order(context: dict) -> list[dict]:
    """Parents first, so every foreign key points to a table that exists (a cycle keeps the schema's order)."""
    done: list[dict] = []
    visiting: set[str] = set()

    def visit(info: dict) -> None:
        if any(item is info for item in done) or info["name"] in visiting:
            return
        visiting.add(info["name"])
        for key in info["table"]["foreignKeys"]:
            parent = find_info(context, key["references"]["table"])
            if parent and parent is not info:
                visit(parent)
        visiting.discard(info["name"])
        done.append(info)

    for info in context["tables"]:
        visit(info)
    return done


def _table_name(table: dict) -> str:
    return f"{table['schema']}.{table['name']}" if table.get("schema") else table["name"]


def _names(items: list[str]) -> str:
    return "[" + ", ".join(php_string(item) for item in items) + "]"


def _create_table(context: dict, info: dict, uses: PhpUses) -> list[str]:
    table = info["table"]
    database = context["settings"]["database"]
    enums = {item["name"] for item in context["schema"]["enums"] if item.get("storage") == "native"}

    def native(column: dict) -> bool:
        return column["type"]["kind"] == "enum" and column["type"]["name"] in enums and database != "sqlite"

    # A column of an enum of PostgreSQL takes its default once it has its type (the text default cannot be cast)
    def pg_enum(column: dict) -> bool:
        return native(column) and database == "postgresql"

    result = []
    for column in table["columns"]:
        if (column.get("default") or {}).get("kind") == "expression":
            uses.add("Illuminate\\Database\\Query\\Expression")
        if column.get("generated") == "identity" and not _single_key_is(table, column["name"]):
            result.append(
                "// TODO: the database numbers this column; the schema builder numbers only a key of one column"
            )
        modifiers = _column_modifiers({**column, "default": None} if pg_enum(column) else column)
        result.append(f"{_column_call(context, table, column, native(column))}{modifiers};")
    key = table["primaryKey"]
    identity_key = False
    if key is not None and len(key) == 1:
        first = next((column for column in table["columns"] if column["name"] == key[0]), None)
        identity_key = bool(first and first.get("generated") == "identity")
    if key is not None and not identity_key:
        result.append(f"$table->primary({_names(key)});")
    for unique in table["uniques"]:
        name = f", {php_string(unique['name'])}" if unique.get("name") else ""
        result.append(f"$table->unique({_names(unique['columns'])}{name});")
    for index in table["indexes"]:
        name = f", {php_string(index['name'])}" if index.get("name") else ""
        result.append(f"$table->index({_names(index['columns'])}{name});")
    for foreign in table["foreignKeys"]:
        parent = find_info(context, foreign["references"]["table"])
        if not parent:
            continue
        name = f", {php_string(foreign['name'])}" if foreign.get("name") else ""
        on_delete = f"->onDelete({php_string(ACTIONS[foreign['onDelete']])})" if foreign.get("onDelete") else ""
        result.append(
            f"$table->foreign({_names(foreign['columns'])}{name})->references({_names(foreign['references']['columns'])})"
            f"->on({php_string(_table_name(parent['table']))}){on_delete};"
        )
    for check in table["checks"]:
        result.append(f"// CHECK ({check['sql']}): the schema builder has no CHECK constraints")
    qualified = f'"{table["schema"]}"."{table["name"]}"' if table.get("schema") else f'"{table["name"]}"'
    after = []
    for column in table["columns"]:
        if not pg_enum(column):
            continue
        type_name = column["type"]["name"]
        alter = f'ALTER TABLE {qualified} ALTER COLUMN "{column["name"]}"'
        statements = [f'{alter} TYPE "{type_name}" USING "{column["name"]}"::"{type_name}"']
        default = column.get("default")
        if default and default["kind"] == "literal" and default["value"] is not None:
            value = _text(default["value"]).replace("'", "''")
            statements.append(f"{alter} SET DEFAULT '{value}'")
        elif default and default["kind"] == "expression":
            statements.append(f"{alter} SET DEFAULT {default['sql']}")
        after.extend(f"$schema->getConnection()->statement({php_string(sql)});" for sql in statements)
    return [
        f"$schema->create({php_string(_table_name(table))}, function (Blueprint $table): void {{",
        *(f"    {line}" for line in result),
        "});",
        *after,
    ]


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _quote(text: str) -> str:
    escaped = text.replace("'", "''")
    return f"'{escaped}'"


def _test_database(context: dict) -> list[dict]:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    uses = PhpUses(TESTS_NS).add(
        f"{context['base']}\\Database",
        f"{context['base']}\\SqlUnitOfWork",
        "Illuminate\\Database\\Schema\\Blueprint",
        "Illuminate\\Database\\Schema\\Builder",
    )
    enums = (
        [item for item in context["schema"]["enums"] if item.get("storage") == "native"]
        if database == "postgresql"
        else []
    )
    tables = []
    for index, info in enumerate(_creation_order(context)):
        if index > 0:
            tables.append("")
        tables.extend(_create_table(context, info, uses))
    if sqlite:
        doc = "/** The test database: TEST_DATABASE_URL, or SQLite in memory, with every table created empty for every test. */"
        opening = ["        $db = Database::open(self::url() ?? 'sqlite:///:memory:');"]
    else:
        doc = (
            f"/** The test database: the {NAMES[database]} database TEST_DATABASE_URL names, with every table created "
            "empty for every test. */"
        )
        message = php_string(
            f"The database tests need a disposable {NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)"
        )
        opening = [
            "        // The tables are written for one kind of database: the tests cannot fall back to SQLite",
            f"        $db = Database::open(self::url() ?? throw new \\RuntimeException({message}));",
        ]
    types = []
    for item in enums:
        values = ", ".join(_quote(value) for value in item["values"])
        create = php_string('CREATE TYPE "' + item["name"] + '" AS ENUM (' + values + ")")
        types.append(f"        $db->statement({create});")
    namespaces = schemas_of(context)
    schemas = ["        // The schemas the tables are in, emptied and created again"] if namespaces else []
    for name in namespaces:
        drop = php_string('DROP SCHEMA IF EXISTS "' + name + '" CASCADE')
        create = php_string('CREATE SCHEMA "' + name + '"')
        schemas.extend([f"        $db->statement({drop});", f"        $db->statement({create});"])
    files = [
        test_file(
            "TestDatabase",
            uses,
            [
                doc,
                "final class TestDatabase",
                "{",
                "    public static function url(): ?string",
                "    {",
                "        $url = getenv('TEST_DATABASE_URL');",
                "        return is_string($url) && $url !== '' ? $url : null;",
                "    }",
                "",
                "    /** The repositories over the test database, with every table dropped and created again. */",
                "    public static function open(): SqlUnitOfWork",
                "    {",
                *opening,
                "        $schema = $db->getSchemaBuilder();",
                "        $schema->dropAllTables();",
                *schemas,
                *(["        $schema->dropAllTypes();"] if enums else []),
                *types,
                "        self::createTables($schema);",
                "        return new SqlUnitOfWork($db);",
                "    }",
                "",
                "    /** Every table as the database has it, parents first. */",
                "    private static function createTables(Builder $schema): void",
                "    {",
                *("" if line == "" else f"        {line}" for line in tables),
                "    }",
                "}",
            ],
        )
    ]
    if database == "postgresql":
        sql = "SELECT current_database() AS name"
    elif sqlite:
        sql = "SELECT sqlite_version() AS name"
    else:
        sql = "SELECT DATABASE() AS name"
    files.append(
        test_file(
            "DatabaseTest",
            PhpUses(TESTS_NS).add("PHPUnit\\Framework\\TestCase"),
            [
                "/** The tests run on the database they were asked to. */",
                "final class DatabaseTest extends TestCase",
                "{",
                "    public function testIsSqlite(): void"
                if sqlite
                else "    public function testIsTheOneTestDatabaseUrlNames(): void",
                "    {",
                "        $db = TestDatabase::open()->db;",
                f"        $name = $db->selectOne({php_string(sql)})->name;",
                "        self::assertStringStartsWith('3.', $name);"
                if sqlite
                else "        self::assertSame($db->getDatabaseName(), $name);",
                "        $db->disconnect();",
                "    }",
                "}",
            ],
        )
    )
    return files


ELOQUENT_ORM = {
    "id": "eloquent",
    "label": "Eloquent 12",
    "property": lambda column: column["name"],
    "phpType": eloquent_php_type,
    "entityFile": eloquent_model_file,
    "databaseFiles": lambda context: [_database_file(context)],
    "repository": {
        "doc": lambda context: "through its Eloquent model and the query builder, by every column of its key.",
        "init": lambda context, info, uses: [],
        "body": _body,
        "helpers": _helpers,
    },
    "unitOfWork": _unit_of_work,
    "forget": lambda uow: None,
    "begin": lambda uow: f"{uow}->db->beginTransaction()",
    "close": lambda uow: f"{uow}->db->disconnect()",
    "testDatabase": _test_database,
    "require": lambda context: {
        f"ext-{DRIVERS.get(context['settings']['database'], 'pdo_pgsql')}": "*",
        "illuminate/database": "^12.0",
    },
    "defaultUrl": _url,
    "layout": lambda context: ["src/Database.php             the connection of DATABASE_URL, which the models use"],
}
