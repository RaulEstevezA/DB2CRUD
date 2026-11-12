"""The tests of a generated C# project, which are also what the verification runs (xUnit v3): factories that build valid
rows (and their parents first), repository tests against a real database created from the mapping, and service tests
on the in-memory unit of work (or on the database when the project has no memory repositories). The database is SQLite
in memory unless TEST_DATABASE_CONNECTION names another. Mirrors web/src/core/generators/csharp/tests.ts."""

from ..types import lines
from .context import (
    column_of,
    common_namespace,
    errors_namespace,
    find_info,
    is_in,
    namespace_of,
    operation_name,
    path_of,
    query,
    query_name,
    service_class,
    writes_entities,
)
from .csharp import CsUsings, cs_string
from .dtos import create_columns, create_dto, update_columns, update_namespace, update_type
from .samples import missing_value, sample_value


def _is_nullable_key(info: dict, key: dict) -> bool:
    return all(column_of(info, name)["column"]["nullable"] for name in key["columns"])


def _can_make(context: dict, info: dict, seen: frozenset = frozenset()) -> bool:
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
    return f"New{info['entity']}"


def _add_name(info: dict) -> str:
    return f"Add{info['entity']}Async"


def _tests_ns(context: dict) -> str:
    return f"{context['base']}.Tests"


def _plain(expression: str, column: dict) -> str:
    """A value to pass where the column's plain type is asked for."""
    return f"{expression}!.Value" if column["optional"] and column["valueType"] else expression


def _file(context: dict, name: str, usings: CsUsings, body: list) -> dict:
    written = usings.write()
    return {
        "path": path_of(_tests_ns(context), name, True),
        "content": lines(written != "" and [written, ""], f"namespace {_tests_ns(context)};", "", *body, ""),
    }


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    usings = CsUsings(_tests_ns(context)).add(context["base"])
    blocks = []
    for info in makeable:
        usings.add(namespace_of(context, info, "entity"))
        parents = []
        from_parents = []
        parent_columns = set()
        for index, key in enumerate(info["table"]["foreignKeys"]):
            parent = find_info(context, key["references"]["table"])
            if _is_nullable_key(info, key) or not parent:
                continue
            usings.add(namespace_of(context, parent, "entity"))
            parents.append(f"        var parent{index} = await {_add_name(parent)}(uow, n);")
            for position, column in enumerate(key["columns"]):
                parent_columns.add(column)
                referenced = column_of(parent, key["references"]["columns"][position])["prop"]
                from_parents.append(f"        entity.{column_of(info, column)['prop']} = parent{index}.{referenced};")
        values = []
        for column in info["columns"]:
            if column["generated"] or column["column"]["name"] in parent_columns:
                continue
            is_key = any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            if column is info["soft"]:
                if column["column"]["type"]["kind"] == "boolean":
                    values.append(f"        entity.{column['prop']} = false;")
                continue
            if column["column"]["nullable"] and is_key:
                continue
            value = sample_value(column, info["table"]["checks"], context["schema"]["enums"])
            values.append(f"        entity.{column['prop']} = {value};")
        insert = query(info, "insert")
        entity = info["entity"]
        blocks.append(
            [
                f"    /// <summary>A valid {entity} that is not stored yet; n makes its unique values differ.</summary>",
                f"    public static {entity} {_new_name(info)}(int n)",
                "    {",
                f"        var entity = new {entity}();",
                *values,
                "        return entity;",
                "    }",
                "",
                f"    /// <summary>A stored {entity}{', with the rows it points to' if parents else ''}.</summary>",
                f"    public static async Task<{entity}> {_add_name(info)}(IUnitOfWork uow, int n)",
                "    {",
                *parents,
                f"        var entity = {_new_name(info)}(n);",
                *from_parents,
                f"        return await uow.{info['attr']}.{query_name(context, insert)}(entity);",
                "    }",
            ]
        )
    body = []
    for index, block in enumerate(blocks):
        body += ["" if index > 0 else None, *block]
    return _file(
        context,
        "Factories",
        usings,
        [
            "/// <summary>Rows for the tests: valid values for every column, and the rows they point to.</summary>",
            "internal static class Factories",
            "{",
            *body,
            "}",
        ],
    )


NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _test_database_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    usings = CsUsings(_tests_ns(context)).add(context["base"])
    if sqlite:
        usings.add("Microsoft.Data.Sqlite", "Microsoft.EntityFrameworkCore")
        doc = "/// <summary>The test database: TEST_DATABASE_CONNECTION, or SQLite in memory, created empty from the mapping for every test.</summary>"
        opening = [
            "        SqliteConnection? memory = null;",
            "        DbContextOptions<AppDbContext> options;",
            "        if (Connection is null)",
            "        {",
            "            // An in-memory database lives as long as its connection is open",
            '            memory = new SqliteConnection("Data Source=:memory:");',
            "            memory.Open();",
            "            options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(memory).Options;",
            "        }",
            "        else options = Database.Options(Connection);",
            "        var db = new AppDbContext(options);",
        ]
    else:
        doc = f"/// <summary>The test database: the {NAMES[database]} database TEST_DATABASE_CONNECTION names, created empty from the mapping for every test.</summary>"
        opening = [
            "        // The mapping is written for one kind of database: the tests cannot fall back to SQLite",
            "        if (Connection is null)",
            f'            throw new InvalidOperationException("The database tests need a disposable {NAMES[database]} database: set TEST_DATABASE_CONNECTION (it is emptied)");',
            "        var db = new AppDbContext(Database.Options(Connection));",
        ]
    return _file(
        context,
        "TestDatabase",
        usings,
        [
            doc,
            "public sealed class TestDatabase : IAsyncDisposable",
            "{",
            '    public static readonly string? Connection = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
            "",
            sqlite and ["    private readonly SqliteConnection? memory;", ""],
            "    private TestDatabase(AppDbContext db, SqliteConnection? memory)"
            if sqlite
            else "    private TestDatabase(AppDbContext db)",
            "    {",
            "        Db = db;",
            sqlite and "        this.memory = memory;",
            "    }",
            "",
            "    public AppDbContext Db { get; }",
            "",
            "    /// <summary>The test database, with every table dropped and created again.</summary>",
            "    public static async Task<TestDatabase> OpenAsync()",
            "    {",
            *opening,
            "        await db.Database.EnsureDeletedAsync();",
            "        await db.Database.EnsureCreatedAsync();",
            "        return new TestDatabase(db, memory);" if sqlite else "        return new TestDatabase(db);",
            "    }",
            "",
            "    public async ValueTask DisposeAsync()",
            "    {",
            "        await Db.DisposeAsync();",
            sqlite and "        if (memory is not null) await memory.DisposeAsync();",
            "    }",
            "}",
        ],
    )


def _database_tests_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    if database == "postgresql":
        sql = 'SELECT current_database() AS "Value"'
    elif sqlite:
        sql = 'SELECT sqlite_version() AS "Value"'
    else:
        sql = "SELECT DATABASE() AS Value"
    return _file(
        context,
        "DatabaseTests",
        CsUsings(_tests_ns(context)).add("Microsoft.EntityFrameworkCore", "Xunit"),
        [
            "/// <summary>The tests run on the database they were asked to.</summary>",
            "public class DatabaseTests",
            "{",
            "    [Fact]",
            "    public async Task IsSqlite()"
            if sqlite
            else "    public async Task IsTheOneTestDatabaseConnectionNames()",
            "    {",
            "        await using var database = await TestDatabase.OpenAsync();",
            f"        var value = await database.Db.Database.SqlQueryRaw<string>({cs_string(sql)}).SingleAsync();",
            '        Assert.StartsWith("3.", value);'
            if sqlite
            else "        Assert.Equal(database.Db.Database.GetDbConnection().Database, value);",
            "    }",
            "}",
        ],
    )


def _changeable_text(info: dict) -> dict | None:
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
        "    [Fact]",
        f"    public async Task {name}()",
        "    {",
        *((f"        {line}" if isinstance(line, str) else line) for line in _flat(body)),
        "    }",
    ]


