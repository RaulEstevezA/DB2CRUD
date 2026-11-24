"""The tests of a generated Kotlin project, which are also what the verification runs (kotlin.test on JUnit 5):
factories that build valid rows (and their parents first), repository tests against a real database created from the
table objects, and service tests on the in-memory unit of work (or on the database when the project has no memory
repositories). The database is SQLite in a temporary file unless TEST_DATABASE_URL names another. Mirrors
web/src/core/generators/kotlin/tests.ts."""

from .context import (
    column_of,
    common_package,
    errors_package,
    find_info,
    is_in,
    kt_file,
    operation_name,
    package_of,
    path_of,
    qualified,
    query,
    query_name,
    service_class,
    stored,
    writes_entities,
)
from .dtos import create_columns, create_dto, update_class, update_columns, update_type
from .kotlin import KtImports, kt_string
from .samples import missing_value, sample_value


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


def test_path(context: dict, name: str) -> str:
    return path_of(context["base"], name, True)


def _ind(items: list[str], spaces: int) -> list[str]:
    return ["" if line == "" else " " * spaces + line for line in items]


# Factories


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    imports = KtImports(context["base"])
    blocks = []
    for info in makeable:
        imports.add(qualified(package_of(context, info, "entity"), info["entity"]))
        parents: list[str] = []
        from_parents: list[str] = []
        parent_columns: set[str] = set()
        for index, key in enumerate(info["table"]["foreignKeys"]):
            parent = find_info(context, key["references"]["table"])
            if _is_nullable_key(info, key) or not parent:
                continue
            parents.append(f"        val parent{index} = {_add_name(parent)}(uow, n)")
            for position, column in enumerate(key["columns"]):
                parent_columns.add(column)
                target = column_of(parent, key["references"]["columns"][position])["prop"]
                from_parents.append(f"        entity.{column_of(info, column)['prop']} = parent{index}.{target}")
        values: list[str] = []
        for column in info["columns"]:
            if column["generated"] or column["column"]["name"] in parent_columns:
                continue
            is_key = any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            if column is info["soft"]:
                if column["column"]["type"]["kind"] == "boolean":
                    values.append(f"        {column['prop']} = false,")
                continue
            # No sample is sure to fit a type that is not known
            if column["column"]["nullable"] and (is_key or column["column"]["type"]["kind"] == "unknown"):
                continue
            if column["column"]["type"]["kind"] == "array":
                sample = context["orm"]["emptyList"](context)
            else:
                sample = sample_value(column, info["table"]["checks"], context["schema"]["enums"], imports)
            values.append(f"        {column['prop']} = {sample},")
        insert = query(info, "insert")
        blocks.append(
            [
                f"    /** A valid {info['entity']} that is not stored yet; n makes its unique values differ. */",
                f"    fun {_new_name(info)}(n: Int): {info['entity']} =",
                f"        {info['entity']}(",
                *(f"    {line}" for line in values),
                "        )",
                "",
                f"    /** A stored {info['entity']}{', with the rows it points to' if parents else ''}. */",
                f"    fun {_add_name(info)}(uow: UnitOfWork, n: Int): {info['entity']} {{",
                *parents,
                f"        val entity = {_new_name(info)}(n)",
                *from_parents,
                f"        return uow.{info['attr']}.{query_name(context, insert)}(entity)",
                "    }",
            ]
        )
    body: list[str] = []
    for index, block in enumerate(blocks):
        if index > 0:
            body.append("")
        body += block
    return kt_file(
        test_path(context, "Factories"),
        context["base"],
        imports.write(),
        [
            "/** Rows for the tests: valid values for every column, and the rows they point to. */",
            "object Factories {",
            *body,
            "}",
        ],
    )


# The test database


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


def _test(name: str, body: list) -> list[str]:
    flat: list = []
    for item in body:
        if isinstance(item, list):
            flat += item
        else:
            flat.append(item)
    return [
        "",
        "    @Test",
        f"    fun {name}() {{",
        *_ind([line for line in flat if isinstance(line, str)], 8),
        "    }",
    ]


