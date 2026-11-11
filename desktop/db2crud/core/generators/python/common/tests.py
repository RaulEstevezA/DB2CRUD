"""The tests of a generated project, which are also what the verification runs: factories, repository tests against
a real database and service tests on the in-memory unit of work. Mirrors
web/src/core/generators/python/sqlalchemy/tests.ts."""

from ...types import indent, lines
from ..python import Imports
from ..samples import missing_value, sample_value
from .context import aw, find_info, module_of, operation_name, query, query_name, service_class, writes_entities
from .dtos import create_dto, update_columns, update_dto


def _column(info: dict, name: str) -> dict:
    return next(column for column in info["columns"] if column["column"]["name"] == name)


def _nullable_key(info: dict, key: dict) -> bool:
    return all(_column(info, name)["column"]["nullable"] for name in key["columns"])


def can_make(context: dict, info: dict, seen: frozenset = frozenset()) -> bool:
    """Tables whose rows the tests can make: they can be inserted, and so can the parents they need."""
    if info["name"] in seen or not query(info, "insert"):
        return False
    following = seen | {info["name"]}
    for key in info["table"]["foreignKeys"]:
        if _nullable_key(info, key):
            continue
        parent = find_info(context, key["references"]["table"])
        if parent is None or not can_make(context, parent, following):
            return False
    return True


def _def(context: dict) -> str:
    return "async def" if context["async"] else "def"


# tests/factories.py


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    imports = Imports().from_("app.unit_of_work", "UnitOfWork")
    a = aw(context)
    blocks = []
    for info in makeable:
        imports.from_(module_of(context, info, "entity"), info["entity"])
        parents = []
        parent_of: dict[str, str] = {}
        for index, key in enumerate(info["table"]["foreignKeys"]):
            parent = find_info(context, key["references"]["table"])
            if _nullable_key(info, key) or not parent:
                continue
            variable = f"parent_{index}"
            parents.append(f"{variable} = {a}add_{parent['module']}(uow, n)")
            for position, column in enumerate(key["columns"]):
                target = _column(parent, key["references"]["columns"][position])
                parent_of[column] = f"{variable}.{target['attr']}"
        values = []
        # Foreign keys to a required parent are set by add_*, from the parent it stores first
        for column in [item for item in info["columns"] if not item["generated"]]:
            if column["column"]["name"] in parent_of:
                continue
            is_key = any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            # A new row is not marked as deleted
            if column is info["soft"]:
                value = "False" if column["column"]["type"]["kind"] == "boolean" else "None"
            elif column["column"]["nullable"] and is_key:
                value = "None"
            else:
                value = sample_value(column["column"], info["table"]["checks"], context["schema"]["enums"], imports)
            values.append(f'"{column["attr"]}": {value}')
        insert = query(info, "insert")
        from_parents = [f"{_column(info, column)['attr']}={value}" for column, value in parent_of.items()]
        blocks.append(
            lines(
                f"def new_{info['module']}(n: int = 1, **values: Any) -> {info['entity']}:",
                f'    """A valid {info["entity"]} that is not stored yet; `n` makes its unique values differ, '
                '`values` replace any of them."""',
                f"    defaults: dict[str, Any] = {{{', '.join(values)}}}",
                f"    return {info['entity']}(**(defaults | values))",
                "",
                "",
                f"{_def(context)} add_{info['module']}(uow: UnitOfWork, n: int = 1) -> {info['entity']}:",
                f'    """A stored {info["entity"]}{", with the rows it points to" if parents else ""}."""',
                *[f"    {line}" for line in parents],
                f"    return {a}uow.{info['attr']}.{query_name(context, insert)}"
                f"(new_{info['module']}({', '.join(['n', *from_parents])}))",
            )
        )
    imports.from_("typing", "Any")
    content = lines(
        '"""Rows for the tests: valid values for every column, and the rows they point to."""',
        "",
        imports.write("app"),
        *[item for block in blocks for item in ["", "", block]],
        "",
    )
    return {"path": "tests/factories.py", "content": content}


# Repository tests


