"""The tests of a generated Java project, which are also what the verification runs (JUnit): factories that build valid
rows (and their parents first), repository tests against a real database created from the entities, and service tests
on the in-memory unit of work (or on the database when the project has no memory repositories). The database is SQLite
in a file of target/ unless TEST_DATABASE_URL names another. Mirrors web/src/core/generators/java/tests.ts."""

from ..types import lines
from .context import (
    column_of,
    common_package,
    errors_package,
    find_info,
    is_in,
    operation_name,
    qualified,
    query,
    query_name,
    service_class,
    writes_entities,
)
from .dtos import accessor, create_columns, create_dto, update_columns, update_package, update_type
from .entities import enum_types
from .java import JavaImports, java_path, java_string
from .samples import missing_value, sample_imports, sample_value


def _is_nullable_key(info: dict, key: dict) -> bool:
    return all(column_of(info, name)["column"]["nullable"] for name in key["columns"])


def _can_make(context: dict, info: dict, seen: frozenset = frozenset()) -> bool:
    """Tables whose rows the tests can make: they can be inserted, and so can the parents they need."""
    if info["name"] in seen or not query(info, "insert"):
        return False
    following = seen | {info["name"]}
    for key in info["table"]["foreignKeys"]:
        if _is_nullable_key(info, key):
            continue
        parent = find_info(context, key["references"]["table"])
        if parent is None or not _can_make(context, parent, following):
            return False
    return True


def _new_name(info: dict) -> str:
    return f"new{info['entity']}"


def _add_name(info: dict) -> str:
    return f"add{info['entity']}"


# Factories


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    pkg = context["base"]
    imports = JavaImports(pkg)
    blocks = []
    for info in makeable:
        imports.add(qualified(context, info, "entity", info["entity"]))
        parents = []
        from_parents = []
        parent_columns = set()
        for index, key in enumerate(info["table"]["foreignKeys"]):
            parent = find_info(context, key["references"]["table"])
            if _is_nullable_key(info, key) or not parent:
                continue
            imports.add(qualified(context, parent, "entity", parent["entity"]))
            parents.append(f"        {parent['entity']} parent{index} = {_add_name(parent)}(uow, n);")
            for position, column in enumerate(key["columns"]):
                parent_columns.add(column)
                referenced = column_of(parent, key["references"]["columns"][position])["getter"]
                from_parents.append(
                    f"        entity.{column_of(info, column)['setter']}(parent{index}.{referenced}());"
                )
        values = []
        for column in info["columns"]:
            if column["generated"] or column["column"]["name"] in parent_columns:
                continue
            is_key = any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            if column is info["soft"]:
                if column["column"]["type"]["kind"] == "boolean":
                    values.append(f"        entity.{column['setter']}(false);")
                continue
            if column["column"]["nullable"] and is_key:
                continue
            for name in sample_imports(column):
                imports.add(name)
            value = sample_value(column, info["table"]["checks"], context["schema"]["enums"])
            values.append(f"        entity.{column['setter']}({value});")
        insert = query(info, "insert")
        entity = info["entity"]
        blocks.append(
            [
                f"    /** A valid {entity} that is not stored yet; n makes its unique values differ. */",
                f"    static {entity} {_new_name(info)}(int n) {{",
                f"        {entity} entity = new {entity}();",
                *values,
                "        return entity;",
                "    }",
                "",
                f"    /** A stored {entity}{', with the rows it points to' if parents else ''}. */",
                f"    static {entity} {_add_name(info)}(UnitOfWork uow, int n) {{",
                *parents,
                f"        {entity} entity = {_new_name(info)}(n);",
                *from_parents,
                f"        return uow.{info['attr']}().{query_name(context, insert)}(entity);",
                "    }",
            ]
        )
    content = lines(
        f"package {pkg};",
        "",
        imports.write(),
        "",
        "/** Rows for the tests: valid values for every column, and the rows they point to. */",
        "final class Factories {",
        "    private Factories() {}",
        *[line for block in blocks for line in ("", *block)],
        "}",
        "",
    )
    return {"path": java_path(pkg, "Factories", True), "content": content}


# The test database

NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _test_database_file(context: dict) -> dict:
    pkg = context["base"]
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    types = enum_types(context)
    imports = JavaImports(pkg).add("jakarta.persistence.EntityManager", "jakarta.persistence.EntityManagerFactory")
    if types:
        imports.add("java.sql.Connection", "java.sql.DriverManager", "java.sql.SQLException", "java.sql.Statement")
    if sqlite:
        doc = "/** The test database: TEST_DATABASE_URL, or SQLite in a file of target/, created from the entities before every test. */"
        url = '    static final String URL = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:sqlite:target/test.db?foreign_keys=true");'
    else:
        doc = "/** The test database: the one TEST_DATABASE_URL names (with TEST_DATABASE_USER and TEST_DATABASE_PASSWORD), created from the entities before every test. */"
        url = [
            "    // The entities are written for one kind of database: the tests cannot fall back to SQLite",
            '    static final String URL = System.getenv("TEST_DATABASE_URL");',
        ]
    statements = [
        f"            statement.execute({java_string(f'DO $$ BEGIN {sql}; EXCEPTION WHEN duplicate_object THEN NULL; END $$')});"
        for sql in types
    ]
    content = lines(
        f"package {pkg};",
        "",
        imports.write(),
        "",
        doc,
        "final class TestDatabase {",
        url,
        '    static final String USER = System.getenv("TEST_DATABASE_USER");',
        '    static final String PASSWORD = System.getenv("TEST_DATABASE_PASSWORD");',
        "",
        "    private static EntityManagerFactory factory;",
        "",
        "    private TestDatabase() {}",
        "",
        "    /** An EntityManager over the test database, with every table dropped and created again from the entities. */",
        "    static synchronized EntityManager open() {",
        not sqlite
        and [
            "        if (URL == null)",
            f'            throw new IllegalStateException("The database tests need a disposable {NAMES.get(database)} database: set TEST_DATABASE_URL (it is emptied)");',
        ],
        "        if (factory == null) {",
        bool(types) and "            createTypes();",
        "            factory = Database.configuration(URL, USER, PASSWORD).createEntityManagerFactory();",
        "        }",
        "        factory.getSchemaManager().drop(true);",
        "        factory.getSchemaManager().create(true);",
        "        return factory.createEntityManager();",
        "    }",
        bool(types)
        and [
            "",
            "    /** The enum types of the database the entities use, which Hibernate does not create. */",
            "    private static void createTypes() {",
            "        try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD); Statement statement = connection.createStatement()) {",
            *statements,
            "        } catch (SQLException error) {",
            "            throw new IllegalStateException(error);",
            "        }",
            "    }",
        ],
        "}",
        "",
    )
    return {"path": java_path(pkg, "TestDatabase", True), "content": content}


def _database_test_file(context: dict) -> dict:
    pkg = context["base"]
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    if database == "postgresql":
        sql = "SELECT current_database()"
    elif sqlite:
        sql = "SELECT sqlite_version()"
    else:
        sql = "SELECT DATABASE()"
    content = lines(
        f"package {pkg};",
        "",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        sqlite and "import static org.junit.jupiter.api.Assertions.assertTrue;",
        "",
        "import jakarta.persistence.EntityManager;",
        not sqlite and "import java.net.URI;",
        "import org.junit.jupiter.api.Test;",
        "",
        "/** The tests run on the database they were asked to. */",
        "class DatabaseTest {",
        "    @Test",
        "    void isSqlite() {" if sqlite else "    void isTheOneTestDatabaseUrlNames() {",
        "        EntityManager entityManager = TestDatabase.open();",
        f"        Object result = entityManager.createNativeQuery({java_string(sql)}).getSingleResult();",
        "        entityManager.close();",
        '        assertTrue(String.valueOf(result).startsWith("3."));'
        if sqlite
        else '        assertEquals(URI.create(TestDatabase.URL.substring("jdbc:".length())).getPath().substring(1), String.valueOf(result));',
        "    }",
        "}",
        "",
    )
    return {"path": java_path(pkg, "DatabaseTest", True), "content": content}


# Tests of each table


