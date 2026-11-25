"""The tests of a generated PHP project, which are also what the verification runs (PHPUnit): factories that build valid
rows (and their parents first), repository tests against a real database created from the mapping, and service tests
on the in-memory unit of work (or on the database when the project has no memory repositories). Mirrors
web/src/core/generators/php/common/tests.ts."""

from ....schema.documents import nested_fields
from .context import (
    class_name,
    column_of,
    common_class,
    error_class,
    find_info,
    ind,
    is_in,
    namespace_of,
    operation_name,
    query,
    query_name,
    root_class,
    service_class,
    writes_entities,
)
from .documents import list_of
from .dtos import create_columns, create_dto, partial_updates, update_class, update_columns, update_type
from .php import PhpUses, access, pascal_name, php_string
from .samples import missing_value, sample_value

TESTS_NS = "Tests"


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


def schemas_of(context: dict) -> list[str]:
    """The schemas of PostgreSQL the tables are in (sales in sales.orders), which the tests empty with their tables."""
    if context["settings"]["database"] != "postgresql":
        return []
    names = []
    for info in context["tables"]:
        schema = info["table"].get("schema")
        if schema and schema not in names:
            names.append(schema)
    return names


def _new_name(info: dict) -> str:
    return f"new{info['entity']}"


def _add_name(info: dict) -> str:
    return f"add{info['entity']}"


def _flat(items: list) -> list:
    """One level of nesting removed, as Array.prototype.flat() does."""
    result = []
    for item in items:
        if isinstance(item, list):
            result.extend(item)
        else:
            result.append(item)
    return result


def test_file(name: str, uses: PhpUses, body: list) -> dict:
    """A test file: one class, in the Tests namespace."""
    written = uses.write()
    content = [
        "<?php",
        "",
        "declare(strict_types=1);",
        "",
        f"namespace {TESTS_NS};",
        "",
        *([written, ""] if written else []),
        *(line for line in body if isinstance(line, str)),
        "",
    ]
    return {"path": f"tests/{name}.php", "content": "\n".join(content)}


# Factories


def _factories_file(context: dict, makeable: list[dict]) -> dict:
    uses = PhpUses(TESTS_NS).add(root_class(context, "UnitOfWork"))
    blocks = []
    for info in makeable:
        uses.add(class_name(namespace_of(context, info, "entity"), info["entity"]))
        parents, from_parents, parent_columns = [], [], set()
        for index, key in enumerate(info["table"]["foreignKeys"]):
            parent = find_info(context, key["references"]["table"])
            if _is_nullable_key(info, key) or not parent:
                continue
            uses.add(class_name(namespace_of(context, parent, "entity"), parent["entity"]))
            parents.append(f"        $parent{index} = self::{_add_name(parent)}($uow, $n);")
            for position, column in enumerate(key["columns"]):
                parent_columns.add(column)
                target = access("$entity", column_of(info, column)["prop"])
                value = access(f"$parent{index}", column_of(parent, key["references"]["columns"][position])["prop"])
                from_parents.append(f"        {target} = {value};")
        values = []
        for column in info["columns"]:
            if column["generated"] or column["column"]["name"] in parent_columns:
                continue
            is_key = any(column["column"]["name"] in key["columns"] for key in info["table"]["foreignKeys"])
            target = access("$entity", column["prop"])
            if column is info["soft"]:
                if column["column"]["type"]["kind"] == "boolean":
                    values.append(f"        {target} = false;")
                continue
            # No sample is sure to fit a type that is not known
            if column["column"]["nullable"] and (is_key or column["column"]["type"]["kind"] == "unknown"):
                continue
            sample = _document_sample(context, column["column"]["type"]) or sample_value(
                column, info["table"]["checks"], context["schema"]["enums"]
            )
            values.append(f"        {target} = {sample};")
        insert = query(info, "insert")
        blocks.append(
            [
                f"    /** A valid {info['entity']} that is not stored yet; $n makes its unique values differ. */",
                f"    public static function {_new_name(info)}(int $n): {info['entity']}",
                "    {",
                f"        $entity = new {info['entity']}();",
                *values,
                "        return $entity;",
                "    }",
                "",
                f"    /** A stored {info['entity']}{', with the rows it points to' if parents else ''}. */",
                f"    public static function {_add_name(info)}(UnitOfWork $uow, int $n): {info['entity']}",
                "    {",
                *parents,
                f"        $entity = self::{_new_name(info)}($n);",
                *from_parents,
                f"        return $uow->{info['attr']}->{query_name(context, insert)}($entity);",
                "    }",
            ]
        )
    body = [
        "/** Rows for the tests: valid values for every column, and the rows they point to. */",
        "final class Factories",
        "{",
    ]
    for index, block in enumerate(blocks):
        if index > 0:
            body.append("")
        body.extend(block)
    body.append("}")
    return test_file("Factories", uses, body)


