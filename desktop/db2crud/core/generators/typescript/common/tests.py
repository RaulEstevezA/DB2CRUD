"""The tests of a generated project, which are also what the verification runs (Vitest): factories that build valid
rows (and their parents first), repository tests against a real database created from the entities, and service
tests on the in-memory unit of work (or on the database when the project has no memory repositories). Mirrors
web/src/core/generators/typescript/common/tests.ts."""

from ...types import indent, lines
from ..samples import missing_value, sample_value
from ..typescript import TsImports
from .context import (
    column_of,
    find_info,
    is_in,
    module_of,
    operation_name,
    query,
    query_name,
    service_class,
    writes_entities,
)
from .dtos import create_columns, create_dto, update_columns


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


# test/factories.ts


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    imports = TsImports("test/factories").type("src/unit-of-work", "UnitOfWork")
    blocks = []
    for info in makeable:
        imports.from_(module_of(context, info, "entity"), info["entity"])
        parents = []
        parent_of: dict[str, str] = {}
        for index, key in enumerate(info["table"]["foreignKeys"]):
            parent = find_info(context, key["references"]["table"])
            if _is_nullable_key(info, key) or not parent:
                continue
            variable = f"parent{index}"
            parents.append(f"const {variable} = await {_add_name(parent)}(uow, n)")
            for position, column in enumerate(key["columns"]):
                parent_of[column] = f"{variable}.{column_of(parent, key['references']['columns'][position])['prop']}"
        # Foreign keys to a required parent are set by add*, from the parent it stores first
        values = []
        for column in info["columns"]:
            if column["generated"] or column["column"]["name"] in parent_of:
                continue
            is_key = any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            # A new row is not marked as deleted
            soft = (
                ("false" if column["column"]["type"]["kind"] == "boolean" else "null")
                if column is info["soft"]
                else None
            )
            if soft is not None:
                value = soft
            elif column["column"]["nullable"] and is_key:
                value = "null"
            else:
                value = sample_value(column["column"], info["table"]["checks"], context["schema"]["enums"])
            values.append(f"{column['prop']}: {value}")
        insert = query(info, "insert")
        from_parents = [f"{column_of(info, column)['prop']}: {value}" for column, value in parent_of.items()]
        entity = info["entity"]
        pointed = ", with the rows it points to" if parents else ""
        overrides = f", {{ {', '.join(from_parents)} }}" if from_parents else ""
        blocks.append(
            lines(
                f"/** A valid {entity} that is not stored yet; `n` makes its unique values differ, `values` replace any of them. */",
                f"export function {_new_name(info)}(n = 1, values: Partial<{entity}> = {{}}): {entity} {{",
                f"  return Object.assign(new {entity}(), {{ {', '.join(values)} }}, values)",
                "}",
                "",
                f"/** A stored {entity}{pointed}. */",
                f"export async function {_add_name(info)}(uow: UnitOfWork, n = 1): Promise<{entity}> {{",
                *(f"  {line}" for line in parents),
                f"  return uow.{info['attr']}.{query_name(context, insert)}({_new_name(info)}(n{overrides}))",
                "}",
            )
        )
    content = lines(
        "/** Rows for the tests: valid values for every column, and the rows they point to. */",
        imports.write(),
        *[item for block in blocks for item in ("", block)],
        "",
    )
    return {"path": "test/factories.ts", "content": content}


def _changeable_text(info: dict) -> dict | None:
    """A text column the tests can change and read back, when the table has one."""
    for column in update_columns(info):
        db = column["column"]
        name = db["name"]
        if (
            db["type"]["kind"] == "text"
            and not db["type"].get("fixed")
            and name not in info["hidden"]
            and db["type"].get("length", 40) >= 7
            and not any((check.get("parsed") or {}).get("column") == name for check in info["table"]["checks"])
            and not any(name in unique["columns"] for unique in info["table"]["uniques"])
            and not any(name in key["columns"] for key in info["table"]["foreignKeys"])
        ):
            return column
    return None


def _test(name: str, body: list) -> list:
    return [f"it('{name}', async () => {{", indent(lines(*body), 2), "})"]


def _describe(name: str, tests: list[list]) -> list:
    return [
        "",
        f"describe('{name}', () => {{",
        *[item for index, test in enumerate(tests) for item in ("" if index > 0 else None, indent(lines(*test), 2))],
        "})",
    ]