def _when_set(columns: list[dict], assertion: str) -> list[str]:
    """An assertion on a stored row's values, made only when those that may be null have one."""
    optional = [column for column in columns if column["column"]["nullable"]]
    if not optional:
        return [assertion]
    conditions = " && ".join(f"stored.{column['prop']} != null" for column in optional)
    return [f"if ({conditions}) {assertion}"]


def _repository_tests(context: dict, info: dict) -> list[list[str]]:
    repo = f"uow.{info['attr']}"

    def key_of(variable: str) -> str:
        return ", ".join(stored(f"{variable}.{column['prop']}", column) for column in info["key"])

    def args(columns: list[dict]) -> str:
        return ", ".join(f"stored.{column['prop']}!!" for column in columns)

    get_by_key = query(info, "getByKey")
    listing = query(info, "list")
    tests: list[list[str]] = []
    stored1 = f"val stored = Factories.{_add_name(info)}(uow, 1)"
    unique_reads = [
        read for read in (query(info, "findByUnique", unique["columns"]) for unique in info["table"]["uniques"]) if read
    ]
    parent_reads = [
        read for read in (query(info, "listByParent", key["columns"]) for key in info["table"]["foreignKeys"]) if read
    ]
    checks: list[str] = []
    for read in unique_reads:
        columns = [column_of(info, name) for name in read["columns"]]
        checks += _when_set(columns, f"assertNotNull({repo}.{query_name(context, read)}({args(columns)}))")
    for read in parent_reads:
        columns = [column_of(info, name) for name in read["columns"]]
        checks += _when_set(columns, f"assertEquals(1, {repo}.{query_name(context, read)}({args(columns)}).size)")
    tests.append(
        _test(
            "isStoredAndReadBack",
            [
                stored1,
                get_by_key
                and [
                    f"val found = {repo}.{query_name(context, get_by_key)}({key_of('stored')})",
                    "assertNotNull(found)",
                    *(f"assertEquals(stored.{column['prop']}, found.{column['prop']})" for column in info["key"]),
                ],
                *checks,
            ],
        )
    )
    if listing:
        name = query_name(context, listing)
        paging = context["settings"]["paging"]
        if paging == "offset":
            reads = [
                f"val page = {repo}.{name}(0, 1)",
                "assertEquals(2L, page.total)",
                "assertEquals(1, page.items.size)",
            ]
        elif paging == "cursor":
            reads = [
                f"val first = {repo}.{name}(null, 1)",
                "assertEquals(1, first.items.size)",
                "assertNotNull(first.next)",
                f"val second = {repo}.{name}(first.next, 1)",
                "assertEquals(1, second.items.size)",
                "assertNull(second.next)",
            ]
        else:
            reads = [f"assertEquals(2, {repo}.{name}().size)"]
        tests.append(
            _test(
                "listsRowsByKey",
                [f"Factories.{_add_name(info)}(uow, 1)", f"Factories.{_add_name(info)}(uow, 2)", reads],
            )
        )
    update = query(info, "update")
    text = _changeable_text(info)
    if update and get_by_key and text:
        tests.append(
            _test(
                "storesTheChanges",
                [
                    stored1,
                    f'stored.{text["prop"]} = "changed"',
                    f"{repo}.{query_name(context, update)}(stored)",
                    f'assertEquals("changed", {repo}.{query_name(context, get_by_key)}({key_of("stored")})?.{text["prop"]})',
                ],
            )
        )
    remove = query(info, "delete")
    if remove and get_by_key and not info["soft"]:
        tests.append(
            _test(
                "isDeleted",
                [
                    stored1,
                    f"{repo}.{query_name(context, remove)}(stored)",
                    f"assertNull({repo}.{query_name(context, get_by_key)}({key_of('stored')}))",
                ],
            )
        )
    return tests