# Tests of each table


# Nested documents


def _document_sample(context: dict, column_type: dict) -> str | None:
    """A document, or a list with one, as a PHP array, without the identifier it is given when it is stored; None for any
    other value."""
    fields = nested_fields(column_type)
    if not context["orm"].get("documents") or fields is None:
        return None
    if column_type["kind"] == "array":
        return f"[{_document_sample(context, column_type['items'])}]"
    items = []
    for field in fields:
        if field["name"] == "_id" or field["type"]["kind"] == "unknown":
            continue
        column = {"column": field, "php": context["orm"]["phpType"](field["type"])}
        value = _document_sample(context, field["type"]) or sample_value(
            column, field.get("checks") or [], context["schema"]["enums"]
        )
        items.append(f"{php_string(field['name'])} => {value}")
    return f"[{', '.join(items)}]"


def _item_sample(context: dict, listed: dict) -> str:
    """A value for an item of a list, as a PHP expression of $n."""
    column = {
        **listed["column"],
        "column": {**listed["column"]["column"], "type": listed["type"]},
        "php": listed["php"],
    }
    return _document_sample(context, listed["type"]) or sample_value(column, [], context["schema"]["enums"])


def _which_item(listed: dict, items: str) -> str:
    """The last item of a list, as the test tells it from the others."""
    if listed["by"] == "id":
        return f"{items}[$before]['_id']"
    return "$item" if listed["by"] == "value" else "$before"


def _changeable_text(info: dict) -> dict | None:
    """A text column the tests can change and read back, when the table has one."""

    def fits(column: dict) -> bool:
        column_type = column["column"]["type"]
        name = column["column"]["name"]
        length = column_type.get("length")
        return (
            column_type["kind"] == "text"
            and not column_type.get("fixed")
            and name not in info["hidden"]
            and (40 if length is None else length) >= 7
            and not any((check.get("parsed") or {}).get("column") == name for check in info["table"]["checks"])
            and not any(name in unique["columns"] for unique in info["table"]["uniques"])
            and not any(name in key["columns"] for key in info["table"]["foreignKeys"])
        )

    return next((column for column in update_columns(info) if fits(column)), None)


def _test(name: str, body: list) -> list:
    return [
        "",
        f"    public function test{name}(): void",
        "    {",
        "        $uow = $this->uow;",
        *ind(_flat(body), 8),
        "    }",
    ]


def _when_set(columns: list[dict], assertion: str) -> list[str]:
    """An assertion on a stored row's values, made only when those that may be null have one."""
    optional = [column for column in columns if column["column"]["nullable"]]
    if not optional:
        return [assertion]
    present = " && ".join(f"{access('$stored', column['prop'])} !== null" for column in optional)
    return [f"if ({present}) {{", f"    {assertion}", "}"]


