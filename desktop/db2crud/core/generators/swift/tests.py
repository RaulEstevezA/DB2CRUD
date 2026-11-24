"""The tests of a generated Swift package, which are also what the verification runs (swift-testing): factories that
build valid rows (and their parents first), repository tests against a real database created with Fluent's schema
builder, and service tests on the in-memory unit of work (or on the database when the project has no memory
repositories). Every test is in one serialized suite, DataTests: they all empty the same database. The database is
SQLite in memory unless TEST_DATABASE_URL names another. Mirrors web/src/core/generators/swift/tests.ts."""

import re

from .context import (
    column_of,
    find_info,
    is_in,
    operation_name,
    query,
    query_name,
    service_type,
    writes_entities,
)
from .dtos import create_columns, create_dto, update_columns, update_type
from .samples import missing_value, sample_value
from .swift import imports, sw_string


def _is_nullable_key(info: dict, key: dict) -> bool:
    return all(column_of(info, name)["column"]["nullable"] for name in key["columns"])


def can_make(context: dict, info: dict, seen: frozenset = frozenset()) -> bool:
    """Tables whose rows the tests can make: they can be inserted, and so can the parents they need."""
    if info["name"] in seen or not query(info, "insert"):
        return False
    following = seen | {info["name"]}
    for key in info["table"]["foreignKeys"]:
        if _is_nullable_key(info, key):
            continue
        parent = find_info(context, key["references"]["table"])
        if parent is None or not can_make(context, parent, following):
            return False
    return True


def _new_name(info: dict) -> str:
    return f"new{info['entity']}"


def _add_name(info: dict) -> str:
    return f"add{info['entity']}"


def _ind(items: list[str], spaces: int = 4) -> list[str]:
    return ["" if line == "" else " " * spaces + line for line in items]


def _test_path(context: dict, name: str) -> str:
    return f"Tests/{context['module']}Tests/{name}.swift"


def _header(context: dict, testing: bool, *modules: str) -> str:
    """The imports of a test file. Testing has types of its own (Tag, Test, Issue…): the factories leave it out."""
    return "\n".join(
        [imports("Foundation", *(["Testing"] if testing else []), *modules), f"@testable import {context['module']}"]
    )


def _used_lines(lines: list[str]) -> list[str]:
    """A variable nobody uses is a warning, and a warning fails the build: a parent made for a column the test then sets
    itself is not made."""

    def wanted(line: str) -> bool:
        match = re.match(r"^let (parent\d+) = ", line.strip())
        if not match:
            return True
        return any(other != line and f"{match.group(1)}." in other for other in lines)

    return [line for line in lines if wanted(line)]


# Factories


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    blocks = []
    for info in makeable:
        parents: list[str] = []
        from_parents: list[str] = []
        parent_columns: set[str] = set()
        for index, key in enumerate(info["table"]["foreignKeys"]):
            parent = find_info(context, key["references"]["table"])
            if _is_nullable_key(info, key) or not parent:
                continue
            parents.append(f"let parent{index} = try await {_add_name(parent)}(uow, n)")
            for position, column in enumerate(key["columns"]):
                parent_columns.add(column)
                target = column_of(parent, key["references"]["columns"][position])["prop"]
                from_parents.append(f"entity.{column_of(info, column)['prop']} = parent{index}.{target}")
        values: list[str] = []
        for column in info["columns"]:
            if column["generated"] or column["column"]["name"] in parent_columns:
                continue
            is_key = any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            if column is info["soft"]:
                if column["column"]["type"]["kind"] == "boolean":
                    values.append(f"{column['key']}: false")
                continue
            # No sample is sure to fit a type that is not known
            if column["column"]["nullable"] and (is_key or column["column"]["type"]["kind"] == "unknown"):
                continue
            if column["column"]["type"]["kind"] == "array":
                value = context["orm"]["emptyList"](context)
            else:
                value = sample_value(column, info["table"]["checks"], context["schema"]["enums"])
            values.append(f"{column['key']}: {value}")
        insert = query(info, "insert")
        blocks.append(
            [
                f"/// A valid {info['entity']} that is not stored yet; n makes its unique values differ.",
                f"static func {_new_name(info)}(_ n: Int) -> {info['entity']} {{",
                f"    {info['entity']}({', '.join(values)})",
                "}",
                "",
                f"/// A stored {info['entity']}{', with the rows it points to' if parents else ''}.",
                "@discardableResult",
                f"static func {_add_name(info)}(_ uow: any UnitOfWork, _ n: Int) async throws -> {info['entity']} {{",
                *_ind(parents),
                f"    {'var' if from_parents else 'let'} entity = {_new_name(info)}(n)",
                *_ind(from_parents),
                f"    return try await uow.{info['attr']}.{query_name(context, insert)}(entity)",
                "}",
            ]
        )
    body: list[str] = []
    for index, block in enumerate(blocks):
        if index > 0:
            body.append("")
        body += _ind(block)
    return {
        "path": _test_path(context, "Factories"),
        "content": "\n".join(
            [
                _header(context, False),
                "",
                "/// Rows for the tests: valid values for every column, and the rows they point to.",
                "enum Factories {",
                *body,
                "}",
                "",
            ]
        ),
    }