def _service_tests(context: dict, info: dict, imports: KtImports) -> list[list[str]]:
    service = service_class(info)
    imports.add(qualified(package_of(context, info, "service"), service))
    dtos = context["settings"]["serviceTypes"] == "dtos"
    ops = {f"{operation['kind']}:{','.join(operation['columns'])}": operation for operation in info["operations"]}

    def op(kind: str, columns: list[str] | None = None) -> dict | None:
        return ops.get(f"{kind}:{','.join(columns or [])}")

    create = op("create")
    get = op("get")
    update = op("update") if op("update") and query(info, "update") and query(info, "getByKey") else None
    remove = op("delete")

    def member(variable: str, column: dict) -> str:
        """A column of what the service returns, known to be set."""
        return f"{variable}.{column['prop']}" if dtos else stored(f"{variable}.{column['prop']}", column)

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
        parents_first.append(f"val parent{index} = Factories.{_add_name(parent)}(uow, 100)")
        for position, column in enumerate(key["columns"]):
            target = column_of(parent, key["references"]["columns"][position])["prop"]
            overrides.append({"column": column, "value": f"parent{index}.{target}"})

    def row(variable: str, n: int, extra: list[dict] | None = None) -> list[str]:
        extra = extra or []
        given = {item["column"] for item in extra}
        items = [*(item for item in overrides if item["column"] not in given), *extra]
        return [
            f"val {variable} = Factories.{_new_name(info)}({n})",
            *(f"{variable}.{column_of(info, item['column'])['prop']} = {item['value']}" for item in items),
        ]

    def input_of(variable: str) -> str:
        return f"createOf({variable})" if dtos else variable

    def changes(target: dict, value: str, source: str) -> str:
        """The changes of an update that sets one field, and keeps the others as the row has them."""
        imports.add(update_class(context, info))
        mode = context["settings"]["updates"]
        if mode == "patch":
            imports.add(qualified(common_package(context), "Patch"))
            return f"{update_type(context, info)}({target['prop']} = Patch.of({value}))"
        if mode == "optional":
            imports.add("java.util.Optional")
            return f"{update_type(context, info)}({target['prop']} = Optional.of({value}))"
        fields = ", ".join(
            f"{column['prop']} = {value if column is target else stored(source + '.' + column['prop'], column)}"
            for column in update_columns(info)
        )
        return f"{update_type(context, info)}({fields})"

    def version(variable: str) -> str:
        return f", {member(variable, info['version'])}" if info["version"] else ""

    tests: list[list[str]] = []
    opened = [f"val service = {service}(uow)"]
    if create:
        name = operation_name(context, create)
        tests.append(
            _test(
                "createsAValidRow",
                [
                    *opened,
                    *parents_first,
                    *row("row", 1),
                    f"val created = service.{name}({input_of('row')})",
                    [
                        f"val found = service.{operation_name(context, get)}({key_of('created')})",
                        *(f"assertEquals(created.{column['prop']}, found.{column['prop']})" for column in info["key"]),
                    ]
                    if get
                    else [f"assertNotNull(created.{column['prop']})" for column in info["key"]],
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
            imports.add(qualified(errors_package(context), "ValidationFailedException"), "kotlin.test.assertFailsWith")
            tests.append(
                _test(
                    "refusesAMissingValue",
                    [
                        *opened,
                        *parents_first,
                        *row("row", 1, [{"column": required["column"]["name"], "value": "null"}]),
                        f"val error = assertFailsWith<ValidationFailedException> {{ service.{name}({input_of('row')}) }}",
                        f"assertEquals(listOf({kt_string(required['column']['name'])}), error.errors.map {{ it.field }})",
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
            imports.add(qualified(errors_package(context), "ConflictException"), "kotlin.test.assertFailsWith")
            own = [column_of(info, column) for column in unique["columns"]]
            tests.append(
                _test(
                    "refusesARepeatedUniqueValue",
                    [
                        *opened,
                        *parents_first,
                        *row("row", 1),
                        f"val first = service.{name}({input_of('row')})",
                        *row(
                            "again",
                            2,
                            [
                                {"column": column["column"]["name"], "value": f"first.{column['prop']}"}
                                for column in own
                            ],
                        ),
                        f"assertFailsWith<ConflictException> {{ service.{name}({input_of('again')}) }}",
                    ],
                )
            )
            if (
                update
                and len(own) == 1
                and all(not is_in(column, info["key"]) and not column["generated"] for column in own)
            ):
                # The value it already has; Optional.of takes it only as known to be set
                kept = (
                    f"{member('created', own[0])}!!"
                    if context["settings"]["updates"] == "optional" and own[0]["column"]["nullable"]
                    else member("created", own[0])
                )
                tests.append(
                    _test(
                        "keepsItsOwnUniqueValue",
                        [
                            *opened,
                            *parents_first,
                            *row("row", 1),
                            f"val created = service.{name}({input_of('row')})",
                            f"val updated = service.{operation_name(context, update)}({key_of('created')}, {changes(own[0], kept, 'row')}{version('created')})",
                            f"assertEquals(created.{own[0]['prop']}, updated.{own[0]['prop']})",
                        ],
                    )
                )

        def has_parent(key: dict) -> bool:
            parent = find_info(context, key["references"]["table"])
            return bool(parent and query(parent, "getByKey") and len(key["columns"]) == 1)

        parent_key = next((key for key in info["table"]["foreignKeys"] if has_parent(key)), None)
        if parent_key:
            imports.add(qualified(errors_package(context), "ValidationFailedException"), "kotlin.test.assertFailsWith")
            column = column_of(info, parent_key["columns"][0])
            tests.append(
                _test(
                    "refusesAMissingParent",
                    [
                        *opened,
                        *parents_first,
                        *row("row", 1, [{"column": column["column"]["name"], "value": missing_value(column, imports)}]),
                        f"val error = assertFailsWith<ValidationFailedException> {{ service.{name}({input_of('row')}) }}",
                        f"assertTrue({kt_string(parent_key['columns'][0])} in error.errors.map {{ it.field }})",
                    ],
                )
            )
    if get:
        imports.add(qualified(errors_package(context), "NotFoundException"), "kotlin.test.assertFailsWith")
        missing = ", ".join(missing_value(column, imports) for column in info["key"])
        tests.append(
            _test(
                "saysWhenARowIsMissing",
                [
                    *opened,
                    f"assertFailsWith<NotFoundException> {{ service.{operation_name(context, get)}({missing}) }}",
                ],
            )
        )
    text = _changeable_text(info)
    if create and update and text:
        changed = changes(text, '"changed"', "row")
        tests.append(
            _test(
                "changesARow",
                [
                    *opened,
                    *parents_first,
                    *row("row", 1),
                    f"val created = service.{operation_name(context, create)}({input_of('row')})",
                    f"val updated = service.{operation_name(context, update)}({key_of('created')}, {changed}{version('created')})",
                    f'assertEquals("changed", updated.{text["prop"]})',
                ],
            )
        )
    if create and remove and get:
        imports.add(qualified(errors_package(context), "NotFoundException"), "kotlin.test.assertFailsWith")
        tests.append(
            _test(
                "deletesARow",
                [
                    *opened,
                    *parents_first,
                    *row("row", 1),
                    f"val created = service.{operation_name(context, create)}({input_of('row')})",
                    f"service.{operation_name(context, remove)}({key_of('created')}{version('created')})",
                    f"assertFailsWith<NotFoundException> {{ service.{operation_name(context, get)}({key_of('created')}) }}",
                ],
            )
        )
    return tests


def _create_of_helper(context: dict, info: dict, imports: KtImports) -> list[str]:
    """Builds a create DTO from a factory row: the values of its fields."""
    imports.add(qualified(package_of(context, info, "dtos"), create_dto(info)))
    return [
        "",
        "    /** The create DTO of a row the factories made. */",
        f"    private fun createOf(row: {info['entity']}) = {create_dto(info)}(",
        *(f"        {column['prop']} = row.{column['prop']}," for column in create_columns(info)),
        "    )",
    ]


ASSERTIONS = [
    "kotlin.test.Test",
    "kotlin.test.BeforeTest",
    "kotlin.test.assertEquals",
    "kotlin.test.assertNotNull",
    "kotlin.test.assertNull",
    "kotlin.test.assertTrue",
]


def open_test(context: dict) -> list[str]:
    """What a test class over the test database does after opening the unit of work."""
    return [f"        {line}" for line in context["orm"]["openTest"](context)]


def close_test(context: dict) -> list[str]:
    """What it does when a test ends."""
    if not context["orm"]["closeTest"]:
        return []
    return [
        "",
        "    @AfterTest",
        "    fun close() {",
        *(f"        {line}" for line in context["orm"]["closeTest"]),
        "    }",
    ]


def test_files(context: dict) -> list[dict]:
    tests = context["settings"]["tests"]
    if tests == "none" or not writes_entities(context):
        return []
    makeable = [info for info in context["tables"] if can_make(context, info)]
    files = [*context["orm"]["testDatabaseFiles"](context), _factories_file(context, makeable)]
    memory = context["settings"]["memoryRepositories"]
    for info in makeable:
        entity_class = qualified(package_of(context, info, "entity"), info["entity"])
        if tests in ("all", "repositories"):
            imports = KtImports(context["base"]).add(
                *ASSERTIONS, *(["kotlin.test.AfterTest"] if context["orm"]["closeTest"] else [])
            )
            blocks = _repository_tests(context, info)
            files.append(
                kt_file(
                    test_path(context, f"{info['entity']}RepositoryTest"),
                    context["base"],
                    imports.write(),
                    [
                        f'/** The repository of the "{info["name"]}" table, against the test database. */',
                        f"class {info['entity']}RepositoryTest {{",
                        "    /** The repositories over the test database, opened empty for every test */",
                        "    private lateinit var uow: SqlUnitOfWork",
                        "",
                        "    @BeforeTest",
                        "    fun open() {",
                        "        uow = TestDatabase.open()",
                        *open_test(context),
                        "    }",
                        *close_test(context),
                        *(line for block in blocks for line in block),
                        "}",
                    ],
                )
            )
        if tests in ("all", "services") and info["service"] is not None:
            imports = KtImports(context["base"]).add(
                *ASSERTIONS, *(["kotlin.test.AfterTest"] if context["orm"]["closeTest"] else [])
            )
            blocks = _service_tests(context, info, imports)
            if not blocks:
                continue
            dtos_helper = (
                context["settings"]["serviceTypes"] == "dtos"
                and query(info, "insert")
                and any(operation["kind"] == "create" for operation in info["operations"])
            )
            if dtos_helper:
                imports.add(entity_class)
            helper = _create_of_helper(context, info, imports) if dtos_helper else []
            files.append(
                kt_file(
                    test_path(context, f"{service_class(info)}Test"),
                    context["base"],
                    imports.write(),
                    [
                        f'/** The service of the "{info["name"]}" table, on {"the in-memory repositories" if memory else "the test database"}. */',
                        f"class {service_class(info)}Test {{",
                        "    private lateinit var uow: MemoryUnitOfWork"
                        if memory
                        else "    private lateinit var uow: SqlUnitOfWork",
                        "",
                        "    @BeforeTest",
                        "    fun open() {",
                        "        uow = MemoryUnitOfWork()" if memory else "        uow = TestDatabase.open()",
                        *([] if memory else open_test(context)),
                        "    }",
                        *([] if memory else close_test(context)),
                        *(line for block in blocks for line in block),
                        *helper,
                        "}",
                    ],
                )
            )
    return files