def _changeable_text(info: dict) -> dict | None:
    """A text column the tests can change and read back, when the table has one."""
    for column in update_columns(info):
        column_type = column["column"]["type"]
        name = column["column"]["name"]
        length = column_type.get("length")
        if (
            column_type["kind"] == "text"
            and not column_type.get("fixed")
            and name not in info["hidden"]
            and (40 if length is None else length) >= 7
            and not any((check.get("parsed") or {}).get("column") == name for check in info["table"]["checks"])
            and not any(name in unique["columns"] for unique in info["table"]["uniques"])
            and not any(name in key["columns"] for key in info["table"]["foreignKeys"])
        ):
            return column
    return None


def _flat(body: list) -> list:
    result = []
    for item in body:
        if isinstance(item, list):
            result += item
        else:
            result.append(item)
    return result


def _test(name: str, body: list) -> list:
    return [
        "",
        "        @Test",
        f"        void {name}() {{",
        *((f"            {line}" if isinstance(line, str) else line) for line in _flat(body)),
        "        }",
    ]


def _repository_tests(context: dict, info: dict) -> list[list]:
    repo = f"uow.{info['attr']}()"
    entity = info["entity"]

    def key_of(variable: str) -> str:
        return ", ".join(f"{variable}.{column['getter']}()" for column in info["key"])

    get_by_key = query(info, "getByKey")
    listing = query(info, "list")
    tests = []
    stored = f"{entity} stored = Factories.{_add_name(info)}(uow, 1);"
    uniques = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        if read:
            args = ", ".join(f"stored.{column_of(info, name)['getter']}()" for name in read["columns"])
            uniques.append(f"assertTrue({repo}.{query_name(context, read)}({args}).isPresent());")
    parents = []
    for key in info["table"]["foreignKeys"]:
        read = query(info, "listByParent", key["columns"])
        if read:
            args = [f"stored.{column_of(info, name)['getter']}()" for name in read["columns"]]
            condition = " && ".join(f"{arg} != null" for arg in args)
            parents.append(
                f"if ({condition}) assertEquals(1, {repo}.{query_name(context, read)}({', '.join(args)}).size());"
            )
    tests.append(
        _test(
            "isStoredAndReadBack",
            [
                stored,
                "uow.entityManager().clear();",
                bool(get_by_key)
                and [
                    f"{entity} found = {repo}.{query_name(context, get_by_key)}({key_of('stored')}).orElseThrow();",
                    *(
                        f"assertEquals(stored.{column['getter']}(), found.{column['getter']}());"
                        for column in info["key"]
                    ),
                ],
                *uniques,
                *parents,
            ],
        )
    )
    if listing:
        name = query_name(context, listing)
        paging = context["settings"]["paging"]
        if paging == "offset":
            checks = [
                f"var page = {repo}.{name}(0, 1);",
                "assertEquals(2, page.total());",
                "assertEquals(1, page.items().size());",
            ]
        elif paging == "cursor":
            checks = [
                f"var first = {repo}.{name}(null, 1);",
                "assertEquals(1, first.items().size());",
                "assertNotNull(first.next());",
                f"var second = {repo}.{name}(first.next(), 1);",
                "assertEquals(1, second.items().size());",
                "assertNull(second.next());",
            ]
        else:
            checks = [f"assertEquals(2, {repo}.{name}().size());"]
        tests.append(
            _test(
                "listsRowsByKey",
                [f"Factories.{_add_name(info)}(uow, 1);", f"Factories.{_add_name(info)}(uow, 2);", checks],
            )
        )
    update = query(info, "update")
    text = _changeable_text(info)
    if update and get_by_key and text:
        tests.append(
            _test(
                "storesTheChanges",
                [
                    stored,
                    f'stored.{text["setter"]}("changed");',
                    f"{repo}.{query_name(context, update)}(stored);",
                    "uow.entityManager().clear();",
                    f'assertEquals("changed", {repo}.{query_name(context, get_by_key)}({key_of("stored")}).orElseThrow().{text["getter"]}());',
                ],
            )
        )
    remove = query(info, "delete")
    if remove and get_by_key and not info["soft"]:
        tests.append(
            _test(
                "isDeleted",
                [
                    stored,
                    f"{repo}.{query_name(context, remove)}(stored);",
                    f"assertTrue({repo}.{query_name(context, get_by_key)}({key_of('stored')}).isEmpty());",
                ],
            )
        )
    return tests


