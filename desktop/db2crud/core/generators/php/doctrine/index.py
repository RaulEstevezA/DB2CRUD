"""Doctrine ORM 3 (over DBAL 4) as a PHP ORM strategy (common/orm.py): attribute-mapped entities, an EntityManager
opened from DATABASE_URL, repositories with the QueryBuilder that store every write at once (flush), the transaction
of each operation on the connection, and tests whose database SchemaTool creates from the mapping. Mirrors
web/src/core/generators/php/doctrine/index.ts."""

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
from ..common.php import PhpUses, field_name, php_string
from ..common.repositories import uuid_fills
from ..common.support import repository_assignments, repository_properties
from ..common.tests import TESTS_NS, schemas_of, test_file
from .entities import doctrine_entity_file, doctrine_php_type, id_columns, pg_enums, quoted
from .types import PRECISE_TYPES, type_files, types_namespace, uses_precise_types

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
    precise = uses_precise_types(context)
    uses = PhpUses(context["base"]).add(
        "Doctrine\\DBAL\\DriverManager",
        "Doctrine\\DBAL\\Tools\\DsnParser",
        "Doctrine\\ORM\\EntityManager",
        "Doctrine\\ORM\\ORMSetup",
    )
    registration = []
    if precise:
        uses.add("Doctrine\\DBAL\\Types\\Type")
        registration.append("        // The timestamps of the entities keep their fractions of a second")
        for item in PRECISE_TYPES:
            uses.add(class_name(types_namespace(context), item["name"]))
            registration.extend(
                [
                    f"        if (!Type::hasType({item['name']}::NAME)) {{",
                    f"            Type::addType({item['name']}::NAME, {item['name']}::class);",
                    "        }",
                ]
            )
    return php_file(
        path_of(context["base"], "Database"),
        context["base"],
        uses.write(),
        [
            "/** The database DATABASE_URL names, through Doctrine. It never migrates: the database already exists. */",
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
            "    /** An EntityManager over the database at $url (DATABASE_URL when null), with the mapping of the entities. */",
            "    public static function open(?string $url = null): EntityManager",
            "    {",
            *registration,
            "        // The mapping is read from the attributes of the classes under src/",
            "        $config = ORMSetup::createAttributeMetadataConfiguration([__DIR__], true);",
            "        $config->enableNativeLazyObjects(true);",
            "        $parser = new DsnParser(['postgresql' => 'pdo_pgsql', 'postgres' => 'pdo_pgsql', 'mysql' => 'pdo_mysql', "
            "'mariadb' => 'pdo_mysql', 'sqlite' => 'pdo_sqlite']);",
            "        $connection = DriverManager::getConnection($parser->parse($url ?? self::url()), $config);",
            "        return new EntityManager($connection, $config);",
            "    }",
            "}",
        ],
    )


# Repositories


def _soft_condition(info: dict) -> str | None:
    """A condition that leaves out rows marked as deleted."""
    if not info["soft"]:
        return None
    target = f"e.{info['soft']['prop']}"
    if info["soft"]["column"]["type"]["kind"] == "boolean":
        return f"({target} = false OR {target} IS NULL)"
    return f"{target} IS NULL"


def _order_by(info: dict) -> list[str]:
    return [
        f"->{'orderBy' if index == 0 else 'addOrderBy'}('e.{column['prop']}')"
        for index, column in enumerate(info["key"])
    ]


def _select_lines(info: dict, columns: list[dict]) -> list[str]:
    """->select('e')->from(...) with the conditions and their parameters."""
    conditions = [f"e.{column['prop']} = :p{index}" for index, column in enumerate(columns)]
    soft = _soft_condition(info)
    if soft is not None:
        conditions.append(soft)
    return [
        "->select('e')",
        f"->from({info['entity']}::class, 'e')",
        *(
            f"->{'where' if index == 0 else 'andWhere'}({php_string(condition)})"
            for index, condition in enumerate(conditions)
        ),
        *(f"->setParameter('p{index}', ${column['field']})" for index, column in enumerate(columns)),
    ]


def _chain(start: str, calls: list[str]) -> list[str]:
    """A statement of chained calls, one per line."""
    return [start, *(f"    {call}{';' if index == len(calls) - 1 else ''}" for index, call in enumerate(calls))]


