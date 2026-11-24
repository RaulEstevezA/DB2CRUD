"""The tests of a generated Java project, which are also what the verification runs (JUnit): factories that build valid
rows (and their parents first), repository tests against a real database created from the entities, and service tests
on the in-memory unit of work (or on the database when the project has no memory repositories). The database is SQLite
in a file of target/ unless TEST_DATABASE_URL names another. Mirrors web/src/core/generators/java/tests.ts."""

import re

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
from .documents import list_of
from .dtos import accessor, create_columns, create_dto, update_columns, update_package, update_type
from .java import JavaImports, capitalized, java_path, java_string
from .samples import missing_value, sample_imports, sample_value


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
            # No sample is sure to fit a type that is not known
            if column["column"]["nullable"] and (is_key or column["column"]["type"]["kind"] == "unknown"):
                continue
            for name in sample_imports(column):
                imports.add(name)
            value = _document_value(context, info, column)
            if value is not None:
                pass
            elif column["column"]["type"]["kind"] == "array":
                value = context["orm"]["emptyList"](context)
            else:
                value = sample_value(column, info["table"]["checks"], context["schema"]["enums"])
            values.append(f"        entity.{column['setter']}({value});")
        insert = query(info, "insert")
        entity = info["entity"]
        documents = []
        for item in info["nested"].values():
            documents += _nested_factories(context, item, imports)
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
                *documents,
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


def _factory_of(item: dict) -> str:
    return f"new{''.join(item['path'].split('.'))}"


def _document_value(context: dict, info: dict, column: dict) -> str | None:
    """A column that holds documents, or a list of them, as a Java expression; None for any other."""
    nested = info["nested"].get(column["column"]["name"])
    if not context["orm"].get("documents") or not nested:
        return None
    return _nested_value(column["column"]["type"], nested)


def _nested_value(column_type: dict, nested: dict) -> str:
    if column_type["kind"] == "array":
        return f"new java.util.ArrayList<>(List.of({_nested_value(column_type['items'], nested)}))"
    return f"{_factory_of(nested)}(n)"


def _nested_factories(context: dict, item: dict, imports: JavaImports) -> list[str]:
    """A factory per class of nested document, without the identifier it is given when it is stored."""
    imports.add("java.util.List")
    values = []
    for field in item["fields"]:
        column = field["column"]
        if column["name"] == "_id" or column["type"]["kind"] == "unknown":
            continue
        for part, name in (
            ("BigDecimal", "java.math.BigDecimal"),
            ("Instant", "java.time.Instant"),
            ("UUID", "java.util.UUID"),
        ):
            if part in field["java"]:
                imports.add(name)
        if field["nested"]:
            value = _nested_value(column["type"], field["nested"])
        elif column["type"]["kind"] == "array":
            value = context["orm"]["emptyList"](context)
        else:
            value = sample_value(
                {"column": column, "java": field["java"], "javaImport": None},
                column.get("checks") or [],
                context["schema"]["enums"],
            )
        values.append(f"        item.{field['setter']}({value});")
    result = [
        "",
        f"    /** A valid {item['path']}. */",
        f"    static {item['path']} {_factory_of(item)}(int n) {{",
        f"        {item['path']} item = new {item['path']}();",
        *values,
        "        return item;",
        "    }",
    ]
    for inner in item["classes"]:
        result += _nested_factories(context, inner, imports)
    return result


def _item_sample(context: dict, items: dict) -> str:
    """A value for an item of a list, as a Java expression for the number 7."""
    if items["nested"] and items["type"]["kind"] == "json":
        return f"Factories.{_factory_of(items['nested'])}(7)"
    if items["type"]["kind"] in ("array", "json"):
        return context["orm"]["emptyList"](context)
    column = items["column"]
    sample = sample_value(
        {**column, "column": {**column["column"], "type": items["type"]}, "java": items["java"]},
        [],
        context["schema"]["enums"],
    )
    return re.sub(r"\bn\b", "7", sample)


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


def _same(column: dict) -> str:
    """The assertion that two values of a column are the same: arrays are compared by what they hold."""
    return "org.junit.jupiter.api.Assertions.assertArrayEquals" if column["java"] == "byte[]" else "assertEquals"