def _service_tests(context: dict, info: dict, imports: JavaImports) -> list[list]:
    service = service_class(info)
    imports.add(qualified(context, info, "service", service))
    dtos = context["settings"]["serviceTypes"] == "dtos"
    record = context["settings"]["dtoKind"] != "class"
    updates = context["settings"]["updates"]
    ops = {operation["kind"] + ":" + ",".join(operation["columns"]): operation for operation in info["operations"]}

    def op(kind: str, columns: list[str] | None = None) -> dict | None:
        return ops.get(kind + ":" + ",".join(columns or []))

    create = op("create")
    get = op("get")
    update = op("update") if op("update") and query(info, "update") and query(info, "getByKey") else None
    remove = op("delete")
    entity = info["entity"]

    def value_of(variable: str, column: dict) -> str:
        """A value of a created row: an entity's getter, or a read DTO's accessor"""
        return f"{variable}.{accessor(context, column['prop'], record)}" if dtos else f"{variable}.{column['getter']}()"

    def key_of(variable: str) -> str:
        return ", ".join(value_of(variable, column) for column in info["key"])

    # Rows go in through the service (when it creates them) and the parents through the factories
    parents_first = []
    overrides = []
    for index, key in enumerate(info["table"]["foreignKeys"]):
        parent = find_info(context, key["references"]["table"])
        if not parent or not _can_make(context, parent):
            continue
        imports.add(qualified(context, parent, "entity", parent["entity"]))
        parents_first.append(f"{parent['entity']} parent{index} = Factories.{_add_name(parent)}(uow, n);")
        for position, column in enumerate(key["columns"]):
            referenced = column_of(parent, key["references"]["columns"][position])["getter"]
            overrides.append({"column": column, "value": f"parent{index}.{referenced}()"})
    start = ["int n = 1;", *parents_first]

    def row(variable: str, n: int, extra: list | None = None) -> list[str]:
        """A row from the factory with the parents' keys and the given values set"""
        extra = extra or []
        given = {item["column"] for item in extra}
        items = [item for item in overrides if item["column"] not in given] + extra
        return [
            f"{entity} {variable} = Factories.{_new_name(info)}({n});",
            *(f"{variable}.{column_of(info, item['column'])['setter']}({item['value']});" for item in items),
        ]

    def source(variable: str) -> str:
        return f"createOf({variable})" if dtos else variable

    def changes(target: dict, value: str, origin: str) -> str:
        """The changes of an update that sets one field, and keeps the others as the row has them"""
        imports.add(f"{update_package(context, info)}.{update_type(context, info)}")
        if updates == "patch":
            imports.add(f"{common_package(context)}.Patch")
        if updates == "optional":
            imports.add("java.util.Optional")
        fields = []
        for column in update_columns(info):
            if updates == "patch":
                fields.append(f"Patch.of({value})" if column is target else "Patch.absent()")
            elif updates == "optional":
                fields.append(f"Optional.of({value})" if column is target else "null")
            else:
                fields.append(value if column is target else f"{origin}.{column['getter']}()")
        return f"new {update_type(context, info)}({', '.join(fields)})"

    def version(variable: str) -> str:
        return f", {value_of(variable, info['version'])}" if info["version"] else ""

    tests = []
    opening = [f"{service} service = new {service}(uow);"]
    if create:
        name = operation_name(context, create)
        tests.append(
            _test(
                "createsAValidRow",
                [
                    *opening,
                    *start,
                    *row("row", 1),
                    f"var created = service.{name}({source('row')});",
                    bool(get)
                    and [
                        f"var found = service.{operation_name(context, get)}({key_of('created')});",
                        *(
                            f"assertEquals({value_of('created', column)}, {value_of('found', column)});"
                            for column in info["key"]
                        ),
                    ],
                ],
            )
        )
        required = next(
            (
                column
                for column in info["columns"]
                if column["required"]
                and not any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            ),
            None,
        )
        if required:
            imports.add(
                f"{errors_package(context)}.ValidationFailedException",
                f"{errors_package(context)}.FieldError",
                "java.util.List",
            )
            tests.append(
                _test(
                    "refusesAMissingValue",
                    [
                        *opening,
                        *start,
                        *row("row", 1, [{"column": required["column"]["name"], "value": "null"}]),
                        f"ValidationFailedException error = assertThrows(ValidationFailedException.class, () -> service.{name}({source('row')}));",
                        f"assertEquals(List.of({java_string(required['column']['name'])}), error.getErrors().stream().map(FieldError::field).toList());",
                    ],
                )
            )
        # A unique value the client gives: one the database fills is never sent
        unique = next(
            (
                item
                for item in info["table"]["uniques"]
                if query(info, "findByUnique", item["columns"])
                and all(not column_of(info, name)["generated"] for name in item["columns"])
            ),
            None,
        )
        if unique:
            imports.add(f"{errors_package(context)}.ConflictException")
            own = [column_of(info, column) for column in unique["columns"]]
            tests.append(
                _test(
                    "refusesARepeatedUniqueValue",
                    [
                        *opening,
                        *start,
                        *row("row", 1),
                        f"var first = service.{name}({source('row')});",
                        *row(
                            "again",
                            2,
                            [
                                {"column": column["column"]["name"], "value": value_of("first", column)}
                                for column in own
                            ],
                        ),
                        f"assertThrows(ConflictException.class, () -> service.{name}({source('again')}));",
                    ],
                )
            )
            # A row keeps its own unique value when it changes: the check must not take it for another row
            if (
                update
                and len(own) == 1
                and all(not is_in(column, info["key"]) and not column["generated"] for column in own)
            ):
                tests.append(
                    _test(
                        "keepsItsOwnUniqueValue",
                        [
                            *opening,
                            *start,
                            *row("row", 1),
                            f"var created = service.{name}({source('row')});",
                            f"service.{operation_name(context, update)}({key_of('created')}, {changes(own[0], value_of('created', own[0]), 'row')}{version('created')});",
                        ],
                    )
                )
        parent_key = next(
            (
                key
                for key in info["table"]["foreignKeys"]
                if (parent := find_info(context, key["references"]["table"]))
                and query(parent, "getByKey")
                and len(key["columns"]) == 1
            ),
            None,
        )
        if parent_key:
            imports.add(f"{errors_package(context)}.ValidationFailedException", f"{errors_package(context)}.FieldError")
            column = column_of(info, parent_key["columns"][0])
            for item in sample_imports(column):
                imports.add(item)
            tests.append(
                _test(
                    "refusesAMissingParent",
                    [
                        *opening,
                        *start,
                        *row("row", 1, [{"column": column["column"]["name"], "value": missing_value(column)}]),
                        f"ValidationFailedException error = assertThrows(ValidationFailedException.class, () -> service.{name}({source('row')}));",
                        f"assertTrue(error.getErrors().stream().map(FieldError::field).toList().contains({java_string(parent_key['columns'][0])}));",
                    ],
                )
            )
    if get:
        imports.add(f"{errors_package(context)}.NotFoundException")
        for column in info["key"]:
            for item in sample_imports(column):
                imports.add(item)
        missing = ", ".join(missing_value(column) for column in info["key"])
        tests.append(
            _test(
                "saysWhenARowIsMissing",
                [
                    *opening,
                    f"assertThrows(NotFoundException.class, () -> service.{operation_name(context, get)}({missing}));",
                ],
            )
        )
    text = _changeable_text(info)
    if create and update and text:
        tests.append(
            _test(
                "changesARow",
                [
                    *opening,
                    *start,
                    *row("row", 1),
                    f"var created = service.{operation_name(context, create)}({source('row')});",
                    f"var updated = service.{operation_name(context, update)}({key_of('created')}, {changes(text, chr(34) + 'changed' + chr(34), 'row')}{version('created')});",
                    f'assertEquals("changed", {value_of("updated", text)});',
                ],
            )
        )
    if create and remove and get:
        imports.add(f"{errors_package(context)}.NotFoundException")
        tests.append(
            _test(
                "deletesARow",
                [
                    *opening,
                    *start,
                    *row("row", 1),
                    f"var created = service.{operation_name(context, create)}({source('row')});",
                    f"service.{operation_name(context, remove)}({key_of('created')}{version('created')});",
                    f"assertThrows(NotFoundException.class, () -> service.{operation_name(context, get)}({key_of('created')}));",
                ],
            )
        )
    return tests


