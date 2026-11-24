"""The tests of a generated Rust project, which are also what the verification runs (cargo test): one test crate,
tests/data/, with factories that build valid rows (and their parents first), repository tests against a real database
created from the SeaORM entities, and service tests on the in-memory unit of work (or on the database when the project
has no memory repositories). Every test takes its turn at the database. The database is SQLite in a new temporary file
unless TEST_DATABASE_URL names another. Mirrors web/src/core/generators/rust/tests.ts."""

import re

from .context import (
    column_of,
    find_info,
    is_in,
    module_of,
    operation_name,
    path_in,
    query,
    query_name,
    service_type,
    writes_entities,
)
from .dtos import create_columns, create_dto, update_columns, update_path, update_type
from .rust import RsUses, owned, rs_string, snake_name
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


def _base(info: dict) -> str:
    return re.sub(r"^r#", "", info["module"])


def _new_name(info: dict) -> str:
    return f"new_{_base(info)}"


def _add_name(info: dict) -> str:
    return f"add_{_base(info)}"


def _ind(items: list[str], spaces: int = 4) -> list[str]:
    return ["" if line == "" else " " * spaces + line for line in items]


TESTS = "tests/data"


def unit_of_work(context: dict) -> str:
    return f"{context['crate']}::unit_of_work"


def external(context: dict, path: str) -> str:
    """A path of the crate, as the tests name it: crate::errors → data_access::errors."""
    return re.sub(r"^crate::", f"{context['crate']}::", path)


def _known(expression: str, column: dict) -> str:
    """The value of a field known to be set, copied: stored.id.expect(…)."""
    value = expression if column["copy"] else f"{expression}.clone()"
    return f"{value}.expect({rs_string(column['key'] + ' is set')})"


def _option(expression: str, column: dict) -> str:
    """An Option of a value, copied."""
    return expression if column["copy"] else f"{expression}.clone()"


# Factories


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    uses = RsUses().add(f"{unit_of_work(context)}::UnitOfWork")
    blocks = []
    for info in makeable:
        uses.add(external(context, path_in(module_of(context, info, "entity"), info["entity"])))
        parents: list[str] = []
        from_parents: list[str] = []
        parent_columns: set[str] = set()
        for index, key in enumerate(info["table"]["foreignKeys"]):
            parent = find_info(context, key["references"]["table"])
            if _is_nullable_key(info, key) or not parent:
                continue
            parents.append(f"    let parent{index} = {_add_name(parent)}(uow, n).await;")
            for position, column in enumerate(key["columns"]):
                parent_columns.add(column)
                target = column_of(parent, key["references"]["columns"][position])
                from_parents.append(
                    f"    entity.{column_of(info, column)['field']} = {_option(f'parent{index}.' + target['field'], target)};"
                )
        values: list[str] = []
        for column in info["columns"]:
            if column["generated"] or column["column"]["name"] in parent_columns:
                continue
            is_key = any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            if column is info["soft"]:
                if column["column"]["type"]["kind"] == "boolean":
                    values.append(f"        {column['field']}: Some(false),")
                continue
            # No sample is sure to fit a type that is not known
            if column["column"]["nullable"] and (is_key or column["column"]["type"]["kind"] == "unknown"):
                continue
            if column["column"]["type"]["kind"] == "array":
                sample = context["orm"]["emptyList"](context)
            else:
                sample = sample_value(column, info["table"]["checks"], context["schema"]["enums"])
            values.append(f"        {column['field']}: Some({sample}),")
        uses_n = any(re.search(r"\bn\b", line) for line in values)
        insert = query(info, "insert")
        blocks.append(
            [
                f"/// A valid {info['entity']} that is not stored yet; n makes its unique values differ.",
                f"pub fn {_new_name(info)}({'n' if uses_n else '_n'}: i32) -> {info['entity']} {{",
                f"    {info['entity']} {{",
                *values,
                "        ..Default::default()",
                "    }",
                "}",
                "",
                f"/// A stored {info['entity']}{', with the rows it points to' if parents else ''}.",
                f"pub async fn {_add_name(info)}(uow: &dyn UnitOfWork, n: i32) -> {info['entity']} {{",
                *parents,
                f"    let {'mut ' if from_parents else ''}entity = {_new_name(info)}(n);",
                *from_parents,
                f"    uow.{info['attr']}().{query_name(context, insert)}(entity).await.expect({rs_string('a stored ' + info['entity'])})",
                "}",
            ]
        )
    return {
        "path": f"{TESTS}/factories.rs",
        "content": "\n".join(
            [
                "//! Rows for the tests: valid values for every column, and the rows they point to.",
                "",
                "// Not every test uses every factory",
                "#![allow(dead_code)]",
                "",
                uses.write(),
                *(line for block in blocks for line in ["", *block]),
                "",
            ]
        ),
    }


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
    lines: list[str] = []
    for item in body:
        if isinstance(item, list):
            lines += [line for line in item if isinstance(line, str)]
        elif isinstance(item, str):
            lines.append(item)

    # A parent made for a column the test then sets itself is not made: Rust refuses a variable nobody uses
    def wanted(line: str) -> bool:
        match = re.match(r"^let (parent\d+) = ", line)
        if not match:
            return True
        return any(other != line and f"{match.group(1)}." in other for other in lines)

    return ["", "#[tokio::test]", f"async fn {name}() {{", *_ind([line for line in lines if wanted(line)]), "}"]