# Repository tests


def _repository_tests(context: dict, info: dict, imports: TsImports) -> list[list]:
    repo = f"uow.{info['attr']}"

    def key_of(variable: str) -> str:
        return ", ".join(f"{variable}.{column['prop']}" for column in info["key"])

    def props(names: list[str]) -> list[str]:
        return [f"stored.{column_of(info, name)['prop']}" for name in names]

    opening = "const uow = sqlUow()"
    add = _add_name(info)
    imports.from_("test/factories", add)
    get_by_key = query(info, "getByKey")
    listing = query(info, "list")
    tests = []
    uniques = [
        read for read in (query(info, "findByUnique", unique["columns"]) for unique in info["table"]["uniques"]) if read
    ]
    by_parent = [
        read for read in (query(info, "listByParent", key["columns"]) for key in info["table"]["foreignKeys"]) if read
    ]
    tests.append(
        _test(
            "is stored and read back",
            [
                opening,
                f"const stored = await {add}(uow, 1)",
                bool(get_by_key)
                and [
                    f"const found = await {repo}.{query_name(context, get_by_key)}({key_of('stored')})",
                    "expect(found).not.toBeNull()",
                ],
                bool(get_by_key)
                and [f"expect(found!.{column['prop']}).toEqual(stored.{column['prop']})" for column in info["key"]],
                *(
                    f"expect(await {repo}.{query_name(context, read)}({', '.join(props(read['columns']))})).not.toBeNull()"
                    for read in uniques
                ),
                *(
                    f"if ({' && '.join(f'{prop} != null' for prop in props(read['columns']))}) expect(await {repo}.{query_name(context, read)}({', '.join(props(read['columns']))})).toHaveLength(1)"
                    for read in by_parent
                ),
            ],
        )
    )
    if listing:
        name = query_name(context, listing)
        paging = context["settings"]["paging"]
        if paging == "offset":
            check = [
                f"const page = await {repo}.{name}(0, 1)",
                "expect(page.total).toBe(2)",
                "expect(page.items).toHaveLength(1)",
            ]
        elif paging == "cursor":
            check = [
                f"const first = await {repo}.{name}(null, 1)",
                "expect(first.items).toHaveLength(1)",
                "expect(first.next).not.toBeNull()",
                f"const second = await {repo}.{name}(first.next, 1)",
                "expect(second.items).toHaveLength(1)",
                "expect(second.next).toBeNull()",
            ]
        else:
            check = [f"expect(await {repo}.{name}()).toHaveLength(2)"]
        tests.append(_test("lists rows by key", [opening, f"await {add}(uow, 1)", f"await {add}(uow, 2)", check]))
    update = query(info, "update")
    text = _changeable_text(info)
    if update and get_by_key and text:
        tests.append(
            _test(
                "stores the changes",
                [
                    opening,
                    f"const stored = await {add}(uow, 1)",
                    f"stored.{text['prop']} = 'changed'",
                    f"await {repo}.{query_name(context, update)}(stored)",
                    f"const found = await {repo}.{query_name(context, get_by_key)}({key_of('stored')})",
                    f"expect(found?.{text['prop']}).toBe('changed')",
                ],
            )
        )
    remove = query(info, "delete")
    if remove and get_by_key and not info["soft"]:
        tests.append(
            _test(
                "is deleted",
                [
                    opening,
                    f"const stored = await {add}(uow, 1)",
                    f"await {repo}.{query_name(context, remove)}(stored)",
                    f"expect(await {repo}.{query_name(context, get_by_key)}({key_of('stored')})).toBeNull()",
                ],
            )
        )
    return tests


# Service tests