def _create_of_helper(context: dict, info: dict, imports: JavaImports) -> list[str]:
    """Builds a create DTO from a factory row: the values of its fields."""
    imports.add(qualified(context, info, "dtos", create_dto(info)))
    values = ", ".join(f"row.{column['getter']}()" for column in create_columns(info))
    return [
        "",
        "    /** The create DTO of a row the factories made. */",
        f"    private static {create_dto(info)} createOf({info['entity']} row) {{",
        f"        return new {create_dto(info)}({values});",
        "    }",
    ]


def test_files(context: dict) -> list[dict]:
    tests = context["settings"]["tests"]
    if tests == "none" or not writes_entities(context):
        return []
    makeable = [info for info in context["tables"] if _can_make(context, info)]
    files = [_test_database_file(context), _database_test_file(context), _factories_file(context, makeable)]
    memory = context["settings"]["memoryRepositories"]
    caller = context["settings"]["transactions"] == "caller"
    pkg = context["base"]
    for info in makeable:
        class_name = f"{info['entity']}Test"
        imports = (
            JavaImports(pkg)
            .add(
                "org.junit.jupiter.api.Nested",
                "org.junit.jupiter.api.Test",
                qualified(context, info, "entity", info["entity"]),
            )
            .add_static(
                "org.junit.jupiter.api.Assertions.assertEquals",
                "org.junit.jupiter.api.Assertions.assertNotNull",
                "org.junit.jupiter.api.Assertions.assertNull",
                "org.junit.jupiter.api.Assertions.assertThrows",
                "org.junit.jupiter.api.Assertions.assertTrue",
            )
        )
        nested: list = []
        database = False
        if tests in ("all", "repositories"):
            nested += ["", "    @Nested", "    class Repository {", *_flat(_repository_tests(context, info)), "    }"]
            database = True
        if tests in ("all", "services") and info["service"] is not None:
            service_blocks = _service_tests(context, info, imports)
            if service_blocks:
                unit = "        private final MemoryUnitOfWork uow = new MemoryUnitOfWork();" if memory else None
                if not memory:
                    database = True
                nested += [
                    "",
                    "    @Nested",
                    f"    class {service_class(info)}Test {{",
                    unit,
                    *_flat(service_blocks),
                    "    }",
                ]
                if (
                    context["settings"]["serviceTypes"] == "dtos"
                    and query(info, "insert")
                    and any(operation["kind"] == "create" for operation in info["operations"])
                ):
                    nested += _create_of_helper(context, info, imports)
        if not nested:
            continue
        if database:
            imports.add(
                "jakarta.persistence.EntityManager",
                "org.junit.jupiter.api.AfterEach",
                "org.junit.jupiter.api.BeforeEach",
            )
        content = lines(
            f"package {pkg};",
            "",
            imports.write(),
            "",
            f'/** Tests of the "{info["name"]}" table. */',
            f"class {class_name} {{",
            database
            and [
                "    private EntityManager entityManager;",
                "    /** The repositories over the test database, opened empty for every test */",
                "    private SqlUnitOfWork uow;",
                "",
                "    @BeforeEach",
                "    void open() {",
                "        entityManager = TestDatabase.open();",
                caller
                and "        // The caller owns the transaction: the test opens it, and rolls it back at the end",
                caller and "        entityManager.getTransaction().begin();",
                "        uow = new SqlUnitOfWork(entityManager);",
                "    }",
                "",
                "    @AfterEach",
                "    void close() {",
                "        if (entityManager.getTransaction().isActive()) entityManager.getTransaction().rollback();",
                "        entityManager.close();",
                "    }",
            ],
            *nested,
            "}",
            "",
        )
        files.append({"path": java_path(pkg, class_name, True), "content": content})
    return files