def _repository_tests(context: dict, info: dict, imports: JavaImports) -> list[list]:
    adding = [item for item in info["queries"] if item["kind"] == "addItem"]
    for item in adding:
        _add_item_imports(info, item, imports)
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
            assertion = f"assertTrue({repo}.{query_name(context, read)}({args}).isPresent());"
            # A unique value that may be null is looked up only when the row has one
            optional = [
                f"stored.{column_of(info, name)['getter']}() != null"
                for name in read["columns"]
                if column_of(info, name)["column"]["nullable"]
            ]
            uniques.append(f"if ({' && '.join(optional)}) {assertion}" if optional else assertion)
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
                context["orm"]["forget"],
                bool(get_by_key)
                and [
                    f"{entity} found = {repo}.{query_name(context, get_by_key)}({key_of('stored')}).orElseThrow();",
                    *(
                        f"{_same(column)}(stored.{column['getter']}(), found.{column['getter']}());"
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
                    context["orm"]["forget"],
                    f'assertEquals("changed", {repo}.{query_name(context, get_by_key)}({key_of("stored")}).orElseThrow().{text["getter"]}());',
                ],
            )
        )
    for add in adding:
        items = list_of(info, add)
        removing = query(info, "removeItem", add["columns"])
        if not removing or not get_by_key:
            continue
        get = items["column"]["getter"]
        if items["by"] == "id":
            which = f"added.{get}().get(before).getId()"
        elif items["by"] == "value":
            which = "item"
        else:
            which = f"before, added.{get}().size()"
        taking = f"{repo}.{query_name(context, removing)}({key_of('stored')}"
        tests.append(
            _test(
                f"addsAndRemovesOneItemOf{capitalized(items['column']['prop'])}",
                [
                    stored,
                    f"int before = stored.{get}() == null ? 0 : stored.{get}().size();",
                    f"{items['java']} item = {_item_sample(context, items)};",
                    f"{entity} added = {repo}.{query_name(context, add)}({key_of('stored')}, item).orElseThrow();",
                    f"assertEquals(before + 1, added.{get}().size());",
                    f"{entity} removed = {taking}, {which}).orElseThrow();",
                    f"assertEquals(before, removed.{get}().size());",
                    items["by"] == "position" and f"assertTrue({taking}, 0, before + 5).isEmpty());",
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


def _add_item_imports(info: dict, query_design: dict, imports: JavaImports) -> None:
    java_import = list_of(info, query_design)["column"]["javaImport"]
    if java_import:
        imports.add(java_import)


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
        if not parent or not can_make(context, parent):
            continue
        imports.add(qualified(context, parent, "entity", parent["entity"]))
        parents_first.append(f"{parent['entity']} parent{index} = Factories.{_add_name(parent)}(uow, n);")
        for position, column in enumerate(key["columns"]):
            referenced = column_of(parent, key["references"]["columns"][position])["getter"]
            overrides.append({"column": column, "value": f"parent{index}.{referenced}()"})
    # The parents take a number the rows of the test never take: a parent may be a row of the same table
    start = ["int n = 100;", *parents_first]

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
                            f"{_same(column)}({value_of('created', column)}, {value_of('found', column)});"
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
    for operation in info["operations"]:
        if operation["kind"] != "addItem":
            continue
        items = list_of(info, operation)
        without = op("removeItem", operation["columns"])
        if not create or not without or items["column"]["column"]["name"] in info["hidden"]:
            continue
        _add_item_imports(info, operation, imports)
        imports.add(f"{errors_package(context)}.NotFoundException")

        def of(variable: str, column: dict = items["column"]) -> str:
            return value_of(variable, column)

        which, missing = {
            "id": (f"{of('added')}.get(before).getId()", java_string("f" * 24)),
            "value": ("item", None),
            "position": ("before", "99"),
        }[items["by"]]
        taking = f"service.{operation_name(context, without)}({key_of('created')}"
        tests.append(
            _test(
                f"addsAndRemovesOneItemOf{capitalized(items['column']['prop'])}",
                [
                    *opening,
                    *start,
                    *row("row", 1),
                    f"var created = service.{operation_name(context, create)}({source('row')});",
                    f"int before = {of('created')} == null ? 0 : {of('created')}.size();",
                    f"{items['java']} item = {_item_sample(context, items)};",
                    f"var added = service.{operation_name(context, operation)}({key_of('created')}, item{version('created')});",
                    f"assertEquals(before + 1, {of('added')}.size());",
                    f"var removed = {taking}, {which}{version('added')});",
                    f"assertEquals(before, {of('removed')}.size());",
                    missing
                    and f"assertThrows(NotFoundException.class, () -> {taking}, {missing}{version('removed')}));",
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
    makeable = [info for info in context["tables"] if can_make(context, info)]
    files = [*context["orm"]["testDatabaseFiles"](context), _factories_file(context, makeable)]
    memory = context["settings"]["memoryRepositories"]
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
            nested += [
                "",
                "    @Nested",
                "    class Repository {",
                *_flat(_repository_tests(context, info, imports)),
                "    }",
            ]
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
        # Written before the imports, which it adds to
        session = context["orm"]["testSession"](context, imports) if database else None
        content = lines(
            f"package {pkg};",
            "",
            imports.write(),
            "",
            f'/** Tests of the "{info["name"]}" table. */',
            f"class {class_name} {{",
            session,
            *nested,
            "}",
            "",
        )
        files.append({"path": java_path(pkg, class_name, True), "content": content})
    return files