def _service_tests(context: dict, info: dict, imports: TsImports, memory: bool) -> list[list]:
    service = service_class(info)
    imports.from_(module_of(context, info, "service"), service)
    dtos = context["settings"]["serviceTypes"] == "dtos"
    ops = {f"{operation['kind']}:{','.join(operation['columns'])}": operation for operation in info["operations"]}

    def op(kind: str, columns: list[str] | None = None) -> dict | None:
        return ops.get(f"{kind}:{','.join(columns or [])}")

    create = op("create")
    get = op("get")
    update = op("update")
    remove = op("delete")

    def key_of(variable: str) -> str:
        return ", ".join(f"{variable}.{column['prop']}" for column in info["key"])

    opening = [
        "const uow = new MemoryUnitOfWork()" if memory else "const uow = sqlUow()",
        f"const service = new {service}(uow)",
    ]
    # Rows go in through the service (when it creates them) and the parents through the factories
    parents_first = []
    overrides = []
    for index, key in enumerate(info["table"]["foreignKeys"]):
        parent = find_info(context, key["references"]["table"])
        if not parent or not _can_make(context, parent):
            continue
        imports.from_("test/factories", _add_name(parent))
        parents_first.append(f"const parent{index} = await {_add_name(parent)}(uow, n)")
        for position, column in enumerate(key["columns"]):
            target = column_of(parent, key["references"]["columns"][position])["prop"]
            overrides.append(f"{column_of(info, column)['prop']}: parent{index}.{target}")
    start = [*opening, "const n = 1", *parents_first]

    def factory(n: int, extra: list[str] | None = None) -> str:
        values = [*overrides, *(extra or [])]
        given = f", {{ {', '.join(values)} }}" if values else ""
        return f"{_new_name(info)}({n}{given})"

    def fresh(n: int, extra: list[str] | None = None) -> str:
        return f"pick<{create_dto(info)}>({factory(n, extra)}, CREATE_FIELDS)" if dtos else factory(n, extra)

    version = f", created.{info['version']['prop']}" if info["version"] else ""
    tests = []
    if create:
        imports.from_("test/factories", _new_name(info))
        if dtos:
            imports.type(module_of(context, info, "dtos"), create_dto(info))
        name = operation_name(context, create)
        tests.append(
            _test(
                "creates a valid row",
                [
                    *start,
                    f"const created = await service.{name}({fresh(1)})",
                    bool(get)
                    and [
                        f"const found = await service.{operation_name(context, get)}({key_of('created')})",
                        *(
                            f"expect(found.{column['prop']}).toEqual(created.{column['prop']})"
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
            imports.from_("src/errors", "ValidationFailedError")
            missing = (
                f"{{ ...{fresh(1)}, {required['prop']}: null }} as unknown as {create_dto(info)}"
                if dtos
                else factory(1, [f"{required['prop']}: null as never"])
            )
            tests.append(
                _test(
                    "refuses a missing value",
                    [
                        *start,
                        f"const error: unknown = await service.{name}({missing}).catch((caught: unknown) => caught)",
                        "expect(error).toBeInstanceOf(ValidationFailedError)",
                        f"expect((error as ValidationFailedError).errors.map((item) => item.field)).toEqual(['{required['column']['name']}'])",
                    ],
                )
            )
        unique = next((item for item in info["table"]["uniques"] if query(info, "findByUnique", item["columns"])), None)
        if unique:
            imports.from_("src/errors", "ConflictError")
            own = [column_of(info, column) for column in unique["columns"]]
            same = [f"{column['prop']}: first.{column['prop']}" for column in own]
            tests.append(
                _test(
                    "refuses a repeated unique value",
                    [
                        *start,
                        f"const first = await service.{name}({fresh(1)})",
                        f"await expect(service.{name}({fresh(2, same)})).rejects.toBeInstanceOf(ConflictError)",
                    ],
                )
            )
            # A row keeps its own unique value when it changes: the check must not take it for another row
            if update and all(not is_in(column, info["key"]) and not column["generated"] for column in own):
                kept = ", ".join(f"{column['prop']}: created.{column['prop']}" for column in own)
                tests.append(
                    _test(
                        "keeps its own unique value",
                        [
                            *start,
                            f"const created = await service.{name}({fresh(1)})",
                            f"await service.{operation_name(context, update)}({key_of('created')}, {{ {kept} }}{version})",
                        ],
                    )
                )

        def checks_parent(key: dict) -> bool:
            parent = find_info(context, key["references"]["table"])
            return bool(parent and query(parent, "getByKey") and len(key["columns"]) == 1)

        parent_key = next((key for key in info["table"]["foreignKeys"] if checks_parent(key)), None)
        if parent_key:
            imports.from_("src/errors", "ValidationFailedError")
            column = column_of(info, parent_key["columns"][0])
            others = [item for item in overrides if not item.startswith(f"{column['prop']}:")]
            values = [*others, f"{column['prop']}: {missing_value(column['column']['type'])}"]
            row = f"{_new_name(info)}(1, {{ {', '.join(values)} }})"
            argument = f"pick<{create_dto(info)}>({row}, CREATE_FIELDS)" if dtos else row
            tests.append(
                _test(
                    "refuses a missing parent",
                    [
                        *start,
                        f"const error: unknown = await service.{name}({argument}).catch((caught: unknown) => caught)",
                        "expect(error).toBeInstanceOf(ValidationFailedError)",
                        f"expect((error as ValidationFailedError).errors.map((item) => item.field)).toContain('{parent_key['columns'][0]}')",
                    ],
                )
            )
    if get:
        imports.from_("src/errors", "NotFoundError")
        missing_keys = ", ".join(missing_value(column["column"]["type"]) for column in info["key"])
        tests.append(
            _test(
                "says when a row is missing",
                [
                    *opening,
                    f"await expect(service.{operation_name(context, get)}({missing_keys})).rejects.toBeInstanceOf(NotFoundError)",
                ],
            )
        )
    text = _changeable_text(info)
    if create and update and text:
        tests.append(
            _test(
                "changes a row",
                [
                    *start,
                    f"const created = await service.{operation_name(context, create)}({fresh(1)})",
                    f"const updated = await service.{operation_name(context, update)}({key_of('created')}, {{ {text['prop']}: 'changed' }}{version})",
                    f"expect(updated.{text['prop']}).toBe('changed')",
                ],
            )
        )
    if create and remove and get:
        imports.from_("src/errors", "NotFoundError")
        tests.append(
            _test(
                "deletes a row",
                [
                    *start,
                    f"const created = await service.{operation_name(context, create)}({fresh(1)})",
                    f"await service.{operation_name(context, remove)}({key_of('created')}{version})",
                    f"await expect(service.{operation_name(context, get)}({key_of('created')})).rejects.toBeInstanceOf(NotFoundError)",
                ],
            )
        )
    return tests


def _pick_helper(info: dict) -> list:
    """Builds a create DTO from a factory row: the values of its fields only."""
    fields = ", ".join(f"'{column['prop']}'" for column in create_columns(info))
    return [
        "",
        "/** Fields of the create DTO */",
        f"const CREATE_FIELDS = [{fields}]",
        "",
        "/** The values a DTO takes, from a row the factories made. */",
        "function pick<T>(row: object, fields: readonly string[]): T {",
        "  return Object.fromEntries(Object.entries(row).filter(([name]) => fields.includes(name))) as T",
        "}",
    ]


def test_files(context: dict) -> list[dict]:
    tests = context["settings"]["tests"]
    if tests == "none" or not writes_entities(context):
        return []
    makeable = [info for info in context["tables"] if _can_make(context, info)]
    files = [*context["orm"]["testDatabase"](context), _factories_file(context, makeable)]
    memory = context["settings"]["memoryRepositories"]
    for info in makeable:
        module = f"test/{info['file']}.test"
        imports = TsImports(module).from_("vitest", "describe", "expect", "it")
        blocks: list = []
        database = False
        if tests in ("all", "repositories"):
            blocks.extend(_describe(f"{info['name']} repository", _repository_tests(context, info, imports)))
            database = True
        if tests in ("all", "services") and info["service"] is not None:
            if memory:
                imports.from_("src/unit-of-work", "MemoryUnitOfWork")
            else:
                database = True
            service_blocks = _service_tests(context, info, imports, memory)
            if service_blocks:
                blocks.extend(_describe(service_class(info), service_blocks))
            if (
                context["settings"]["serviceTypes"] == "dtos"
                and query(info, "insert")
                and any(operation["kind"] == "create" for operation in info["operations"])
            ):
                blocks.extend(_pick_helper(info))
        if not blocks:
            continue
        if database:
            imports.from_("test/database", "useTestDatabase")
        content = lines(
            f'/** Tests of the "{info["name"]}" table. */',
            imports.write(),
            database
            and [
                "",
                "/** The repositories over the test database, opened empty for every test */",
                "const sqlUow = useTestDatabase()",
            ],
            *blocks,
            "",
        )
        files.append({"path": f"{module}.ts", "content": content})
    return files