def _changeable_text(info: dict) -> dict | None:
    """A text column the tests can change and read back, when the table has one."""
    table = info["table"]
    for column in update_columns(info):
        column_type = column["column"]["type"]
        name = column["column"]["name"]
        if (
            column_type["kind"] == "text"
            and not column_type.get("fixed")
            and name not in info["hidden"]
            and column_type.get("length", 40) >= 7
            and not any(check.get("parsed") and check["parsed"]["column"] == name for check in table["checks"])
            and not any(name in unique["columns"] for unique in table["uniques"])
            and not any(name in key["columns"] for key in table["foreignKeys"])
        ):
            return column
    return None


def _repository_tests(context: dict, info: dict, imports: Imports) -> list:
    a = aw(context)
    repo = f"sql_uow.{info['attr']}"
    module = info["module"]

    def key_of(variable: str) -> str:
        return ", ".join(f"{variable}.{column['attr']}" for column in info["key"])

    def stored_args(columns: list[str], separator: str) -> str:
        return separator.join(f"stored.{_column(info, name)['attr']}" for name in columns)

    def test(name: str, body: list) -> list:
        return [
            "",
            "",
            f"{_def(context)} test_{module}_{name}({context['orm']['databaseFixture']}) -> None:",
            indent(lines(*body)),
        ]

    imports.from_("tests.factories", f"add_{module}")
    get_by_key = query(info, "getByKey")
    listing = query(info, "list")
    blocks = []
    uniques = [
        read for read in (query(info, "findByUnique", unique["columns"]) for unique in info["table"]["uniques"]) if read
    ]
    parents = [
        read for read in (query(info, "listByParent", key["columns"]) for key in info["table"]["foreignKeys"]) if read
    ]
    blocks += test(
        "is_stored_and_read_back",
        [
            f"stored = {a}add_{module}(sql_uow, 1)",
            bool(get_by_key) and f"found = {a}{repo}.{query_name(context, get_by_key)}({key_of('stored')})",
            bool(get_by_key) and "assert found is not None",
            bool(get_by_key)
            and [f"assert found.{column['attr']} == stored.{column['attr']}" for column in info["key"]],
            *[
                f"assert {a}{repo}.{query_name(context, read)}({stored_args(read['columns'], ', ')}) is not None"
                for read in uniques
            ],
            *[
                f"assert {stored_args(read['columns'], ' is None or ')} is None or "
                f"len({a}{repo}.{query_name(context, read)}({stored_args(read['columns'], ', ')})) == 1"
                for read in parents
            ],
        ],
    )
    if listing:
        name = query_name(context, listing)
        paging = context["settings"]["paging"]
        if paging == "offset":
            check = [f"page = {a}{repo}.{name}(0, 1)", "assert page.total == 2", "assert len(page.items) == 1"]
        elif paging == "cursor":
            check = [
                f"first = {a}{repo}.{name}(None, 1)",
                "assert len(first.items) == 1 and first.next is not None",
                f"second = {a}{repo}.{name}(first.next, 1)",
                "assert len(second.items) == 1 and second.next is None",
            ]
        else:
            check = [f"assert len({a}{repo}.{name}()) == 2"]
        blocks += test("lists_rows_by_key", [f"{a}add_{module}(sql_uow, 1)", f"{a}add_{module}(sql_uow, 2)", check])
    update = query(info, "update")
    text = _changeable_text(info)
    if update and get_by_key and text:
        blocks += test(
            "changes_are_stored",
            [
                f"stored = {a}add_{module}(sql_uow, 1)",
                f'stored.{text["attr"]} = "changed"',
                f"{a}{repo}.{query_name(context, update)}(stored)",
                f"found = {a}{repo}.{query_name(context, get_by_key)}({key_of('stored')})",
                f'assert found is not None and found.{text["attr"]} == "changed"',
            ],
        )
    remove = query(info, "delete")
    if remove and get_by_key and not info["soft"]:
        blocks += test(
            "is_deleted",
            [
                f"stored = {a}add_{module}(sql_uow, 1)",
                f"{a}{repo}.{query_name(context, remove)}(stored)",
                f"assert {a}{repo}.{query_name(context, get_by_key)}({key_of('stored')}) is None",
            ],
        )
    return blocks


# Service tests