def _repository_tests(context: dict, info: dict) -> list[list]:
    repo = f"$uow->{info['attr']}"

    def key_of(variable: str) -> str:
        return ", ".join(access(variable, column["prop"]) for column in info["key"])

    get_by_key = query(info, "getByKey")
    listing = query(info, "list")
    forget = context["orm"]["forget"]("$uow")
    tests = []
    stored = f"$stored = Factories::{_add_name(info)}($uow, 1);"
    reads = []
    if get_by_key:
        reads = [
            f"$found = {repo}->{query_name(context, get_by_key)}({key_of('$stored')});",
            "self::assertNotNull($found);",
            *(
                f"self::assertEquals({access('$stored', column['prop'])}, {access('$found', column['prop'])});"
                for column in info["key"]
            ),
        ]
    uniques = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        if read:
            columns = [column_of(info, name) for name in read["columns"]]
            args = ", ".join(access("$stored", column["prop"]) for column in columns)
            uniques.extend(_when_set(columns, f"self::assertNotNull({repo}->{query_name(context, read)}({args}));"))
    parents = []
    for key in info["table"]["foreignKeys"]:
        read = query(info, "listByParent", key["columns"])
        if not read:
            continue
        columns = [column_of(info, name) for name in read["columns"]]
        args = ", ".join(access("$stored", column["prop"]) for column in columns)
        parents.extend(_when_set(columns, f"self::assertCount(1, {repo}->{query_name(context, read)}({args}));"))
    tests.append(_test("IsStoredAndReadBack", [stored, forget, reads if get_by_key else None, *uniques, *parents]))
    paging = context["settings"]["paging"]
    if listing:
        name = query_name(context, listing)
        if paging == "offset":
            checks = [
                f"$page = {repo}->{name}(0, 1);",
                "self::assertSame(2, $page->total);",
                "self::assertCount(1, $page->items);",
            ]
        elif paging == "cursor":
            checks = [
                f"$first = {repo}->{name}(null, 1);",
                "self::assertCount(1, $first->items);",
                "self::assertNotNull($first->next);",
                f"$second = {repo}->{name}($first->next, 1);",
                "self::assertCount(1, $second->items);",
                "self::assertNull($second->next);",
            ]
        else:
            checks = [f"self::assertCount(2, {repo}->{name}());"]
        tests.append(
            _test(
                "ListsRowsByKey",
                [f"Factories::{_add_name(info)}($uow, 1);", f"Factories::{_add_name(info)}($uow, 2);", checks],
            )
        )
    update = query(info, "update")
    text = _changeable_text(info)
    if update and get_by_key and text:
        read_back = access(f"{repo}->{query_name(context, get_by_key)}({key_of('$stored')})", text["prop"])
        tests.append(
            _test(
                "StoresTheChanges",
                [
                    stored,
                    f"{access('$stored', text['prop'])} = 'changed';",
                    f"{repo}->{query_name(context, update)}($stored);",
                    forget,
                    f"self::assertSame('changed', {read_back});",
                ],
            )
        )
    remove = query(info, "delete")
    if remove and get_by_key and not info["soft"]:
        keys = ", ".join(f"$key{index}" for index in range(len(info["key"])))
        tests.append(
            _test(
                "IsDeleted",
                [
                    stored,
                    # Read before the delete: Doctrine empties the generated key of a removed entity
                    *(
                        f"$key{index} = {access('$stored', column['prop'])};"
                        for index, column in enumerate(info["key"])
                    ),
                    f"{repo}->{query_name(context, remove)}($stored);",
                    f"self::assertNull({repo}->{query_name(context, get_by_key)}({keys}));",
                ],
            )
        )
    for adding in [item for item in info["queries"] if item["kind"] == "addItem"]:
        listed = list_of(context, info, adding)
        removing = query(info, "removeItem", adding["columns"])
        if not removing or not get_by_key:
            continue
        prop = listed["column"]["prop"]
        added = access("$added", prop)
        which = f"{_which_item(listed, added)}{f', count({added})' if listed['by'] == 'position' else ''}"
        remove_call = f"{repo}->{query_name(context, removing)}({key_of('$stored')}"
        tests.append(
            _test(
                f"AddsAndRemovesOneItemOf{pascal_name(listed['column']['field'])}",
                [
                    "$n = 7;",
                    stored,
                    f"$before = count({access('$stored', prop)} ?? []);",
                    f"$item = {_item_sample(context, listed)};",
                    f"$added = {repo}->{query_name(context, adding)}({key_of('$stored')}, $item);",
                    "self::assertNotNull($added);",
                    f"self::assertCount($before + 1, {added});",
                    f"$removed = {remove_call}, {which});",
                    "self::assertNotNull($removed);",
                    f"self::assertCount($before, {access('$removed', prop)});",
                    *([f"self::assertNull({remove_call}, 0, $before + 5));"] if listed["by"] == "position" else []),
                ],
            )
        )
    return tests