# The test database

NAMES = {"postgresql": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB"}


def _test_database_file(context: dict) -> dict:
    database = context["settings"]["database"]
    sqlite = database == "sqlite"
    name = NAMES.get(database)
    pieces = context["orm"]["testDatabase"](context)
    assertion = (
        '                #expect(value.hasPrefix("3."))'
        if sqlite
        else '                let url = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"] ?? ""\n'
        '                #expect(url.split(separator: "/").last?.split(separator: "?").first.map(String.init) == value)'
    )
    content = [
        _header(context, True, *pieces["modules"]),
        "",
        "/// Every test is in this suite, one after another: they all empty the same database.",
        "@Suite(.serialized) struct DataTests {}",
        "",
        "/// The test database: TEST_DATABASE_URL, or SQLite in memory, created again before every test."
        if sqlite
        else f"/// The test database: the {name} database TEST_DATABASE_URL names, created again before every test.",
        "enum TestDatabase {",
        "    /// Runs body with the repositories over the test database, with every table dropped and created again first.",
        "    static func with(_ body: (SqlUnitOfWork) async throws -> Void) async throws {",
        *pieces["open"],
        "        do {",
        "            try await recreate(app.database)",
        "            try await body(SqlUnitOfWork(db: app.database))",
        "        } catch {",
        "            await app.shutdown()",
        "            throw error",
        "        }",
        "        await app.shutdown()",
        "    }",
        "",
        *pieces["recreate"],
        "}",
        "",
        "/// The DomainError work throws, or nil when it throws none.",
        "func refusal<T>(_ work: () async throws -> T) async -> DomainError? {",
        "    do {",
        "        _ = try await work()",
        "        return nil",
        "    } catch let error as DomainError {",
        "        return error",
        "    } catch {",
        "        return nil",
        "    }",
        "}",
        "",
        "func isConflict(_ error: DomainError?) -> Bool {",
        "    if case .some(.conflict) = error { true } else { false }",
        "}",
        "",
        "func isNotFound(_ error: DomainError?) -> Bool {",
        "    if case .some(.notFound) = error { true } else { false }",
        "}",
        "",
        "extension DataTests {",
        "    /// The tests run on the database they were asked to.",
        "    @Suite struct DatabaseTests {",
        "        @Test func isTheTestDatabase() async throws {",
        "            try await TestDatabase.with { uow in",
        f"                let rows = try await {pieces['check']}",
        '                let value = try rows[0].decode(column: "value", as: String.self)',
        assertion,
        "            }",
        "        }",
        "    }",
        "}",
        "",
    ]
    return {"path": _test_path(context, "TestDatabase"), "content": "\n".join(content)}


# Tests of each table


def _changeable_text(info: dict) -> dict | None:
    """A text column the tests can change and read back, when the table has one."""
    table = info["table"]
    for column in update_columns(info):
        db = column["column"]
        column_type = db["type"]
        length = column_type.get("length")
        if (
            column_type["kind"] == "text"
            and not column_type.get("fixed")
            and db["name"] not in info["hidden"]
            and (40 if length is None else length) >= 7
            and not any((check.get("parsed") or {}).get("column") == db["name"] for check in table["checks"])
            and not any(db["name"] in unique["columns"] for unique in table["uniques"])
            and not any(db["name"] in key["columns"] for key in table["foreignKeys"])
        ):
            return column
    return None


def _flat(body: list) -> list[str]:
    lines: list[str] = []
    for item in body:
        if isinstance(item, list):
            lines += [line for line in item if isinstance(line, str)]
        elif isinstance(item, str):
            lines.append(item)
    return lines


def _test(name: str, body: list, on_database: bool) -> list[str]:
    """A test: its body on the test database, or as it is."""
    lines = _used_lines(_flat(body))
    inner = ["    try await TestDatabase.with { uow in", *_ind(lines, 8), "    }"] if on_database else _ind(lines)
    return ["", f"@Test func {name}() async throws {{", *inner, "}"]


def _when_set(columns: list[dict], assertion: str) -> list[str]:
    """An assertion on a stored row's values, made only when those that may be nil have one."""
    optional = [column for column in columns if column["column"]["nullable"]]
    if not optional:
        return [assertion]
    conditions = ", ".join(f"stored.{column['prop']} != nil" for column in optional)
    return [f"if {conditions} {{", f"    {assertion}", "}"]


def _repository_tests(context: dict, info: dict) -> list[list[str]]:
    repo = f"uow.{info['attr']}"

    def key_of(variable: str) -> str:
        return ", ".join(f"{variable}.{column['prop']}!" for column in info["key"])

    def args(columns: list[dict]) -> str:
        return ", ".join(f"stored.{column['prop']}!" for column in columns)

    get_by_key = query(info, "getByKey")
    listing = query(info, "list")
    tests: list[list[str]] = []
    checks: list[str] = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        if read:
            columns = [column_of(info, name) for name in read["columns"]]
            checks += _when_set(
                columns, f"#expect(try await {repo}.{query_name(context, read)}({args(columns)}) != nil)"
            )
    for key in info["table"]["foreignKeys"]:
        read = query(info, "listByParent", key["columns"])
        if read:
            columns = [column_of(info, name) for name in read["columns"]]
            checks += _when_set(
                columns, f"#expect(try await {repo}.{query_name(context, read)}({args(columns)}).count == 1)"
            )
    uses_stored = get_by_key is not None or bool(checks)
    tests.append(
        _test(
            "isStoredAndReadBack",
            [
                f"{'let stored =' if uses_stored else '_ ='} try await Factories.{_add_name(info)}(uow, 1)",
                get_by_key
                and [
                    f"let row = try await {repo}.{query_name(context, get_by_key)}({key_of('stored')})",
                    "let found = try #require(row)",
                    *(f"#expect(found.{column['prop']} == stored.{column['prop']})" for column in info["key"]),
                ],
                *checks,
            ],
            True,
        )
    )
    if listing:
        name = query_name(context, listing)
        paging = context["settings"]["paging"]
        if paging == "offset":
            reads = [
                f"let page = try await {repo}.{name}(offset: 0, limit: 1)",
                "#expect(page.total == 2)",
                "#expect(page.items.count == 1)",
            ]
        elif paging == "cursor":
            reads = [
                f"let first = try await {repo}.{name}(after: nil, limit: 1)",
                "#expect(first.items.count == 1)",
                "#expect(first.next != nil)",
                f"let second = try await {repo}.{name}(after: first.next, limit: 1)",
                "#expect(second.items.count == 1)",
                "#expect(second.next == nil)",
            ]
        else:
            reads = [f"#expect(try await {repo}.{name}().count == 2)"]
        tests.append(
            _test(
                "listsRowsByKey",
                [
                    f"try await Factories.{_add_name(info)}(uow, 1)",
                    f"try await Factories.{_add_name(info)}(uow, 2)",
                    reads,
                ],
                True,
            )
        )
    update = query(info, "update")
    text = _changeable_text(info)
    if update and get_by_key and text:
        tests.append(
            _test(
                "storesTheChanges",
                [
                    f"var stored = try await Factories.{_add_name(info)}(uow, 1)",
                    f'stored.{text["prop"]} = "changed"',
                    f"try await {repo}.{query_name(context, update)}(stored)",
                    f"let found = try await {repo}.{query_name(context, get_by_key)}({key_of('stored')})",
                    f'#expect(found?.{text["prop"]} == "changed")',
                ],
                True,
            )
        )
    remove = query(info, "delete")
    if remove and get_by_key and not info["soft"]:
        tests.append(
            _test(
                "isDeleted",
                [
                    f"let stored = try await Factories.{_add_name(info)}(uow, 1)",
                    f"try await {repo}.{query_name(context, remove)}(stored)",
                    f"#expect(try await {repo}.{query_name(context, get_by_key)}({key_of('stored')}) == nil)",
                ],
                True,
            )
        )
    return tests


def _service_tests(context: dict, info: dict) -> list[list[str]]:
    service = service_type(info)
    dtos = context["settings"]["serviceTypes"] == "dtos"
    memory = context["settings"]["memoryRepositories"]
    ops = {f"{operation['kind']}:{','.join(operation['columns'])}": operation for operation in info["operations"]}

    def op(kind: str, columns: list[str] | None = None) -> dict | None:
        return ops.get(f"{kind}:{','.join(columns or [])}")

    create = op("create") if op("create") and query(info, "insert") else None
    get = op("get") if op("get") and query(info, "getByKey") else None
    update = op("update") if op("update") and query(info, "update") and query(info, "getByKey") else None
    remove = op("delete")
    soft = info["soft"]
    deletes = (
        remove
        if remove
        and query(info, "getByKey")
        and ((soft and query(info, "update")) or (not soft and query(info, "delete")))
        else None
    )

    def member(variable: str, column: dict) -> str:
        """A column of what the service returns, known to be set."""
        if dtos and not column["column"]["nullable"]:
            return f"{variable}.{column['prop']}"
        return f"{variable}.{column['prop']}!"

    def key_of(variable: str) -> str:
        return ", ".join(member(variable, column) for column in info["key"])

    # Rows go in through the service (when it creates them) and the parents through the factories, numbered 100: the
    # rows of the test never take that number, and a parent may be a row of the same table
    parents_first: list[str] = []
    overrides: list[dict] = []
    for index, key in enumerate(info["table"]["foreignKeys"]):
        parent = find_info(context, key["references"]["table"])
        if not parent or not can_make(context, parent):
            continue
        parents_first.append(f"let parent{index} = try await Factories.{_add_name(parent)}(uow, 100)")
        for position, column in enumerate(key["columns"]):
            target = column_of(parent, key["references"]["columns"][position])["prop"]
            overrides.append({"column": column, "value": f"parent{index}.{target}"})

    def row(variable: str, n: int, extra: list[dict] | None = None) -> list[str]:
        extra = extra or []
        given = {item["column"] for item in extra}
        assignments = [*(item for item in overrides if item["column"] not in given), *extra]
        return [
            f"{'var' if assignments else 'let'} {variable} = Factories.{_new_name(info)}({n})",
            *(f"{variable}.{column_of(info, item['column'])['prop']} = {item['value']}" for item in assignments),
        ]

    def input_of(variable: str) -> str:
        return f"createOf({variable})" if dtos else variable

    def changes(target: dict, value: dict, source: str) -> str:
        """The changes of an update that sets one field, and keeps the others as the row has them."""
        type_ = update_type(context, info)
        mode = context["settings"]["updates"]
        if mode == "patch":
            return f"{type_}({target['key']}: .set({value['option']}))"
        if mode == "optional":
            return f"{type_}({target['key']}: .some({value['option']}))"
        fields = []
        for column in update_columns(info):
            if column is target:
                field_value = value["stored"]
            elif column["column"]["nullable"]:
                field_value = f"{source}.{column['prop']}"
            else:
                field_value = f"{source}.{column['prop']}!"
            fields.append(f"{column['key']}: {field_value}")
        return f"{type_}({', '.join(fields)})"

    def version(variable: str) -> str:
        return f", version: {member(variable, info['version'])}" if info["version"] else ""

    tests: list[list[str]] = []
    opened = [f"let service = {service}(unitOfWork: uow)"]

    def make(name: str, body: list) -> list[str]:
        lines = _flat(body)
        return _test(name, ["let uow = MemoryUnitOfWork()", *lines] if memory else lines, not memory)

    if create:
        name = operation_name(context, create)
        if get:
            created = [
                f"let created = try await service.{name}({input_of('row')})",
                f"let found = try await service.{operation_name(context, get)}({key_of('created')})",
                *(f"#expect(created.{column['prop']} == found.{column['prop']})" for column in info["key"]),
            ]
        elif dtos:
            created = [f"try await service.{name}({input_of('row')})"]
        else:
            created = [
                f"let created = try await service.{name}({input_of('row')})",
                *(f"#expect(created.{column['prop']} != nil)" for column in info["key"]),
            ]
        tests.append(make("createsAValidRow", [*opened, *parents_first, *row("row", 1), created]))
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
            tests.append(
                make(
                    "refusesAMissingValue",
                    [
                        *opened,
                        *parents_first,
                        *row("row", 1, [{"column": required["column"]["name"], "value": "nil"}]),
                        f"let error = await refusal {{ try await service.{name}({input_of('row')}) }}",
                        f"#expect(error?.invalidFields == [{sw_string(required['column']['name'])}])",
                    ],
                )
            )
        # A unique value the client gives: one the database fills is never sent
        unique = next(
            (
                item
                for item in info["table"]["uniques"]
                if query(info, "findByUnique", item["columns"])
                and all(not column_of(info, column)["generated"] for column in item["columns"])
            ),
            None,
        )
        if unique:
            own = [column_of(info, column) for column in unique["columns"]]
            tests.append(
                make(
                    "refusesARepeatedUniqueValue",
                    [
                        *opened,
                        *parents_first,
                        *row("row", 1),
                        f"let first = try await service.{name}({input_of('row')})",
                        *row(
                            "again",
                            2,
                            [
                                {"column": column["column"]["name"], "value": f"first.{column['prop']}"}
                                for column in own
                            ],
                        ),
                        f"#expect(isConflict(await refusal {{ try await service.{name}({input_of('again')}) }}))",
                    ],
                )
            )
            if (
                update
                and len(own) == 1
                and all(not is_in(column, info["key"]) and not column["generated"] for column in own)
            ):
                target = own[0]
                kept = {
                    "option": f"created.{target['prop']}",
                    "stored": f"created.{target['prop']}"
                    if target["column"]["nullable"]
                    else member("created", target),
                }
                tests.append(
                    make(
                        "keepsItsOwnUniqueValue",
                        [
                            *opened,
                            *parents_first,
                            *row("row", 1),
                            f"let created = try await service.{name}({input_of('row')})",
                            f"let updated = try await service.{operation_name(context, update)}({key_of('created')}, {changes(target, kept, 'row')}{version('created')})",
                            f"#expect(created.{target['prop']} == updated.{target['prop']})",
                        ],
                    )
                )

        def has_parent(key: dict) -> bool:
            parent = find_info(context, key["references"]["table"])
            return bool(parent and query(parent, "getByKey") and len(key["columns"]) == 1)

        parent_key = next((key for key in info["table"]["foreignKeys"] if has_parent(key)), None)
        if parent_key:
            column = column_of(info, parent_key["columns"][0])
            tests.append(
                make(
                    "refusesAMissingParent",
                    [
                        *opened,
                        *parents_first,
                        *row("row", 1, [{"column": column["column"]["name"], "value": missing_value(column)}]),
                        f"let error = await refusal {{ try await service.{name}({input_of('row')}) }}",
                        f"#expect(error?.invalidFields.contains({sw_string(parent_key['columns'][0])}) == true)",
                    ],
                )
            )
    if get:
        missing = ", ".join(missing_value(column) for column in info["key"])
        tests.append(
            make(
                "saysWhenARowIsMissing",
                [
                    *opened,
                    f"#expect(isNotFound(await refusal {{ try await service.{operation_name(context, get)}({missing}) }}))",
                ],
            )
        )
    text = _changeable_text(info)
    if create and update and text:
        changed = changes(text, {"option": '"changed"', "stored": '"changed"'}, "row")
        tests.append(
            make(
                "changesARow",
                [
                    *opened,
                    *parents_first,
                    *row("row", 1),
                    f"let created = try await service.{operation_name(context, create)}({input_of('row')})",
                    f"let updated = try await service.{operation_name(context, update)}({key_of('created')}, {changed}{version('created')})",
                    f'#expect(updated.{text["prop"]} == "changed")',
                ],
            )
        )
    if create and deletes and get:
        tests.append(
            make(
                "deletesARow",
                [
                    *opened,
                    *parents_first,
                    *row("row", 1),
                    f"let created = try await service.{operation_name(context, create)}({input_of('row')})",
                    f"try await service.{operation_name(context, deletes)}({key_of('created')}{version('created')})",
                    f"#expect(isNotFound(await refusal {{ try await service.{operation_name(context, get)}({key_of('created')}) }}))",
                ],
            )
        )
    return tests


def _create_of_helper(context: dict, info: dict) -> list[str]:
    """Builds a create DTO from a factory row: the values of its fields."""
    values = ", ".join(f"{column['key']}: row.{column['prop']}" for column in create_columns(info))
    return [
        "",
        "/// The create DTO of a row the factories made.",
        # The entity by its module: a test file imports Testing, whose names may be the same
        f"fileprivate func createOf(_ row: {context['module']}.{info['entity']}) -> {create_dto(info)} {{",
        f"    {create_dto(info)}({values})",
        "}",
    ]


def _suite_file(context: dict, name: str, doc: str, blocks: list[list[str]], after: list[str] | None = None) -> dict:
    """A suite of tests, in the serialized suite of the package."""
    return {
        "path": _test_path(context, name),
        "content": "\n".join(
            [
                _header(context, True),
                "",
                "extension DataTests {",
                f"    /// {doc}",
                f"    @Suite struct {name} {{",
                *_ind([line for block in blocks for line in block], 8),
                "    }",
                "}",
                *(after or []),
                "",
            ]
        ),
    }


def test_files(context: dict) -> list[dict]:
    tests = context["settings"]["tests"]
    if tests == "none" or not writes_entities(context):
        return []
    makeable = [info for info in context["tables"] if can_make(context, info)]
    files = [_test_database_file(context), _factories_file(context, makeable)]
    memory = context["settings"]["memoryRepositories"]
    for info in makeable:
        if tests in ("all", "repositories"):
            files.append(
                _suite_file(
                    context,
                    f"{info['entity']}RepositoryTests",
                    f'The repository of the "{info["name"]}" table, against the test database.',
                    _repository_tests(context, info),
                )
            )
        if tests in ("all", "services") and info["service"] is not None:
            blocks = _service_tests(context, info)
            if not blocks:
                continue
            uses_create_of = any("createOf(" in line for block in blocks for line in block)
            helper = (
                _create_of_helper(context, info)
                if context["settings"]["serviceTypes"] == "dtos" and uses_create_of
                else []
            )
            on = "the in-memory repositories" if memory else "the test database"
            files.append(
                _suite_file(
                    context,
                    f"{service_type(info)}Tests",
                    f'The service of the "{info["name"]}" table, on {on}.',
                    blocks,
                    helper,
                )
            )
    return files