def _repository_tests(context: dict, info: dict) -> list[list]:
    repo = f"uow.{info['attr']}"

    def key_of(variable: str) -> str:
        return ", ".join(_plain(f"{variable}.{column['prop']}", column) for column in info["key"])

    get_by_key = query(info, "getByKey")
    listing = query(info, "list")
    tests = []
    stored = f"var stored = await Factories.{_add_name(info)}(uow, 1);"
    uniques = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        if read:
            args = ", ".join(
                _plain(f"stored.{column_of(info, name)['prop']}", column_of(info, name)) for name in read["columns"]
            )
            uniques.append(f"Assert.NotNull(await {repo}.{query_name(context, read)}({args}));")
    parents = []
    for key in info["table"]["foreignKeys"]:
        read = query(info, "listByParent", key["columns"])
        if read:
            columns = [column_of(info, name) for name in read["columns"]]
            args = ", ".join(_plain(f"stored.{column['prop']}", column) for column in columns)
            assertion = f"Assert.Single(await {repo}.{query_name(context, read)}({args}));"
            optional = [column for column in columns if column["optional"]]
            if optional:
                condition = " && ".join(f"stored.{column['prop']} is not null" for column in optional)
                parents.append(f"if ({condition}) {assertion}")
            else:
                parents.append(assertion)
    tests.append(
        _test(
            "IsStoredAndReadBack",
            [
                stored,
                "uow.Db.ChangeTracker.Clear();",
                bool(get_by_key)
                and [
                    f"var found = await {repo}.{query_name(context, get_by_key)}({key_of('stored')});",
                    "Assert.NotNull(found);",
                    *(f"Assert.Equal(stored.{column['prop']}, found.{column['prop']});" for column in info["key"]),
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
                f"var page = await {repo}.{name}(0, 1);",
                "Assert.Equal(2, page.Total);",
                "Assert.Single(page.Items);",
            ]
        elif paging == "cursor":
            checks = [
                f"var first = await {repo}.{name}(null, 1);",
                "Assert.Single(first.Items);",
                "Assert.NotNull(first.Next);",
                f"var second = await {repo}.{name}(first.Next, 1);",
                "Assert.Single(second.Items);",
                "Assert.Null(second.Next);",
            ]
        else:
            checks = [f"Assert.Equal(2, (await {repo}.{name}()).Count);"]
        tests.append(
            _test(
                "ListsRowsByKey",
                [f"await Factories.{_add_name(info)}(uow, 1);", f"await Factories.{_add_name(info)}(uow, 2);", checks],
            )
        )
    update = query(info, "update")
    text = _changeable_text(info)
    if update and get_by_key and text:
        tests.append(
            _test(
                "StoresTheChanges",
                [
                    stored,
                    f'stored.{text["prop"]} = "changed";',
                    f"await {repo}.{query_name(context, update)}(stored);",
                    "uow.Db.ChangeTracker.Clear();",
                    f'Assert.Equal("changed", (await {repo}.{query_name(context, get_by_key)}({key_of("stored")}))!.{text["prop"]});',
                ],
            )
        )
    remove = query(info, "delete")
    if remove and get_by_key and not info["soft"]:
        tests.append(
            _test(
                "IsDeleted",
                [
                    stored,
                    f"await {repo}.{query_name(context, remove)}(stored);",
                    f"Assert.Null(await {repo}.{query_name(context, get_by_key)}({key_of('stored')}));",
                ],
            )
        )
    return tests


def _service_tests(context: dict, info: dict, usings: CsUsings) -> list[list]:
    service = service_class(info)
    usings.add(namespace_of(context, info, "service"))
    dtos = context["settings"]["serviceTypes"] == "dtos"
    ops = {operation["kind"] + ":" + ",".join(operation["columns"]): operation for operation in info["operations"]}

    def op(kind: str, columns: list[str] | None = None) -> dict | None:
        return ops.get(kind + ":" + ",".join(columns or []))

    create = op("create")
    get = op("get")
    update = op("update") if op("update") and query(info, "update") and query(info, "getByKey") else None
    remove = op("delete")

    def key_of(variable: str) -> str:
        return ", ".join(_plain(f"{variable}.{column['prop']}", column) for column in info["key"])

    parents_first = []
    overrides = []
    for index, key in enumerate(info["table"]["foreignKeys"]):
        parent = find_info(context, key["references"]["table"])
        if not parent or not _can_make(context, parent):
            continue
        usings.add(namespace_of(context, parent, "entity"))
        parents_first.append(f"var parent{index} = await Factories.{_add_name(parent)}(uow, n);")
        for position, column in enumerate(key["columns"]):
            referenced = column_of(parent, key["references"]["columns"][position])["prop"]
            overrides.append({"column": column, "value": f"parent{index}.{referenced}"})
    start = ["var n = 1;", *parents_first]

    def row(variable: str, n: int, extra: list | None = None) -> list[str]:
        extra = extra or []
        given = {item["column"] for item in extra}
        items = [item for item in overrides if item["column"] not in given] + extra
        return [
            f"var {variable} = Factories.{_new_name(info)}({n});",
            *(f"{variable}.{column_of(info, item['column'])['prop']} = {item['value']};" for item in items),
        ]

    def source(variable: str) -> str:
        return f"CreateOf({variable})" if dtos else variable

    def changes(target: dict, value: str, origin: str) -> str:
        usings.add(update_namespace(context, info))
        patch = context["settings"]["updates"] == "patch"
        if patch:
            usings.add(common_namespace(context))
        fields = []
        for column in update_columns(info):
            if patch:
                fields.append(
                    f"Patch<{column['propType']}>.Of({value})"
                    if column is target
                    else f"Patch<{column['propType']}>.Absent"
                )
            else:
                fields.append(value if column is target else f"{origin}.{column['prop']}")
        record = not dtos or context["settings"]["dtoKind"] != "class"
        if record:
            return f"new {update_type(context, info)}({', '.join(fields)})"
        assigned = ", ".join(f"{column['prop']} = {fields[index]}" for index, column in enumerate(update_columns(info)))
        return f"new {update_type(context, info)} {{ {assigned} }}"

    def version(variable: str) -> str:
        if not info["version"]:
            return ""
        return ", " + _plain(variable + "." + info["version"]["prop"], info["version"])

    tests = []
    opening = [f"var service = new {service}(uow);"]
    if create:
        name = operation_name(context, create)
        tests.append(
            _test(
                "CreatesAValidRow",
                [
                    *opening,
                    *start,
                    *row("row", 1),
                    f"var created = await service.{name}({source('row')});",
                    bool(get)
                    and [
                        f"var found = await service.{operation_name(context, get)}({key_of('created')});",
                        *(f"Assert.Equal(created.{column['prop']}, found.{column['prop']});" for column in info["key"]),
                    ],
                ],
            )
        )
        # A missing value can only be told when the property can be null
        required = next(
            (
                column
                for column in info["columns"]
                if column["required"]
                and not column["valueType"]
                and not any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            ),
            None,
        )
        if required:
            usings.add(errors_namespace(context))
            tests.append(
                _test(
                    "RefusesAMissingValue",
                    [
                        *opening,
                        *start,
                        *row("row", 1, [{"column": required["column"]["name"], "value": "null!"}]),
                        f"var error = await Assert.ThrowsAsync<ValidationFailedException>(() => service.{name}({source('row')}));",
                        f"Assert.Equal(new[] {{ {cs_string(required['column']['name'])} }}, error.Errors.Select(item => item.Field));",
                    ],
                )
            )
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
            usings.add(errors_namespace(context))
            own = [column_of(info, column) for column in unique["columns"]]
            tests.append(
                _test(
                    "RefusesARepeatedUniqueValue",
                    [
                        *opening,
                        *start,
                        *row("row", 1),
                        f"var first = await service.{name}({source('row')});",
                        *row(
                            "again",
                            2,
                            [
                                {"column": column["column"]["name"], "value": f"first.{column['prop']}"}
                                for column in own
                            ],
                        ),
                        f"await Assert.ThrowsAsync<ConflictException>(() => service.{name}({source('again')}));",
                    ],
                )
            )
            if (
                update
                and len(own) == 1
                and all(not is_in(column, info["key"]) and not column["generated"] for column in own)
            ):
                tests.append(
                    _test(
                        "KeepsItsOwnUniqueValue",
                        [
                            *opening,
                            *start,
                            *row("row", 1),
                            f"var created = await service.{name}({source('row')});",
                            f"await service.{operation_name(context, update)}({key_of('created')}, {changes(own[0], 'created.' + own[0]['prop'], 'row')}{version('created')});",
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
            usings.add(errors_namespace(context))
            column = column_of(info, parent_key["columns"][0])
            tests.append(
                _test(
                    "RefusesAMissingParent",
                    [
                        *opening,
                        *start,
                        *row("row", 1, [{"column": column["column"]["name"], "value": missing_value(column)}]),
                        f"var error = await Assert.ThrowsAsync<ValidationFailedException>(() => service.{name}({source('row')}));",
                        f"Assert.Contains({cs_string(parent_key['columns'][0])}, error.Errors.Select(item => item.Field));",
                    ],
                )
            )
    if get:
        usings.add(errors_namespace(context))
        missing = ", ".join(missing_value(column) for column in info["key"])
        tests.append(
            _test(
                "SaysWhenARowIsMissing",
                [
                    *opening,
                    f"await Assert.ThrowsAsync<NotFoundException>(() => service.{operation_name(context, get)}({missing}));",
                ],
            )
        )
    text = _changeable_text(info)
    if create and update and text:
        tests.append(
            _test(
                "ChangesARow",
                [
                    *opening,
                    *start,
                    *row("row", 1),
                    f"var created = await service.{operation_name(context, create)}({source('row')});",
                    f"var updated = await service.{operation_name(context, update)}({key_of('created')}, {changes(text, chr(34) + 'changed' + chr(34), 'row')}{version('created')});",
                    f'Assert.Equal("changed", updated.{text["prop"]});',
                ],
            )
        )
    if create and remove and get:
        usings.add(errors_namespace(context))
        tests.append(
            _test(
                "DeletesARow",
                [
                    *opening,
                    *start,
                    *row("row", 1),
                    f"var created = await service.{operation_name(context, create)}({source('row')});",
                    f"await service.{operation_name(context, remove)}({key_of('created')}{version('created')});",
                    f"await Assert.ThrowsAsync<NotFoundException>(() => service.{operation_name(context, get)}({key_of('created')}));",
                ],
            )
        )
    return tests


def _create_of_helper(context: dict, info: dict, usings: CsUsings) -> list[str]:
    usings.add(namespace_of(context, info, "dtos"))
    columns = create_columns(info)
    if context["settings"]["dtoKind"] == "class":
        values = ", ".join(f"{column['prop']} = row.{column['prop']}" for column in columns)
        body = f"    private static {create_dto(info)} CreateOf({info['entity']} row) => new() {{ {values} }};"
    else:
        values = ", ".join(f"row.{column['prop']}" for column in columns)
        body = f"    private static {create_dto(info)} CreateOf({info['entity']} row) => new({values});"
    return ["", "    /// <summary>The create DTO of a row the factories made.</summary>", body]


def _database_members(context: dict) -> list:
    caller = context["settings"]["transactions"] == "caller"
    return [
        "    private TestDatabase database = null!;",
        "",
        "    /// <summary>The repositories over the test database, opened empty for every test</summary>",
        "    private SqlUnitOfWork uow = null!;",
        "",
        "    public async ValueTask InitializeAsync()",
        "    {",
        "        database = await TestDatabase.OpenAsync();",
        caller and "        // The caller owns the transaction: the test opens it, and it ends with the test",
        caller and "        await database.Db.Database.BeginTransactionAsync();",
        "        uow = new SqlUnitOfWork(database.Db);",
        "    }",
        "",
        "    public async ValueTask DisposeAsync() => await database.DisposeAsync();",
    ]


ASSEMBLY = "\n".join(
    [
        "using Xunit;",
        "",
        "// Every test empties the same database: they run one after another",
        "[assembly: CollectionBehavior(CollectionBehavior.CollectionPerAssembly)]",
        "",
    ]
)


def test_files(context: dict) -> list[dict]:
    tests = context["settings"]["tests"]
    if tests == "none" or not writes_entities(context):
        return []
    makeable = [info for info in context["tables"] if _can_make(context, info)]
    files = [
        {"path": "tests/App.Tests/AssemblyInfo.cs", "content": ASSEMBLY},
        _test_database_file(context),
        _database_tests_file(context),
        _factories_file(context, makeable),
    ]
    memory = context["settings"]["memoryRepositories"]
    for info in makeable:
        usings = CsUsings(_tests_ns(context)).add("Xunit", context["base"], namespace_of(context, info, "entity"))
        classes: list = []
        if tests in ("all", "repositories"):
            classes += [
                f'/// <summary>The repository of the "{info["name"]}" table, against the test database.</summary>',
                f"public class {info['entity']}RepositoryTests : IAsyncLifetime",
                "{",
                *_database_members(context),
                *_flat(_repository_tests(context, info)),
                "}",
            ]
        if tests in ("all", "services") and info["service"] is not None:
            blocks = _service_tests(context, info, usings)
            if blocks:
                if classes:
                    classes.append("")
                where = "the in-memory repositories" if memory else "the test database"
                helper = []
                if (
                    context["settings"]["serviceTypes"] == "dtos"
                    and query(info, "insert")
                    and any(operation["kind"] == "create" for operation in info["operations"])
                ):
                    helper = _create_of_helper(context, info, usings)
                classes += [
                    f'/// <summary>The service of the "{info["name"]}" table, on {where}.</summary>',
                    f"public class {service_class(info)}Tests"
                    if memory
                    else f"public class {service_class(info)}Tests : IAsyncLifetime",
                    "{",
                    *(["    private readonly MemoryUnitOfWork uow = new();"] if memory else _database_members(context)),
                    *_flat(blocks),
                    *helper,
                    "}",
                ]
        if not classes:
            continue
        files.append(_file(context, f"{info['entity']}Tests", usings, classes))
    return files