def _body(context: dict, info: dict, method: dict, uses: PhpUses) -> list:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    qb = "$this->em->createQueryBuilder()"
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return _chain(f"return {qb}", [*_select_lines(info, columns), "->getQuery()", "->getOneOrNullResult()"])
    if kind in ("listByParent", "findAllBy"):
        return _chain(
            f"return {qb}", [*_select_lines(info, columns), *_order_by(info), "->getQuery()", "->getResult()"]
        )
    if kind == "list":
        if paging == "offset":
            first = id_columns(info)[0]["prop"]
            return [
                *_chain(f"$query = {qb}", _select_lines(info, [])),
                f"$total = (int) (clone $query)->select('COUNT(e.{first})')->getQuery()->getSingleScalarResult();",
                *_chain(
                    "$items = $query",
                    [
                        *_order_by(info),
                        "->setFirstResult($offset)",
                        "->setMaxResults($limit)",
                        "->getQuery()",
                        "->getResult()",
                    ],
                ),
                "return new Page($items, $total, $offset, $limit);",
            ]
        if paging == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            key = info["key"]
            terms = []
            for index, column in enumerate(key):
                parts = [f"e.{before['prop']} = :k{position}" for position, before in enumerate(key[:index])]
                parts.append(f"e.{column['prop']} > :k{index}")
                term = " AND ".join(parts)
                terms.append(f"({term})" if len(key) > 1 else term)
            after = " OR ".join(terms)
            last = ", ".join(f"$items[$limit - 1]->{column['prop']}" for column in key)
            return [
                *_chain(f"$query = {qb}", _select_lines(info, [])),
                "if ($after !== null) {",
                f"    $query->andWhere({php_string(after)})",
                *(
                    f"        ->setParameter('k{index}', $after[{index}]){';' if index == len(key) - 1 else ''}"
                    for index in range(len(key))
                ),
                "}",
                *_chain(
                    "$rows = $query", [*_order_by(info), "->setMaxResults($limit + 1)", "->getQuery()", "->getResult()"]
                ),
                "$items = array_slice($rows, 0, $limit);",
                f"return new CursorPage($items, count($rows) > $limit ? [{last}] : null);",
            ]
        return _chain(f"return {qb}", [*_select_lines(info, []), *_order_by(info), "->getQuery()", "->getResult()"])
    if kind == "insert":
        return [*uuid_fills(context, info, uses), "$this->em->persist($entity);", "$this->flush();", "return $entity;"]
    if kind == "update":
        return ["$this->flush();", "return $entity;"]
    if kind == "delete":
        return ["$this->em->remove($entity);", "$this->flush();"]
    return ["throw new \\LogicException('not supported');"]


def _helpers(context: dict, info: dict, uses: PhpUses) -> list:
    if not any(item["kind"] in ("insert", "update", "delete") for item in info["queries"]):
        return []
    uses.add("Doctrine\\DBAL\\Exception\\ConstraintViolationException", error_class(context, "ConflictException"))
    return [
        "    /**",
        "     * Stores the pending changes; a database refusal (a unique value, a row still pointed to) becomes a "
        "ConflictException.",
        "     * Doctrine closes the EntityManager when the database refuses a change: open another one to go on.",
        "     */",
        "    private function flush(): void",
        "    {",
        "        try {",
        "            $this->em->flush();",
        "        } catch (ConstraintViolationException $error) {",
        f"            throw new ConflictException({php_string(info['entity'])}, 'the database refused the change: ' . "
        "$error->getMessage());",
        "        }",
        "    }",
    ]


def _unit_of_work(context: dict, uses: PhpUses) -> list:
    uses.add("Doctrine\\ORM\\EntityManagerInterface")
    properties = repository_properties(context, uses, lambda info: info["attr"])
    for info in context["tables"]:
        uses.add(class_name(namespace_of(context, info, "repository"), sql_repository_class(info)))
    if context["settings"]["transactions"] == "operation":
        transaction = [
            "        $connection = $this->em->getConnection();",
            "        // Joins the transaction already open",
            "        if ($connection->isTransactionActive()) {",
            "            return $work($this);",
            "        }",
            "        $connection->beginTransaction();",
            "        try {",
            "            $result = $work($this);",
            "            $this->em->flush();",
            "            $connection->commit();",
            "            return $result;",
            "        } catch (\\Throwable $error) {",
            "            $connection->rollBack();",
            "            $this->em->clear();",
            "            throw $error;",
            "        }",
        ]
    else:
        transaction = ["        return $work($this);"]
    return [
        "/** The repositories over one EntityManager, and the transaction of its connection. */",
        "final class SqlUnitOfWork implements UnitOfWork",
        "{",
        *ind(properties, 4),
        "",
        "    public function __construct(public readonly EntityManagerInterface $em)",
        "    {",
        *ind(repository_assignments(context, lambda info: f"new {sql_repository_class(info)}($em)"), 8),
        "    }",
        "",
        "    public function transaction(callable $work): mixed",
        "    {",
        *transaction,
        "    }",
        "}",
    ]


# Tests

NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}

ACTIONS = {
    "cascade": "CASCADE",
    "set null": "SET NULL",
    "set default": "SET DEFAULT",
    "restrict": "RESTRICT",
    "no action": "NO ACTION",
}


def _table_name(info: dict) -> str:
    schema = info["table"].get("schema")
    return f"{schema}.{info['name']}" if schema else info["name"]


def _list(names: list[str]) -> str:
    return "[" + ", ".join(php_string(quoted(name)) for name in names) + "]"


def _quote(text: str) -> str:
    escaped = text.replace("'", "''")
    return f"'{escaped}'"