def _when_set(columns: list[dict], assertion: str) -> list[str]:
    """An assertion on a stored row's values, made only when those that may be None have one."""
    optional = [column for column in columns if column["column"]["nullable"]]
    if not optional:
        return [assertion]
    conditions = " && ".join(f"stored.{column['field']}.is_some()" for column in optional)
    return [f"if {conditions} {{", f"    {assertion}", "}"]


def _repository_tests(context: dict, info: dict) -> list[list[str]]:
    repo = f"uow.{info['attr']}()"

    def key_of(variable: str) -> str:
        return ", ".join(_known(f"{variable}.{column['field']}", column) for column in info["key"])

    def args(columns: list[dict]) -> str:
        return ", ".join(_known(f"stored.{column['field']}", column) for column in columns)

    get_by_key = query(info, "getByKey")
    listing = query(info, "list")
    tests: list[list[str]] = []
    opened = "let (_turn, uow) = database::open().await;"
    checks: list[str] = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        if read:
            columns = [column_of(info, name) for name in read["columns"]]
            checks += _when_set(
                columns,
                f'assert!({repo}.{query_name(context, read)}({args(columns)}).await.expect("a read").is_some());',
            )
    for key in info["table"]["foreignKeys"]:
        read = query(info, "listByParent", key["columns"])
        if read:
            columns = [column_of(info, name) for name in read["columns"]]
            checks += _when_set(
                columns,
                f'assert_eq!(1, {repo}.{query_name(context, read)}({args(columns)}).await.expect("a read").len());',
            )
    uses_stored = get_by_key is not None or bool(checks)
    tests.append(
        _test(
            "is_stored_and_read_back",
            [
                opened,
                f"let {'stored' if uses_stored else '_stored'} = factories::{_add_name(info)}(&uow, 1).await;",
                get_by_key
                and [
                    f'let found = {repo}.{query_name(context, get_by_key)}({key_of("stored")}).await.expect("a read").expect("the row");',
                    *(f"assert_eq!(stored.{column['field']}, found.{column['field']});" for column in info["key"]),
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
                f'let page = {repo}.{name}(0, 1).await.expect("a page");',
                "assert_eq!(2, page.total);",
                "assert_eq!(1, page.items.len());",
            ]
        elif paging == "cursor":
            reads = [
                f'let first = {repo}.{name}(None, 1).await.expect("a page");',
                "assert_eq!(1, first.items.len());",
                "assert!(first.next.is_some());",
                f'let second = {repo}.{name}(first.next, 1).await.expect("a page");',
                "assert_eq!(1, second.items.len());",
                "assert!(second.next.is_none());",
            ]
        else:
            reads = [f'assert_eq!(2, {repo}.{name}().await.expect("the rows").len());']
        tests.append(
            _test(
                "lists_rows_by_key",
                [
                    opened,
                    f"factories::{_add_name(info)}(&uow, 1).await;",
                    f"factories::{_add_name(info)}(&uow, 2).await;",
                    reads,
                ],
            )
        )
    update = query(info, "update")
    text = _changeable_text(info)
    if update and get_by_key and text:
        changed = owned("changed")
        tests.append(
            _test(
                "stores_the_changes",
                [
                    opened,
                    f"let mut stored = factories::{_add_name(info)}(&uow, 1).await;",
                    f"stored.{text['field']} = Some({changed});",
                    f'{repo}.{query_name(context, update)}(stored.clone()).await.expect("an update");',
                    f'let found = {repo}.{query_name(context, get_by_key)}({key_of("stored")}).await.expect("a read");',
                    f"assert_eq!(Some({changed}), found.and_then(|row| row.{text['field']}));",
                ],
            )
        )
    remove = query(info, "delete")
    if remove and get_by_key and not info["soft"]:
        tests.append(
            _test(
                "is_deleted",
                [
                    opened,
                    f"let stored = factories::{_add_name(info)}(&uow, 1).await;",
                    f'{repo}.{query_name(context, remove)}(&stored).await.expect("a delete");',
                    f'assert!({repo}.{query_name(context, get_by_key)}({key_of("stored")}).await.expect("a read").is_none());',
                ],
            )
        )
    return tests


def _service_tests(context: dict, info: dict, uses: RsUses) -> list[list[str]]:
    service = service_type(info)
    uses.add(external(context, path_in(module_of(context, info, "service"), service)))
    dtos = context["settings"]["serviceTypes"] == "dtos"
    memory = context["settings"]["memoryRepositories"]
    crate = context["crate"]
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
            return f"{variable}.{column['field']}" if column["copy"] else f"{variable}.{column['field']}.clone()"
        return _known(f"{variable}.{column['field']}", column)

    def option_of(variable: str, column: dict) -> str:
        """A column of what the service returns, as an Option."""
        if dtos and not column["column"]["nullable"]:
            value = f"{variable}.{column['field']}" if column["copy"] else f"{variable}.{column['field']}.clone()"
            return f"Some({value})"
        return _option(f"{variable}.{column['field']}", column)

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
        parents_first.append(f"let parent{index} = factories::{_add_name(parent)}(uow.as_ref(), 100).await;")
        for position, column in enumerate(key["columns"]):
            target = column_of(parent, key["references"]["columns"][position])
            overrides.append({"column": column, "value": _option(f"parent{index}.{target['field']}", target)})

    def row(variable: str, n: int, extra: list[dict] | None = None) -> list[str]:
        extra = extra or []
        given = {item["column"] for item in extra}
        assignments = [*(item for item in overrides if item["column"] not in given), *extra]
        return [
            f"let {'mut ' if assignments else ''}{variable} = factories::{_new_name(info)}({n});",
            *(f"{variable}.{column_of(info, item['column'])['field']} = {item['value']};" for item in assignments),
        ]

    def input_of(variable: str) -> str:
        return f"create_of({variable})" if dtos else variable

    def changes(target: dict, value: dict, source: str) -> str:
        """The changes of an update that sets one field, and keeps the others as the row has them."""
        uses.add(external(context, update_path(context, info)))
        type_ = update_type(context, info)
        mode = context["settings"]["updates"]
        if mode == "patch":
            uses.add(f"{crate}::common::Patch")
            return f"{type_} {{ {target['field']}: Patch::Set({value['option']}), ..Default::default() }}"
        if mode == "optional":
            return f"{type_} {{ {target['field']}: Some({value['option']}), ..Default::default() }}"
        fields = []
        for column in update_columns(info):
            if column is target:
                field_value = value["stored"]
            elif column["column"]["nullable"]:
                field_value = _option(f"{source}.{column['field']}", column)
            else:
                field_value = _known(f"{source}.{column['field']}", column)
            fields.append(f"{column['field']}: {field_value}")
        return f"{type_} {{ {', '.join(fields)} }}"

    def version(variable: str) -> str:
        return f", {member(variable, info['version'])}" if info["version"] else ""

    def errors() -> None:
        uses.add(f"{crate}::errors::DomainError")

    tests: list[list[str]] = []
    if memory:
        opened = ["let uow = Arc::new(MemoryUnitOfWork::default());", f"let service = {service}::new(uow.clone());"]
    else:
        opened = [
            "let (_turn, uow) = database::open().await;",
            "let uow = Arc::new(uow);",
            f"let service = {service}::new(uow.clone());",
        ]
    if create:
        name = operation_name(context, create)
        if get:
            created = [
                f'let created = service.{name}({input_of("row")}).await.expect("a create");',
                f'let found = service.{operation_name(context, get)}({key_of("created")}).await.expect("a read");',
                *(f"assert_eq!(created.{column['field']}, found.{column['field']});" for column in info["key"]),
            ]
        elif dtos:
            created = [f'service.{name}({input_of("row")}).await.expect("a create");']
        else:
            created = [
                f'let created = service.{name}({input_of("row")}).await.expect("a create");',
                *(f"assert!(created.{column['field']}.is_some());" for column in info["key"]),
            ]
        tests.append(_test("creates_a_valid_row", [*opened, *parents_first, *row("row", 1), created]))
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
            errors()
            tests.append(
                _test(
                    "refuses_a_missing_value",
                    [
                        *opened,
                        *parents_first,
                        *row("row", 1, [{"column": required["column"]["name"], "value": "None"}]),
                        f'let error = service.{name}({input_of("row")}).await.expect_err("a refusal");',
                        'let DomainError::ValidationFailed { errors, .. } = &error else { panic!("{error}") };',
                        f"assert_eq!(vec![{rs_string(required['column']['name'])}], errors.iter().map(|error| error.field.as_str()).collect::<Vec<_>>());",
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
            errors()
            own = [column_of(info, column) for column in unique["columns"]]
            tests.append(
                _test(
                    "refuses_a_repeated_unique_value",
                    [
                        *opened,
                        *parents_first,
                        *row("row", 1),
                        f'let first = service.{name}({input_of("row")}).await.expect("a create");',
                        *row(
                            "again",
                            2,
                            [
                                {"column": column["column"]["name"], "value": option_of("first", column)}
                                for column in own
                            ],
                        ),
                        f"assert!(matches!(service.{name}({input_of('again')}).await, Err(DomainError::Conflict {{ .. }})));",
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
                    "option": option_of("created", target),
                    "stored": option_of("created", target)
                    if target["column"]["nullable"]
                    else member("created", target),
                }
                tests.append(
                    _test(
                        "keeps_its_own_unique_value",
                        [
                            *opened,
                            *parents_first,
                            *row("row", 1),
                            f'let created = service.{name}({input_of("row.clone()")}).await.expect("a create");',
                            f'let updated = service.{operation_name(context, update)}({key_of("created")}, {changes(target, kept, "row")}{version("created")}).await.expect("an update");',
                            f"assert_eq!(created.{target['field']}, updated.{target['field']});",
                        ],
                    )
                )

        def has_parent(key: dict) -> bool:
            parent = find_info(context, key["references"]["table"])
            return bool(parent and query(parent, "getByKey") and len(key["columns"]) == 1)

        parent_key = next((key for key in info["table"]["foreignKeys"] if has_parent(key)), None)
        if parent_key:
            errors()
            column = column_of(info, parent_key["columns"][0])
            tests.append(
                _test(
                    "refuses_a_missing_parent",
                    [
                        *opened,
                        *parents_first,
                        *row(
                            "row", 1, [{"column": column["column"]["name"], "value": f"Some({missing_value(column)})"}]
                        ),
                        f'let error = service.{name}({input_of("row")}).await.expect_err("a refusal");',
                        'let DomainError::ValidationFailed { errors, .. } = &error else { panic!("{error}") };',
                        f"assert!(errors.iter().any(|error| error.field == {rs_string(parent_key['columns'][0])}));",
                    ],
                )
            )
    if get:
        errors()
        missing = ", ".join(missing_value(column) for column in info["key"])
        tests.append(
            _test(
                "says_when_a_row_is_missing",
                [
                    *opened,
                    f"assert!(matches!(service.{operation_name(context, get)}({missing}).await, Err(DomainError::NotFound {{ .. }})));",
                ],
            )
        )
    text = _changeable_text(info)
    if create and update and text:
        changed = owned("changed")
        value = {"option": f"Some({changed})", "stored": f"Some({changed})" if text["column"]["nullable"] else changed}
        assertion = (
            f'assert_eq!(updated.{text["field"]}, "changed");'
            if dtos and not text["column"]["nullable"]
            else f"assert_eq!(updated.{text['field']}, Some({changed}));"
        )
        tests.append(
            _test(
                "changes_a_row",
                [
                    *opened,
                    *parents_first,
                    *row("row", 1),
                    f'let created = service.{operation_name(context, create)}({input_of("row.clone()")}).await.expect("a create");',
                    f'let updated = service.{operation_name(context, update)}({key_of("created")}, {changes(text, value, "row")}{version("created")}).await.expect("an update");',
                    assertion,
                ],
            )
        )
    if create and deletes and get:
        errors()
        tests.append(
            _test(
                "deletes_a_row",
                [
                    *opened,
                    *parents_first,
                    *row("row", 1),
                    f'let created = service.{operation_name(context, create)}({input_of("row")}).await.expect("a create");',
                    f'service.{operation_name(context, deletes)}({key_of("created")}{version("created")}).await.expect("a delete");',
                    f"assert!(matches!(service.{operation_name(context, get)}({key_of('created')}).await, Err(DomainError::NotFound {{ .. }})));",
                ],
            )
        )
    return tests


def _create_of_helper(context: dict, info: dict, uses: RsUses) -> list[str]:
    """Builds a create DTO from a factory row: the values of its fields."""
    uses.add(external(context, path_in(module_of(context, info, "dtos"), create_dto(info))))
    fields = ", ".join(f"{column['field']}: row.{column['field']}" for column in create_columns(info))
    return [
        "",
        "/// The create DTO of a row the factories made.",
        f"fn create_of(row: {info['entity']}) -> {create_dto(info)} {{",
        f"    {create_dto(info)} {{ {fields} }}",
        "}",
    ]


def test_files(context: dict) -> list[dict]:
    tests = context["settings"]["tests"]
    if tests == "none" or not writes_entities(context):
        return []
    makeable = [info for info in context["tables"] if can_make(context, info)]
    files = [context["orm"]["testDatabaseFile"](context), _factories_file(context, makeable)]
    modules = ["database", "factories"]
    memory = context["settings"]["memoryRepositories"]
    for info in makeable:
        entity_path = external(context, path_in(module_of(context, info, "entity"), info["entity"]))
        base = snake_name(_base(info))
        if tests in ("all", "repositories"):
            uses = RsUses().add("super::database", "super::factories", f"{unit_of_work(context)}::UnitOfWork")
            blocks = _repository_tests(context, info)
            module = f"{base}_repository"
            modules.append(module)
            content = [
                f'//! The repository of the "{info["name"]}" table, against the test database.',
                "",
                uses.write(),
                *(line for block in blocks for line in block),
                "",
            ]
            files.append({"path": f"{TESTS}/{module}.rs", "content": "\n".join(content)})
        if tests in ("all", "services") and info["service"] is not None:
            uses = RsUses().add("std::sync::Arc")
            if memory:
                uses.add(f"{unit_of_work(context)}::MemoryUnitOfWork")
            blocks = _service_tests(context, info, uses)
            if not blocks:
                continue
            every = "\n".join(line for block in blocks for line in block)
            # The factories and the test database, when the tests name them
            if "factories::" in every:
                uses.add("super::factories")
            if "database::" in every:
                uses.add("super::database")
            dtos_helper = context["settings"]["serviceTypes"] == "dtos" and re.search(r"create_of\(", every)
            if dtos_helper:
                uses.add(entity_path)
            helper = _create_of_helper(context, info, uses) if dtos_helper else []
            module = f"{base}_service"
            modules.append(module)
            on = "the in-memory repositories" if memory else "the test database"
            content = [
                f'//! The service of the "{info["name"]}" table, on {on}.',
                "",
                uses.write(),
                *(line for block in blocks for line in block),
                *helper,
                "",
            ]
            files.append({"path": f"{TESTS}/{module}.rs", "content": "\n".join(content)})
    files.append(
        {
            "path": f"{TESTS}/main.rs",
            "content": "\n".join(
                [
                    "//! The tests of the data access layer: the repositories against a real database, the services on the in-memory",
                    "//! repositories (or on the database when the project has none).",
                    "",
                    *(f"mod {module};" for module in modules),
                    "",
                ]
            ),
        }
    )
    return files