def _service_tests(context: dict, info: dict, imports: Imports, uow: str) -> list:
    a = aw(context)
    service = service_class(info)
    module = info["module"]
    imports.from_(module_of(context, info, "service"), service)
    dtos = context["settings"]["serviceTypes"] == "dtos"
    operations = {
        f"{operation['kind']}:{','.join(operation['columns'])}": operation for operation in info["operations"]
    }

    def op(kind: str) -> dict | None:
        return operations.get(f"{kind}:")

    create, get = op("create"), op("get")

    def key_of(variable: str) -> str:
        return ", ".join(f"{variable}.{column['attr']}" for column in info["key"])

    uow_name = uow.split(":")[0]

    def test(name: str, body: list) -> list:
        return [
            "",
            "",
            f"{_def(context)} test_{module}_service_{name}({uow}) -> None:",
            f"    service = {service}({uow_name})",
            indent(lines(*body)),
        ]

    blocks = []
    # Rows go in through the service (when it creates them) and the parents through the factories
    parents_first = []
    overrides = []
    for index, key in enumerate(info["table"]["foreignKeys"]):
        parent = find_info(context, key["references"]["table"])
        if not parent or not can_make(context, parent):
            continue
        imports.from_("tests.factories", f"add_{parent['module']}")
        parents_first.append(f"parent_{index} = {a}add_{parent['module']}({uow_name}, n)")
        for position, column in enumerate(key["columns"]):
            target = _column(parent, key["references"]["columns"][position])
            overrides.append(f"{_column(info, column)['attr']}=parent_{index}.{target['attr']}")

    def built(args: str) -> str:
        return (
            f"{create_dto(info)}(**_values(new_{module}({args}), {create_dto(info)}))"
            if dtos
            else f"new_{module}({args})"
        )

    base_args = ", ".join(["1", *overrides])
    if create:
        imports.from_("tests.factories", f"new_{module}")
        if dtos:
            imports.from_(module_of(context, info, "dtos"), create_dto(info))
        name = operation_name(context, create)
        blocks += test(
            "creates_a_valid_row",
            [
                "n = 1",
                *parents_first,
                f"created = {a}service.{name}({built(base_args)})",
                bool(get) and f"found = {a}service.{operation_name(context, get)}({key_of('created')})",
                bool(get) and [f"assert found.{column['attr']} == created.{column['attr']}" for column in info["key"]],
            ],
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
            imports.from_("app.errors", "ValidationFailedError")
            attr = required["attr"]
            if dtos and context["settings"]["dtoKind"] == "dataclass":
                missing = f'{create_dto(info)}(**(_values(new_{module}({base_args}), {create_dto(info)}) | {{"{attr}": None}}))'
            elif dtos:
                missing = f'{create_dto(info)}.model_construct(**(_values(new_{module}({base_args}), {create_dto(info)}) | {{"{attr}": None}}))'
            else:
                missing = f"new_{module}({', '.join(['1', *overrides, f'{attr}=None'])})"
            blocks += test(
                "refuses_a_missing_value",
                [
                    "n = 1",
                    *parents_first,
                    "with pytest.raises(ValidationFailedError) as raised:",
                    f"    {a}service.{name}({missing})",
                    f'assert [error.field for error in raised.value.errors] == ["{required["column"]["name"]}"]',
                ],
            )
        unique = next((item for item in info["table"]["uniques"] if query(info, "findByUnique", item["columns"])), None)
        if unique:
            imports.from_("app.errors", "ConflictError")
            same = [f"{_column(info, name)['attr']}=first.{_column(info, name)['attr']}" for name in unique["columns"]]
            blocks += test(
                "refuses_a_repeated_unique_value",
                [
                    "n = 1",
                    *parents_first,
                    f"first = {a}service.{name}({built(base_args)})",
                    "with pytest.raises(ConflictError):",
                    f"    {a}service.{name}({built(', '.join(['2', *overrides, *same]))})",
                ],
            )
        parent_key = next(
            (
                key
                for key in info["table"]["foreignKeys"]
                if find_info(context, key["references"]["table"])
                and query(find_info(context, key["references"]["table"]), "getByKey")
                and len(key["columns"]) == 1
            ),
            None,
        )
        if parent_key:
            imports.from_("app.errors", "ValidationFailedError")
            column = _column(info, parent_key["columns"][0])
            others = [item for item in overrides if not item.startswith(f"{column['attr']}=")]
            value = missing_value(column["column"]["type"], imports)
            args = ", ".join(["1", *others, f"{column['attr']}={value}"])
            blocks += test(
                "refuses_a_missing_parent",
                [
                    "n = 1",
                    *parents_first,
                    "with pytest.raises(ValidationFailedError) as raised:",
                    f"    {a}service.{name}({built(args)})",
                    f'assert "{parent_key["columns"][0]}" in [error.field for error in raised.value.errors]',
                ],
            )
    if get:
        imports.from_("app.errors", "NotFoundError")
        keys = ", ".join(missing_value(column["column"]["type"], imports) for column in info["key"])
        blocks += test(
            "says_when_a_row_is_missing",
            ["with pytest.raises(NotFoundError):", f"    {a}service.{operation_name(context, get)}({keys})"],
        )
    update = op("update")
    text = _changeable_text(info)
    if create and update and text:
        version = f", version=created.{info['version']['attr']}" if info["version"] else ""
        change = f'{update_dto(info)}({text["attr"]}="changed")' if dtos else f'{{"{text["attr"]}": "changed"}}'
        if dtos:
            imports.from_(module_of(context, info, "dtos"), update_dto(info))
        blocks += test(
            "changes_a_row",
            [
                "n = 1",
                *parents_first,
                f"created = {a}service.{operation_name(context, create)}({built(base_args)})",
                f"updated = {a}service.{operation_name(context, update)}({key_of('created')}, {change}{version})",
                f'assert updated.{text["attr"]} == "changed"',
            ],
        )
    remove = op("delete")
    if create and remove and get:
        imports.from_("app.errors", "NotFoundError")
        version = f", version=created.{info['version']['attr']}" if info["version"] else ""
        blocks += test(
            "deletes_a_row",
            [
                "n = 1",
                *parents_first,
                f"created = {a}service.{operation_name(context, create)}({built(base_args)})",
                f"{a}service.{operation_name(context, remove)}({key_of('created')}{version})",
                "with pytest.raises(NotFoundError):",
                f"    {a}service.{operation_name(context, get)}({key_of('created')})",
            ],
        )
    return blocks


VALUES_HELPER = [
    "",
    "",
    "def _values(entity: object, dto: type) -> dict[str, object]:",
    '    """The values a DTO takes, from an entity that is not stored, for building the DTO from a factory row."""',
    '    names = dto.model_fields if hasattr(dto, "model_fields") else {field.name for field in fields(dto)}',
    "    return {name: value for name, value in vars(entity).items() if name in names}",
]


def test_files(context: dict) -> list[dict]:
    tests = context["settings"]["tests"]
    if tests == "none" or not writes_entities(context):
        return []
    makeable = [info for info in context["tables"] if can_make(context, info)]
    files = [
        context["orm"]["conftest"](context),
        _factories_file(context, makeable),
        {"path": "tests/__init__.py", "content": ""},
        context["orm"]["databaseTest"](context),
        *(context["orm"].get("extraTestFiles", lambda _context: [])(context)),
    ]
    for info in makeable:
        imports = Imports().module("pytest").from_("app.unit_of_work", "SqlUnitOfWork")
        blocks = []
        if tests in ("all", "repositories"):
            blocks += _repository_tests(context, info, imports)
        if tests in ("all", "services") and info["service"]:
            memory = context["settings"]["memoryRepositories"]
            if memory:
                imports.from_("app.unit_of_work", "MemoryUnitOfWork")
            uow = "memory_uow: MemoryUnitOfWork" if memory else context["orm"]["databaseFixture"]
            blocks += _service_tests(context, info, imports, uow)
            if context["settings"]["serviceTypes"] == "dtos":
                imports.from_("dataclasses", "fields")
                blocks += VALUES_HELPER
        if not blocks:
            continue
        note = " (asynchronous: pytest-asyncio runs every test function)" if context["async"] else ""
        content = lines(f'"""Tests of the "{info["name"]}" table{note}."""', "", imports.write("app"), *blocks, "")
        files.append({"path": f"tests/test_{info['module']}.py", "content": content})
    return files