def _test_database(context: dict) -> list[dict]:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    uses = PhpUses(TESTS_NS).add(
        f"{context['base']}\\Database", f"{context['base']}\\SqlUnitOfWork", "Doctrine\\ORM\\Tools\\SchemaTool"
    )
    enums = pg_enums(context)
    additions = []
    for info in context["tables"]:
        for key in info["table"]["foreignKeys"]:
            parent = find_info(context, key["references"]["table"])
            if not parent:
                continue
            options = f"['onDelete' => {php_string(ACTIONS[key['onDelete']])}]" if key.get("onDelete") else "[]"
            name = f", {php_string(key['name'])}" if key.get("name") else ""
            additions.append(
                f"$schema->getTable({php_string(_table_name(info))})->addForeignKeyConstraint({php_string(_table_name(parent))}, "
                f"{_list(key['columns'])}, {_list(key['references']['columns'])}, {options}{name});"
            )
        if info["table"]["primaryKey"] is None:
            additions.append(f"$schema->getTable({php_string(_table_name(info))})->dropPrimaryKey();")
    if sqlite:
        opening = ["        $em = Database::open(self::url() ?? 'sqlite:///:memory:');"]
        doc = "/** The test database: TEST_DATABASE_URL, or SQLite in memory, created empty from the mapping for every test. */"
    else:
        message = php_string(
            f"The database tests need a disposable {NAMES[database]} database: set TEST_DATABASE_URL (it is emptied)"
        )
        opening = [
            "        // The mapping is written for one kind of database: the tests cannot fall back to SQLite",
            f"        $em = Database::open(self::url() ?? throw new \\RuntimeException({message}));",
        ]
        doc = (
            f"/** The test database: the {NAMES[database]} database TEST_DATABASE_URL names, created empty from the "
            "mapping for every test. */"
        )
    namespaces = schemas_of(context)
    drops = ["        // The schemas the tables are in go too: the mapping creates them again"] if namespaces else []
    for name in namespaces:
        statement = php_string('DROP SCHEMA IF EXISTS "' + name + '" CASCADE')
        drops.append(f"        $connection->executeStatement({statement});")
    if enums:
        drops.append(
            "        // DBAL cannot read a column of an enum type: the types go first, and their columns with them"
        )
    creates = []
    for item in enums:
        values = ", ".join(_quote(value) for value in item["values"])
        drop = php_string('DROP TYPE IF EXISTS "' + item["name"] + '" CASCADE')
        create = php_string('CREATE TYPE "' + item["name"] + '" AS ENUM (' + values + ")")
        drops.append(f"        $connection->executeStatement({drop});")
        creates.append(f"        $connection->executeStatement({create});")
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
                "        $connection = $em->getConnection();",
                "        $tool = new SchemaTool($em);",
                *drops,
                "        $tool->dropDatabase();",
                *creates,
                "        $schema = $tool->getSchemaFromMetadata($em->getMetadataFactory()->getAllMetadata());",
                *(
                    [
                        "        // What the mapping does not say: the foreign keys, and the tables that have no primary key",
                        *(f"        {line}" for line in additions),
                    ]
                    if additions
                    else []
                ),
                "        foreach ($schema->toSql($connection->getDatabasePlatform()) as $sql) {",
                "            $connection->executeStatement($sql);",
                "        }",
                "        return new SqlUnitOfWork($em);",
                "    }",
                "}",
            ],
        )
    ]
    if database == "postgresql":
        sql = "SELECT current_database()"
    elif sqlite:
        sql = "SELECT sqlite_version()"
    else:
        sql = "SELECT DATABASE()"
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
                "        $connection = TestDatabase::open()->em->getConnection();",
                f"        self::assertStringStartsWith('3.', (string) $connection->fetchOne({php_string(sql)}));"
                if sqlite
                else f"        self::assertSame($connection->getDatabase(), $connection->fetchOne({php_string(sql)}));",
                "        $connection->close();",
                "    }",
                "}",
            ],
        )
    )
    return files


def _init(context: dict, info: dict, uses: PhpUses) -> list[str]:
    uses.add("Doctrine\\ORM\\EntityManagerInterface")
    return ["    public function __construct(private readonly EntityManagerInterface $em)", "    {", "    }"]


DOCTRINE_ORM = {
    "id": "doctrine",
    "label": "Doctrine ORM 3",
    "property": lambda column: field_name(column["name"]),
    "phpType": doctrine_php_type,
    "entityFile": doctrine_entity_file,
    "databaseFiles": lambda context: [_database_file(context), *type_files(context)],
    "repository": {
        "doc": lambda context: "through Doctrine's EntityManager; every write is flushed at once.",
        "init": _init,
        "body": _body,
        "helpers": _helpers,
    },
    "unitOfWork": _unit_of_work,
    "forget": lambda uow: f"{uow}->em->clear();",
    "begin": lambda uow: f"{uow}->em->getConnection()->beginTransaction()",
    "close": lambda uow: f"{uow}->em->getConnection()->close()",
    "testDatabase": _test_database,
    "require": lambda context: {
        f"ext-{DRIVERS.get(context['settings']['database'], 'pdo_pgsql')}": "*",
        "doctrine/dbal": "^4.3",
        "doctrine/orm": "^3.5",
        "symfony/cache": "^7.3 || ^8.0",
    },
    "defaultUrl": _url,
    "layout": lambda context: [
        "src/Database.php             the EntityManager of DATABASE_URL, with the mapping of the entities"
    ],
}