def _service_tests(context: dict, info: dict, uses: PhpUses) -> list[list]:
    service = service_class(info)
    uses.add(class_name(namespace_of(context, info, "service"), service))
    dtos = context["settings"]["serviceTypes"] == "dtos"
    ops = {operation["kind"] + ":" + ",".join(operation["columns"]): operation for operation in info["operations"]}

    def op(kind: str, columns: list[str] | None = None):
        return ops.get(kind + ":" + ",".join(columns or []))

    create = op("create")
    get = op("get")
    update = op("update") if op("update") and query(info, "update") and query(info, "getByKey") else None
    remove = op("delete")

    def member(variable: str, column: dict) -> str:
        """A column of what the service returns: a field of a DTO, or a property of the entity."""
        return f"{variable}->{column['field']}" if dtos else access(variable, column["prop"])

    def key_of(variable: str) -> str:
        return ", ".join(member(variable, column) for column in info["key"])

    # Rows go in through the service (when it creates them) and the parents through the factories
    parents_first, overrides = [], []
    for index, key in enumerate(info["table"]["foreignKeys"]):
        parent = find_info(context, key["references"]["table"])
        if not parent or not can_make(context, parent):
            continue
        parents_first.append(f"$parent{index} = Factories::{_add_name(parent)}($uow, $n);")
        for position, column in enumerate(key["columns"]):
            value = access(f"$parent{index}", column_of(parent, key["references"]["columns"][position])["prop"])
            overrides.append({"column": column, "value": value})
    # The parents take a number the rows of the test never take: a parent may be a row of the same table
    start = [*(["$n = 100;"] if parents_first else []), *parents_first]

    def row(variable: str, n: int, extra: list[dict] | None = None) -> list[str]:
        """A row from the factory with the parents' keys and the given values set."""
        extra = extra or []
        given = {item["column"] for item in extra}
        items = [*(item for item in overrides if item["column"] not in given), *extra]
        return [
            f"${variable} = Factories::{_new_name(info)}({n});",
            *(
                f"{access('$' + variable, column_of(info, item['column'])['prop'])} = {item['value']};"
                for item in items
            ),
        ]

    def payload(variable: str) -> str:
        return f"self::createOf(${variable})" if dtos else f"${variable}"

    def changes(target: dict, value: str, source: str) -> str:
        """The changes of an update that sets one field, and keeps the others as the row has them."""
        if partial_updates(context):
            return f"[{php_string(target['field'])} => {value}]"
        uses.add(update_class(context, info))
        if context["settings"]["updates"] == "patch":
            uses.add(common_class(context, "Patch"))
            return f"new {update_type(context, info)}({target['field']}: Patch::of({value}))"
        fields = ", ".join(
            f"{column['field']}: {value if column is target else access(source, column['prop'])}"
            for column in update_columns(info)
        )
        return f"new {update_type(context, info)}({fields})"

    def version(variable: str) -> str:
        return f", {member(variable, info['version'])}" if info["version"] else ""

    fields_of = "$error->errors"
    tests = []
    opened = [f"$service = new {service}($uow);"]
    if create:
        name = operation_name(context, create)
        if get:
            found = [
                f"$found = $service->{operation_name(context, get)}({key_of('$created')});",
                *(
                    f"self::assertEquals({member('$created', column)}, {member('$found', column)});"
                    for column in info["key"]
                ),
            ]
        else:
            found = [f"self::assertNotNull({member('$created', column)});" for column in info["key"]]
        tests.append(
            _test(
                "CreatesAValidRow",
                [*opened, *start, *row("row", 1), f"$created = $service->{name}({payload('row')});", found],
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
            uses.add(error_class(context, "ValidationFailedException"), error_class(context, "FieldError"))
            column_name = required["column"]["name"]
            taken = f"A {info['entity']} without {column_name} was taken"
            tests.append(
                _test(
                    "RefusesAMissingValue",
                    [
                        *opened,
                        *start,
                        *row("row", 1, [{"column": column_name, "value": "null"}]),
                        "try {",
                        f"    $service->{name}({payload('row')});",
                        f"    self::fail({php_string(taken)});",
                        "} catch (ValidationFailedException $error) {",
                        f"    self::assertSame([{php_string(column_name)}], array_map(fn (FieldError $item) => "
                        f"$item->field, {fields_of}));",
                        "}",
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
            uses.add(error_class(context, "ConflictException"))
            own = [column_of(info, column) for column in unique["columns"]]
            tests.append(
                _test(
                    "RefusesARepeatedUniqueValue",
                    [
                        *opened,
                        *start,
                        *row("row", 1),
                        f"$first = $service->{name}({payload('row')});",
                        *row(
                            "again",
                            2,
                            [{"column": column["column"]["name"], "value": member("$first", column)} for column in own],
                        ),
                        "$this->expectException(ConflictException::class);",
                        f"$service->{name}({payload('again')});",
                    ],
                )
            )
            if (
                update
                and len(own) == 1
                and all(not is_in(column, info["key"]) and not column["generated"] for column in own)
            ):
                change = changes(own[0], member("$created", own[0]), "$row")
                tests.append(
                    _test(
                        "KeepsItsOwnUniqueValue",
                        [
                            *opened,
                            *start,
                            *row("row", 1),
                            f"$created = $service->{name}({payload('row')});",
                            f"$updated = $service->{operation_name(context, update)}({key_of('$created')}, {change}"
                            f"{version('$created')});",
                            f"self::assertEquals({member('$created', own[0])}, {member('$updated', own[0])});",
                        ],
                    )
                )

        def single_parent(key: dict) -> bool:
            parent = find_info(context, key["references"]["table"])
            return bool(parent and query(parent, "getByKey") and len(key["columns"]) == 1)

        parent_key = next((key for key in info["table"]["foreignKeys"] if single_parent(key)), None)
        if parent_key:
            uses.add(error_class(context, "ValidationFailedException"), error_class(context, "FieldError"))
            column = column_of(info, parent_key["columns"][0])
            pointing = f"A {info['entity']} pointing to no {parent_key['references']['table']} was taken"
            tests.append(
                _test(
                    "RefusesAMissingParent",
                    [
                        *opened,
                        *start,
                        *row("row", 1, [{"column": column["column"]["name"], "value": missing_value(column)}]),
                        "try {",
                        f"    $service->{name}({payload('row')});",
                        f"    self::fail({php_string(pointing)});",
                        "} catch (ValidationFailedException $error) {",
                        f"    self::assertContains({php_string(parent_key['columns'][0])}, array_map(fn (FieldError $item) "
                        f"=> $item->field, {fields_of}));",
                        "}",
                    ],
                )
            )
    if get:
        uses.add(error_class(context, "NotFoundException"))
        missing = ", ".join(missing_value(column) for column in info["key"])
        tests.append(
            _test(
                "SaysWhenARowIsMissing",
                [
                    *opened,
                    "$this->expectException(NotFoundException::class);",
                    f"$service->{operation_name(context, get)}({missing});",
                ],
            )
        )
    text = _changeable_text(info)
    if create and update and text:
        change = changes(text, "'changed'", "$row")
        tests.append(
            _test(
                "ChangesARow",
                [
                    *opened,
                    *start,
                    *row("row", 1),
                    f"$created = $service->{operation_name(context, create)}({payload('row')});",
                    f"$updated = $service->{operation_name(context, update)}({key_of('$created')}, {change}{version('$created')});",
                    f"self::assertSame('changed', {member('$updated', text)});",
                ],
            )
        )
    if create and remove and get:
        uses.add(error_class(context, "NotFoundException"))
        keys = ", ".join(f"$key{index}" for index in range(len(info["key"])))
        tests.append(
            _test(
                "DeletesARow",
                [
                    *opened,
                    *start,
                    *row("row", 1),
                    f"$created = $service->{operation_name(context, create)}({payload('row')});",
                    # Read before the delete: Doctrine empties the generated key of a removed entity
                    *(f"$key{index} = {member('$created', column)};" for index, column in enumerate(info["key"])),
                    f"$service->{operation_name(context, remove)}({keys}{version('$created')});",
                    "$this->expectException(NotFoundException::class);",
                    f"$service->{operation_name(context, get)}({keys});",
                ],
            )
        )
    for operation in [item for item in info["operations"] if item["kind"] == "addItem"]:
        listed = list_of(context, info, operation)
        without = op("removeItem", operation["columns"])
        if not create or not without or listed["column"]["column"]["name"] in info["hidden"]:
            continue
        uses.add(error_class(context, "NotFoundException"))
        column = listed["column"]
        added = member("$added", column)
        if listed["by"] == "id":
            missing = f"'{'f' * 24}'"
        else:
            missing = None if listed["by"] == "value" else "99"
        remove_name = f"$service->{operation_name(context, without)}({key_of('$created')}"
        tests.append(
            _test(
                f"AddsAndRemovesOneItemOf{pascal_name(column['field'])}",
                [
                    *opened,
                    "$n = 100;",
                    *parents_first,
                    *row("row", 1),
                    f"$created = $service->{operation_name(context, create)}({payload('row')});",
                    f"$before = count({member('$created', column)} ?? []);",
                    f"$item = {_item_sample(context, listed)};",
                    # In memory the service gives the same row again, so what it says now is read before the next change
                    f"$added = $service->{operation_name(context, operation)}({key_of('$created')}, $item{version('$created')});",
                    f"self::assertCount($before + 1, {added});",
                    f"$removed = {remove_name}, {_which_item(listed, added)}{version('$added')});",
                    f"self::assertCount($before, {member('$removed', column)});",
                    *(
                        [
                            "$this->expectException(NotFoundException::class);",
                            f"{remove_name}, {missing}{version('$removed')});",
                        ]
                        if missing
                        else []
                    ),
                ],
            )
        )
    return tests


def _create_of_helper(context: dict, info: dict, uses: PhpUses) -> list[str]:
    """Builds a create DTO from a factory row: the values of its fields."""
    uses.add(class_name(namespace_of(context, info, "dtos"), create_dto(info)))
    return [
        "",
        "    /** The create DTO of a row the factories made. */",
        f"    private static function createOf({info['entity']} $row): {create_dto(info)}",
        "    {",
        f"        return new {create_dto(info)}(",
        *(f"            {column['field']}: {access('$row', column['prop'])}," for column in create_columns(info)),
        "        );",
        "    }",
    ]


def database_members(context: dict, uses: PhpUses) -> list:
    """The property, setup and teardown of a test class over the test database."""
    uses.add(root_class(context, "SqlUnitOfWork"))
    caller = context["settings"]["transactions"] == "caller"
    orm = context["orm"]
    return [
        "    /** The repositories over the test database, opened empty for every test */",
        "    private SqlUnitOfWork $uow;",
        "",
        "    protected function setUp(): void",
        "    {",
        "        $this->uow = TestDatabase::open();",
        "        // The caller owns the transaction: the test opens it, and it ends with the test" if caller else None,
        f"        {orm['begin']('$this->uow')};" if caller else None,
        "    }",
        "",
        "    protected function tearDown(): void",
        "    {",
        f"        {orm['close']('$this->uow')};",
        "    }",
    ]


def test_files(context: dict) -> list[dict]:
    tests = context["settings"]["tests"]
    if tests == "none" or not writes_entities(context):
        return []
    makeable = [info for info in context["tables"] if can_make(context, info)]
    files = [*context["orm"]["testDatabase"](context), _factories_file(context, makeable)]
    memory = context["settings"]["memoryRepositories"]
    for info in makeable:
        entity_class = class_name(namespace_of(context, info, "entity"), info["entity"])
        if tests in ("all", "repositories"):
            uses = PhpUses(TESTS_NS).add("PHPUnit\\Framework\\TestCase")
            members = database_members(context, uses)
            blocks = _repository_tests(context, info)
            files.append(
                test_file(
                    f"{info['entity']}RepositoryTest",
                    uses,
                    [
                        f'/** The repository of the "{info["name"]}" table, against the test database. */',
                        f"final class {info['entity']}RepositoryTest extends TestCase",
                        "{",
                        *members,
                        *(line for block in blocks for line in block),
                        "}",
                    ],
                )
            )
        if tests in ("all", "services") and info["service"] is not None:
            uses = PhpUses(TESTS_NS).add("PHPUnit\\Framework\\TestCase")
            blocks = _service_tests(context, info, uses)
            if not blocks:
                continue
            dtos_helper = (
                context["settings"]["serviceTypes"] == "dtos"
                and query(info, "insert")
                and any(operation["kind"] == "create" for operation in info["operations"])
            )
            if dtos_helper:
                uses.add(entity_class)
            if memory:
                uses.add(root_class(context, "MemoryUnitOfWork"))
                members = [
                    "    private MemoryUnitOfWork $uow;",
                    "",
                    "    protected function setUp(): void",
                    "    {",
                    "        $this->uow = new MemoryUnitOfWork();",
                    "    }",
                ]
            else:
                members = database_members(context, uses)
            helper = _create_of_helper(context, info, uses) if dtos_helper else []
            where = "the in-memory repositories" if memory else "the test database"
            files.append(
                test_file(
                    f"{service_class(info)}Test",
                    uses,
                    [
                        f'/** The service of the "{info["name"]}" table, on {where}. */',
                        f"final class {service_class(info)}Test extends TestCase",
                        "{",
                        *members,
                        *(line for block in blocks for line in block),
                        *helper,
                        "}",
                    ],
                )
            )
    return files
