"""The tests of a generated C# project, which are also what the verification runs (xUnit v3): factories that build valid
rows (and their parents first), repository tests against a real database created from the mapping, and service tests
on the in-memory unit of work (or on the database when the project has no memory repositories). The database is SQLite
in memory unless TEST_DATABASE_CONNECTION names another. Mirrors web/src/core/generators/csharp/tests.ts."""

import re

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
from .csharp import CsUsings, cs_string, pascal_name
from .documents import list_of
from .dtos import create_columns, create_dto, update_columns, update_namespace, update_type
from .samples import missing_value, sample_value


def _is_nullable_key(info: dict, key: dict) -> bool:
    return all(column_of(info, name)["column"]["nullable"] for name in key["columns"])


def can_make(context: dict, info: dict, seen: frozenset = frozenset()) -> bool:
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
    return f"New{info['entity']}"


def _add_name(info: dict) -> str:
    return f"Add{info['entity']}Async"


def tests_ns(context: dict) -> str:
    return f"{context['base']}.Tests"


def _plain(expression: str, column: dict) -> str:
    """A value to pass where the column's plain type is asked for."""
    return f"{expression}!.Value" if column["optional"] and column["valueType"] else expression


def test_file(context: dict, name: str, usings: CsUsings, body: list) -> dict:
    written = usings.write()
    return {
        "path": path_of(tests_ns(context), name, True),
        "content": lines(written != "" and [written, ""], f"namespace {tests_ns(context)};", "", *body, ""),
    }


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    usings = CsUsings(tests_ns(context)).add(context["base"])
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
            # No sample is sure to fit a type that is not known
            if column["column"]["nullable"] and (is_key or column["column"]["type"]["kind"] == "unknown"):
                continue
            if column["column"]["type"]["kind"] == "array":
                value = context["orm"]["emptyList"](context)
            else:
                value = sample_value(column, info["table"]["checks"], context["schema"]["enums"])
            value = _document_value(info, column) or value
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
                *(line for item in info["nested"].values() for line in _nested_factories(context, item)),
            ]
        )
    body = []
    for index, block in enumerate(blocks):
        body += ["" if index > 0 else None, *block]
    return test_file(
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


# Nested documents


def _factory_of(item: dict) -> str:
    return "New" + "".join(item["path"].split(".")).replace("Document", "")


def _document_value(info: dict, column: dict) -> str | None:
    """A column that holds documents, or a list of them, as a C# expression; None for any other."""
    nested = info["nested"].get(column["column"]["name"])
    return _nested_value(column["column"]["type"], nested) if nested else None


def _nested_value(column_type: dict, nested: dict) -> str:
    if column_type["kind"] == "array":
        return f"[{_nested_value(column_type['items'], nested)}]"
    return f"{_factory_of(nested)}(n)"


def _nested_factories(context: dict, item: dict) -> list[str]:
    """A factory per class of nested document, without the identifier it is given when it is stored."""
    values = []
    for field in item["fields"]:
        column = field["column"]
        if column["name"] == "_id" or column["type"]["kind"] == "unknown":
            continue
        if field["nested"]:
            value = _nested_value(column["type"], field["nested"])
        elif column["type"]["kind"] == "array":
            value = context["orm"]["emptyList"](context)
        else:
            sample = {"column": column, "cs": field["cs"]}
            value = sample_value(sample, column.get("checks") or [], context["schema"]["enums"])
        values.append(f"        {field['prop']} = {value},")
    return [
        "",
        f"    /// <summary>A valid {item['path']}.</summary>",
        f"    public static {item['path']} {_factory_of(item)}(int n) => new()",
        "    {",
        *values,
        "    };",
        *(line for inner in item["classes"] for line in _nested_factories(context, inner)),
    ]


def _item_sample(context: dict, items: dict) -> str:
    """A value for an item of a list, as a C# expression for the number 7."""
    if items["nested"] and items["type"]["kind"] == "json":
        return f"Factories.{_factory_of(items['nested'])}(7)"
    if items["type"]["kind"] == "array":
        return f"new {items['cs']}()"
    column = {**items["column"], "column": {**items["column"]["column"], "type": items["type"]}, "cs": items["cs"]}
    return re.sub(r'\bn\b(?!")', "7", sample_value(column, [], context["schema"]["enums"]), flags=re.ASCII)


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
            assertion = f"Assert.NotNull(await {repo}.{query_name(context, read)}({args}));"
            # A unique value that may be null is looked up only when the row has one
            optional = [
                f"stored.{column_of(info, name)['prop']} is not null"
                for name in read["columns"]
                if column_of(info, name)["column"]["nullable"]
            ]
            uniques.append(f"if ({' && '.join(optional)}) {assertion}" if optional else assertion)
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
                context["orm"]["forget"],
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
                    context["orm"]["forget"],
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
    for adding in [item for item in info["queries"] if item["kind"] == "addItem"]:
        listed = list_of(info, adding)
        removing = query(info, "removeItem", adding["columns"])
        if not removing or not get_by_key:
            continue
        prop = listed["column"]["prop"]
        if listed["by"] == "id":
            which = f"added.{prop}![before].Id!"
        else:
            which = "item" if listed["by"] == "value" else f"before, added.{prop}!.Count"
        add_call = f"{repo}.{query_name(context, adding)}({key_of('stored')}, item)"
        remove_name = f"{repo}.{query_name(context, removing)}"
        tests.append(
            _test(
                f"AddsAndRemovesOneItemOf{pascal_name(prop)}",
                [
                    stored,
                    f"var before = stored.{prop}?.Count ?? 0;",
                    f"{listed['cs']} item = {_item_sample(context, listed)};",
                    f"var added = await {add_call};",
                    f"Assert.Equal(before + 1, added!.{prop}!.Count);",
                    f"var removed = await {remove_name}({key_of('stored')}, {which});",
                    f"Assert.Equal(before, removed!.{prop}!.Count);",
                    *(
                        [f"Assert.Null(await {remove_name}({key_of('stored')}, 0, before + 5));"]
                        if listed["by"] == "position"
                        else []
                    ),
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
        if not parent or not can_make(context, parent):
            continue
        usings.add(namespace_of(context, parent, "entity"))
        parents_first.append(f"var parent{index} = await Factories.{_add_name(parent)}(uow, n);")
        for position, column in enumerate(key["columns"]):
            referenced = column_of(parent, key["references"]["columns"][position])["prop"]
            overrides.append({"column": column, "value": f"parent{index}.{referenced}"})
    # The parents take a number the rows of the test never take: a parent may be a row of the same table
    start = ["var n = 100;", *parents_first] if parents_first else []

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
    for operation in [item for item in info["operations"] if item["kind"] == "addItem"]:
        listed = list_of(info, operation)
        without = op("removeItem", operation["columns"])
        if not create or not without or listed["column"]["column"]["name"] in info["hidden"]:
            continue
        usings.add(errors_namespace(context))
        prop = listed["column"]["prop"]
        if listed["by"] == "id":
            which, missing = f"added.{prop}![before].Id!", f'"{"f" * 24}"'
        else:
            which, missing = ("item", None) if listed["by"] == "value" else ("before", "99")
        remove_name = f"service.{operation_name(context, without)}"
        tests.append(
            _test(
                f"AddsAndRemovesOneItemOf{pascal_name(prop)}",
                [
                    *opening,
                    *start,
                    *row("row", 1),
                    f"var created = await service.{operation_name(context, create)}({source('row')});",
                    f"var before = created.{prop}?.Count ?? 0;",
                    f"{listed['cs']} item = {_item_sample(context, listed)};",
                    f"var added = await service.{operation_name(context, operation)}({key_of('created')}, item{version('created')});",
                    f"Assert.Equal(before + 1, added.{prop}!.Count);",
                    f"var removed = await {remove_name}({key_of('created')}, {which}{version('added')});",
                    f"Assert.Equal(before, removed.{prop}!.Count);",
                    *(
                        [
                            f"await Assert.ThrowsAsync<NotFoundException>(() => {remove_name}({key_of('created')}, {missing}{version('removed')}));"
                        ]
                        if missing
                        else []
                    ),
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
    makeable = [info for info in context["tables"] if can_make(context, info)]
    files = [
        {"path": "tests/App.Tests/AssemblyInfo.cs", "content": ASSEMBLY},
        *context["orm"]["testDatabaseFiles"](context),
        _factories_file(context, makeable),
    ]
    memory = context["settings"]["memoryRepositories"]
    for info in makeable:
        usings = CsUsings(tests_ns(context)).add("Xunit", context["base"], namespace_of(context, info, "entity"))
        classes: list = []
        if tests in ("all", "repositories"):
            classes += [
                f'/// <summary>The repository of the "{info["name"]}" table, against the test database.</summary>',
                f"public class {info['entity']}RepositoryTests : IAsyncLifetime",
                "{",
                *context["orm"]["testMembers"](context),
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
                    *(
                        ["    private readonly MemoryUnitOfWork uow = new();"]
                        if memory
                        else context["orm"]["testMembers"](context)
                    ),
                    *_flat(blocks),
                    *helper,
                    "}",
                ]
        if not classes:
            continue
        files.append(test_file(context, f"{info['entity']}Tests", usings, classes))
    return files
