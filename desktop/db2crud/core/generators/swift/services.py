"""The service of each table: its operations and what each one checks before it writes, in the order of the design
(docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
version; then children and soft deletes. The values of a create or an update are gathered in a Values struct of the
fields given (nil when not given, .some(nil) when given empty), so every way an update can come is checked and applied
the same way. Every write runs in unitOfWork.transaction { ... }; errors are DomainError values without HTTP codes. Only
the helpers the operations use are written. Mirrors web/src/core/generators/swift/services.ts."""

import re

from ...js import js_string
from .context import (
    column_of,
    file_of,
    find_info,
    is_in,
    key_type,
    operation_name,
    query,
    query_name,
    service_type,
    stored,
    sw_file,
)
from .documents import check_call, document_check_functions, document_rules, list_of
from .dtos import create_columns, create_dto, read_columns, read_dto, update_columns, update_type
from .swift import imports, member_name, sw_string, type_name


def _ind(items: list[str], spaces: int = 4) -> list[str]:
    return ["" if line == "" else " " * spaces + line for line in items]


def _repo(info: dict) -> str:
    return f"uow.{info['attr']}"


def _key_params(info: dict) -> str:
    return ", ".join(f"_ {column['prop']}: {column['sw']}" for column in info["key"])


def _key_args(info: dict) -> str:
    return ", ".join(column["prop"] for column in info["key"])


def _key_text(columns: list[dict]) -> str:
    """The key as text, for notFound: "\\(orderId), \\(line)"."""
    return '"' + ", ".join(f"\\({column['prop']})" for column in columns) + '"'


# The variables the checks already use: a column with one of these names gets Value after it
TAKEN = {"values", "errors", "creating", "current", "uow", "value", "other", "entity", "changes", "data", "link", "row"}


def _local(column: dict) -> str:
    return f"{column['key']}Value" if column["key"] in TAKEN else column["prop"]


NUMERIC_KINDS = {"integer", "decimal", "float"}


def _given_or_current(info: dict, column: dict) -> str:
    """The value a check uses: as the values give it, or as the row has it."""
    if is_in(column, create_columns(info)):
        return f"values.{column['prop']} ?? current?.{column['prop']}"
    return f"current?.{column['prop']}"


def _number(value) -> str:
    text = js_string(value)
    return text if re.search(r"[.eE]", text) else f"{text}.0"


def _as_number(column: dict) -> str:
    """The value of a field being checked (value), as a Double."""
    return "NSDecimalNumber(decimal: value).doubleValue" if column["sw"] == "Decimal" else "Double(value)"


def _as_text(column: dict) -> str:
    """The value of a field being checked, as text."""
    return "value" if column["sw"] == "String" else '"\\(value)"'


def _value_rules(column: dict, checks: list[dict]) -> list[str]:
    rules: list[str] = []
    name = column["column"]["name"]
    column_type = column["column"]["type"]

    def rule(condition: str, message: str) -> list[str]:
        return [
            f"if {condition} {{",
            f"    errors.append(FieldError({sw_string(name)}, {sw_string(message)}))",
            "}",
        ]

    if column_type["kind"] == "text" and column_type.get("length") is not None and not column_type.get("objectId"):
        length = js_string(column_type["length"])
        rules += rule(f"value.count > {length}", f"is longer than {length} characters")
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != name:
            continue
        if parsed["kind"] == "in":
            message = f"must be one of: {', '.join(js_string(item) for item in parsed['values'])}"
            if column_type["kind"] in NUMERIC_KINDS:
                values = ", ".join(_number(item) for item in parsed["values"])
                rules += rule(f"![{values}].contains({_as_number(column)})", message)
            else:
                values = ", ".join(sw_string(js_string(item)) for item in parsed["values"])
                rules += rule(f"![{values}].contains({_as_text(column)})", message)
        if parsed["kind"] == "compare":
            rules += rule(
                f"!({_as_number(column)} {parsed['op']} {_number(parsed['value'])})",
                f"must be {parsed['op']} {js_string(parsed['value'])}",
            )
        if parsed["kind"] == "length":
            value = js_string(parsed["value"])
            rules += rule(
                f"!({_as_text(column)}.count {parsed['op']} {value})", f"must have {parsed['op']} {value} characters"
            )
    return rules


def _validate_function(writer: dict) -> list[str]:
    """validate(): the values against the rules of the table, and the rows they point to; nothing when there is
    nothing to check."""
    context, info = writer["context"], writer["info"]
    blocks: list[list[str]] = []
    creating = False
    for column in create_columns(info):
        name = column["column"]["name"]
        prop = column["prop"]
        if column["required"]:
            missing = {"condition": f"creating || values.{prop} != nil", "message": "is required"}
        elif not column["column"]["nullable"]:
            missing = {"condition": f"!creating && values.{prop} != nil", "message": "cannot be empty"}
        else:
            missing = None
        rules = [*_value_rules(column, info["table"]["checks"]), *document_rules(context, info, column)]
        if not missing and not rules:
            continue
        report = (
            [f"    errors.append(FieldError({sw_string(name)}, {sw_string(missing['message'])}))", "}"]
            if missing
            else []
        )
        if missing:
            creating = True
        if rules:
            blocks.append(
                [
                    f"if let value = values.{prop} ?? nil {{",
                    *_ind(rules),
                    *([f"}} else if {missing['condition']} {{", *report] if missing else ["}"]),
                ]
            )
        else:
            blocks.append([f"if values.{prop} ?? nil == nil && ({missing['condition']}) {{", *report])
    # Parents
    for key in info["table"]["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        read = query(parent, "getByKey") if parent else None
        same_key = parent and ",".join(column["column"]["name"] for column in parent["key"]) == ",".join(
            key["references"]["columns"]
        )
        if not parent or not read or not same_key:
            blocks.append(
                [
                    f"// TODO: {', '.join(key['columns'])} must point to a row of {key['references']['table']}; that table has no read by key to check it"
                ]
            )
            continue
        columns = [column_of(info, name) for name in key["columns"]]
        bindings = ", ".join(f"let {_local(column)} = {_given_or_current(info, column)}" for column in columns)
        args = ", ".join(_local(column) for column in columns)
        blocks.append(
            [
                f"if {bindings} {{",
                f"    if try await {_repo(parent)}.{query_name(context, read)}({args}) == nil {{",
                f"        errors.append(FieldError({sw_string(', '.join(key['columns']))}, {sw_string('no ' + parent['entity'] + ' has this key')}))",
                "    }",
                "}",
            ]
        )
    if all(len(block) == 1 and block[0].startswith("//") for block in blocks):
        return [line for block in blocks for line in block]
    return [
        f'/// Checks the values against the rules of the "{info["name"]}" table, and the rows they point to; throws validationFailed with every problem.',
        f"fileprivate func validate(_ uow: any UnitOfWork, _ values: Values, _ current: {info['entity']}?) async throws {{",
        *(["    let creating = current == nil"] if creating else []),
        "    var errors: [FieldError] = []",
        *(line for block in blocks for line in _ind(block)),
        f"    if !errors.isEmpty {{ throw DomainError.validationFailed(entity: {sw_string(info['entity'])}, errors: errors) }}",
        "}",
    ]


def _unique_function(writer: dict) -> tuple[list[str], list[str]]:
    """checkUnique(): values that must be unique are not taken by another row, with notes for those it cannot read."""
    context, info = writer["context"], writer["info"]
    checks: list[list[str]] = []
    notes: list[str] = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        joined = ", ".join(unique["columns"])
        if not read:
            notes.append(f"// {joined} must be unique: the database refuses repeated values (conflict)")
            continue
        columns = [column_of(info, name) for name in unique["columns"]]
        other = " || ".join(f"other.{column['prop']} != $0.{column['prop']}" for column in info["key"])
        bindings = ", ".join(f"let {_local(column)} = {_given_or_current(info, column)}" for column in columns)
        args = ", ".join(_local(column) for column in columns)
        fields = ", ".join(sw_string(column["key"]) for column in columns)
        checks.append(
            [
                f"if {bindings},",
                f"   let other = try await {_repo(info)}.{query_name(context, read)}({args}),",
                f"   current.map({{ {other} }}) ?? true {{",
                f"    throw DomainError.conflict(entity: {sw_string(info['entity'])}, reason: {sw_string(joined + ' is already taken')}, fields: [{fields}])",
                "}",
            ]
        )
    if not checks:
        return [], notes
    return [
        "/// Values that must be unique are not taken by another row.",
        f"fileprivate func checkUnique(_ uow: any UnitOfWork, _ values: Values, _ current: {info['entity']}?) async throws {{",
        *(line for block in checks for line in _ind(block)),
        "}",
    ], notes


def _check_functions(writer: dict) -> list[str]:
    info = writer["info"]
    validate = _validate_function(writer)
    validates = any(line.startswith("fileprivate func validate") for line in validate)
    unique, notes = _unique_function(writer)
    calls = [
        *(["try await validate(uow, values, current)"] if validates else validate),
        *notes,
        *(["try await checkUnique(uow, values, current)"] if unique else []),
    ]
    return [
        *([*validate, ""] if validates else []),
        *([*unique, ""] if unique else []),
        "/// Every check before a write: the values, the rows they point to, the unique values.",
        f"fileprivate func checkValues(_ uow: any UnitOfWork, _ values: Values, _ current: {info['entity']}?) async throws {{",
        *_ind(calls),
        "}",
    ]


def _values_struct(info: dict) -> list[str]:
    return [
        "/// The values a create or an update gives, by field: nil when not given, .some(nil) when given empty.",
        "fileprivate struct Values: Sendable {",
        *(f"    var {column['prop']}: {column['sw']}?? = nil" for column in create_columns(info)),
        "}",
    ]


def _apply_function(info: dict) -> list[str]:
    return [
        "/// Sets the given values on the entity.",
        f"fileprivate func applyValues(_ entity: inout {info['entity']}, _ values: Values) {{",
        *(
            f"    if let value = values.{column['prop']} {{ entity.{column['prop']} = value }}"
            for column in create_columns(info)
        ),
        "}",
    ]


def _find_function(writer: dict) -> list[str]:
    context, info = writer["context"], writer["info"]
    read = query(info, "getByKey")
    return [
        f"/// The {info['entity']} with this key; notFound when there is none.",
        f"fileprivate func find(_ uow: any UnitOfWork, {_key_params(info)}) async throws -> {info['entity']} {{",
        f"    guard let row = try await {_repo(info)}.{query_name(context, read)}({_key_args(info)}) else {{",
        f"        throw DomainError.notFound(entity: {sw_string(info['entity'])}, key: {_key_text(info['key'])})",
        "    }",
        "    return row",
        "}",
    ]


def _read_function(info: dict) -> list[str]:
    values = ", ".join(
        f"{column['key']}: {stored('entity.' + column['prop'], column)}" for column in read_columns(info)
    )
    return [
        f"/// The {info['entity']} as services return it.",
        f"fileprivate func read(_ entity: {info['entity']}) -> {read_dto(info)} {{",
        f"    {read_dto(info)}({values})",
        "}",
    ]


def _given_function(writer: dict) -> list[str]:
    context, info = writer["context"], writer["info"]
    mode = context["settings"]["updates"]

    def value(column: dict) -> str:
        if mode == "patch":
            return f"changes.{column['prop']}.given"
        if mode == "optional":
            return f"changes.{column['prop']}"
        return f".some(changes.{column['prop']})"

    values = ", ".join(f"{column['key']}: {value(column)}" for column in update_columns(info))
    return [
        "/// The values an update gives, by field.",
        f"fileprivate func given(_ changes: {update_type(context, info)}) -> Values {{",
        f"    Values({values})",
        "}",
    ]


def _out(writer: dict, call: str) -> str:
    """An async call, turned into what the service returns: try await read(call) when services return DTOs."""
    if not writer["dtos"]:
        return f"try await {call}"
    writer["used"].add("read")
    return f"try await read({call})"


def _reader(writer: dict) -> str:
    writer["used"].add("read")
    return "read"


def _result_type(writer: dict) -> str:
    return read_dto(writer["info"]) if writer["dtos"] else writer["info"]["entity"]


def _version_check(writer: dict) -> list[str]:
    version = writer["info"]["version"]
    if not version:
        return []
    return [
        f"if current.{version['prop']} != version {{",
        f'    throw DomainError.conflict(entity: {sw_string(writer["info"]["entity"])}, reason: "was changed by someone else since it was read", fields: [{sw_string(version["key"])}])',
        "}",
    ]


def _children_lines(writer: dict) -> list[str]:
    context, info = writer["context"], writer["info"]
    if not info["children"]:
        return []
    result: list[str] = []
    for link in info["children"]["links"]:
        child = find_info(context, link["table"])
        listing = query(child, "listByParent", link["columns"]) if child else None
        if not child or not listing:
            result.append(
                f"// TODO: rows of {link['table']} may point here; that table has no list by {', '.join(link['columns'])} to look for them"
            )
            continue
        args = ", ".join(f"current.{column_of(info, name)['prop']}!" for name in link["references"])
        rows = f"try await {_repo(child)}.{query_name(context, listing)}({args})"
        if info["children"]["policy"] == "block":
            result += [
                f"if !({rows}).isEmpty {{",
                f"    throw DomainError.conflict(entity: {sw_string(info['entity'])}, reason: {sw_string('rows of ' + link['table'] + ' still point to it')}, fields: [{sw_string(link['table'])}])",
                "}",
            ]
        else:
            remove = query(child, "delete")
            if not remove:
                result.append(f"// TODO: rows of {link['table']} must be deleted first, and that table has no delete")
            else:
                result += [
                    f"for row in {rows} {{",
                    f"    try await {_repo(child)}.{query_name(context, remove)}(row)",
                    "}",
                ]
    return result


def _in_transaction(items: list[str], returns: bool) -> list[str]:
    """The lines of a write, in the transaction of the unit of work."""
    return [f"{'return ' if returns else ''}try await unitOfWork.transaction {{ uow in", *_ind(items), "}"]


def _fn(attributes: list[str], signature: str, body: list[str]) -> list[str]:
    return [*attributes, f"public func {signature} {{", *_ind(body), "}"]


def _operation_lines(writer: dict, operation: dict) -> list[str]:
    context, info = writer["context"], writer["info"]
    name = operation_name(context, operation)
    entity = info["entity"]
    dtos = writer["dtos"]
    kind = operation["kind"]
    paging = context["settings"]["paging"]
    if kind == "create":
        insert = query(info, "insert")
        if not insert:
            return []
        writer["used"].update(("checkValues", "apply"))
        variable = "data" if dtos else member_name(entity)
        values = ", ".join(
            f"{column['key']}: {variable}.{column['prop']}.map(Optional.some)" for column in create_columns(info)
        )
        return [
            f"/// Stores a new {entity} after checking it.",
            *_fn(
                ["@discardableResult"],
                f"{name}(_ {variable}: {create_dto(info) if dtos else entity}) async throws -> {_result_type(writer)}",
                [
                    f"let values = Values({values})",
                    *_in_transaction(
                        [
                            "try await checkValues(uow, values, nil)",
                            f"var entity = {entity}()",
                            "applyValues(&entity, values)",
                            f"return {_out(writer, _repo(info) + '.' + query_name(context, insert) + '(entity)')}",
                        ],
                        True,
                    ),
                ],
            ),
        ]
    if kind == "get":
        if not query(info, "getByKey"):
            return []
        writer["used"].add("find")
        return [
            f"/// The {entity} with this key; notFound when there is none.",
            *_fn(
                [],
                f"{name}({_key_params(info)}) async throws -> {_result_type(writer)}",
                [_out(writer, f"find(unitOfWork, {_key_args(info)})")],
            ),
        ]
    if kind == "list":
        listing = query(info, "list")
        if not listing:
            return []
        method = f"unitOfWork.{info['attr']}.{query_name(context, listing)}"
        mapped = f".map({_reader(writer)})" if dtos else ""
        result = _result_type(writer)
        if paging == "offset":
            return [
                f"/// A page of {info['name']}, by primary key.",
                *_fn(
                    [],
                    f"{name}(offset: Int, limit: Int) async throws -> Page<{result}>",
                    [f"try await {method}(offset: offset, limit: limit){mapped}"],
                ),
            ]
        if paging == "cursor":
            return [
                f"/// A page of {info['name']} after the key after (nil for the first page), by primary key.",
                *_fn(
                    [],
                    f"{name}(after: {key_type(info)}?, limit: Int) async throws -> CursorPage<{result}, {key_type(info)}>",
                    [f"try await {method}(after: after, limit: limit){mapped}"],
                ),
            ]
        return [
            f"/// Every {entity}, by primary key.",
            *_fn([], f"{name}() async throws -> [{result}]", [f"try await {method}(){mapped}"]),
        ]
    if kind == "update":
        update = query(info, "update")
        if not update or not query(info, "getByKey"):
            return []
        writer["used"].update(("given", "find", "checkValues", "apply"))
        version = info["version"]
        version_param = f", version: {version['sw']}" if version else ""
        return [
            f"/// Changes the given values of a {entity}{', read at version' if version else ''}.",
            *_fn(
                ["@discardableResult"],
                f"{name}({_key_params(info)}, _ changes: {update_type(context, info)}{version_param}) async throws -> {_result_type(writer)}",
                [
                    "let values = given(changes)",
                    *_in_transaction(
                        [
                            f"var current = try await find(uow, {_key_args(info)})",
                            *_version_check(writer),
                            "try await checkValues(uow, values, current)",
                            "applyValues(&current, values)",
                            *([f"current.{version['prop']} = version + 1"] if version else []),
                            f"return {_out(writer, _repo(info) + '.' + query_name(context, update) + '(current)')}",
                        ],
                        True,
                    ),
                ],
            ),
        ]
    if kind == "delete":
        remove = query(info, "delete")
        update = query(info, "update")
        soft = info["soft"]
        if not query(info, "getByKey") or (not soft and not remove) or (soft and not update):
            return []
        writer["used"].add("find")
        version = info["version"]
        version_param = f", version: {version['sw']}" if version else ""
        if soft:
            if soft["column"]["type"]["kind"] == "boolean":
                mark = "true"
            elif soft["sw"] == "Date":
                mark = "Date()"
            else:
                mark = f"current.{soft['prop']}"
            action = [
                f"current.{soft['prop']} = {mark}",
                f"try await {_repo(info)}.{query_name(context, update)}(current)",
            ]
        else:
            action = [f"try await {_repo(info)}.{query_name(context, remove)}(current)"]
        return [
            f"/// Marks a {entity} as deleted ({soft['column']['name']}); reads leave it out from then on."
            if soft
            else f"/// Deletes a {entity}.",
            *_fn(
                [],
                f"{name}({_key_params(info)}{version_param}) async throws",
                _in_transaction(
                    [
                        f"{'var' if soft else 'let'} current = try await find(uow, {_key_args(info)})",
                        *_version_check(writer),
                        *_children_lines(writer),
                        *action,
                    ],
                    False,
                ),
            ),
        ]
    if kind in ("find", "listByParent"):
        read = query(info, "findByUnique" if kind == "find" else "listByParent", operation["columns"])
        if not read:
            return []
        columns = [column_of(info, column) for column in operation["columns"]]
        params = ", ".join(f"_ {column['prop']}: {column['sw']}" for column in columns)
        args = ", ".join(column["prop"] for column in columns)
        rows = f"try await unitOfWork.{info['attr']}.{query_name(context, read)}({args})"
        mapped = f".map({_reader(writer)})" if dtos else ""
        joined = " and ".join(operation["columns"])
        if kind == "find":
            return [
                f"/// The {entity} with this {joined}, or nil.",
                *_fn([], f"{name}({params}) async throws -> {_result_type(writer)}?", [f"{rows}{mapped}"]),
            ]
        return [
            f"/// The {info['name']} with this {joined}.",
            *_fn([], f"{name}({params}) async throws -> [{_result_type(writer)}]", [f"{rows}{mapped}"]),
        ]
    if kind in ("addItem", "removeItem"):
        return _item_lines(writer, operation, name)
    if kind in ("link", "unlink"):
        return _link_lines(writer, operation, name)
    return []


def _item_lines(writer: dict, operation: dict, name: str) -> list[str]:
    """Adds or removes one item of a list, so two people changing the same list do not undo each other."""
    context, info = writer["context"], writer["info"]
    adds = operation["kind"] == "addItem"
    change = query(info, operation["kind"], operation["columns"])
    if not change or not query(info, "getByKey"):
        return []
    writer["used"].add("find")
    items = list_of(info, change)
    kept = items["column"]["column"]["name"]
    params = [{"name": items["item"], "type": items["sw"]}] if adds else items["params"]
    given = params[0]["name"]
    version = info["version"]
    read_at = ", read at version" if version else ""
    held = f"(current.{items['column']['prop']} ?? [])"
    if items["by"] == "id":
        present = f"{held}.contains(where: {{ $0.id == {given} }})"
    elif items["by"] == "value":
        present = f"{held}.contains({given})"
    else:
        present = f"{held}.indices.contains({given})"
    position = not adds and items["by"] == "position"
    checked = adds and items["nested"] and items["type"]["kind"] == "json"
    if checked:
        writer["checkedLists"].add(kept)
    entity = sw_string(info["entity"])
    if position:
        reason = "was changed by someone else since it was read"
        key = sw_string(items["column"]["key"])
        gone = f'DomainError.conflict(entity: {entity}, reason: "{reason}", fields: [{key}])'
    else:
        gone = f"DomainError.notFound(entity: {entity}, key: {_key_text(info['key'])})"
    args = ", ".join([_key_args(info), *(item["name"] for item in params), *([f"{held}.count"] if position else [])])
    if writer["dtos"]:
        writer["used"].add("read")
    by = "identifier" if items["by"] == "id" else items["by"]
    item_name = sw_string(type_name(items["item"].replace("`", "")))
    signature = ", ".join(f"_ {item['name']}: {item['type']}" for item in params)
    version_param = f", version: {version['sw']}" if version else ""
    body = [
        f"{'_ =' if adds and not version else 'let current ='} try await find(uow, {_key_args(info)})",
        *_version_check(writer),
    ]
    if not adds:
        body += [
            f"if !{present} {{",
            f'    throw DomainError.notFound(entity: {item_name}, key: "\\({given})")',
            "}",
        ]
    body += [
        f"guard let changed = try await {_repo(info)}.{query_name(context, change)}({args}) else {{",
        f"    throw {gone}",
        "}",
        f"return {'read(changed)' if writer['dtos'] else 'changed'}",
    ]
    lines = []
    if checked:
        lines += [
            "var errors: [FieldError] = []",
            check_call(items["nested"], items["item"], kept),
            f"if !errors.isEmpty {{ throw DomainError.validationFailed(entity: {entity}, errors: errors) }}",
        ]
    result = _result_type(writer)
    return [
        f"/// Adds an item to {kept}{read_at}." if adds else f"/// Removes an item from {kept}, by its {by}{read_at}.",
        "@discardableResult",
        f"public func {name}({_key_params(info)}, {signature}{version_param}) async throws -> {result} {{",
        *_ind([*lines, *_in_transaction(body, True)]),
        "}",
    ]


def _link_lines(writer: dict, operation: dict, name: str) -> list[str]:
    context, info = writer["context"], writer["info"]
    join = find_info(context, operation["through"]) if operation.get("through") else None
    if not join:
        return []
    own = next((key for key in join["table"]["foreignKeys"] if key["references"]["table"] == info["name"]), None)
    far = next((key for key in join["table"]["foreignKeys"] if key is not own), None)
    far_info = find_info(context, far["references"]["table"]) if far else None
    read = query(join, "getByKey")
    if not own or not far or not far_info or not read or not query(info, "getByKey"):
        return []
    own_cols = [column_of(join, column) for column in own["columns"]]
    far_cols = [column_of(join, column) for column in far["columns"]]
    every = [*own_cols, *far_cols]
    params = ", ".join(f"_ {column['prop']}: {column['sw']}" for column in every)
    join_key = ", ".join(column["prop"] for column in join["key"])
    found = f"try await {_repo(join)}.{query_name(context, read)}({join_key})"
    writer["used"].add("find")
    if operation["kind"] == "link":
        insert = query(join, "insert")
        far_read = query(far_info, "getByKey")
        if not insert or not far_read:
            return []
        # The initializer takes its arguments in the order of the columns
        values = ", ".join(f"{column['key']}: {column['prop']}" for column in join["columns"] if is_in(column, every))
        own_args = ", ".join(column["prop"] for column in own_cols)
        far_args = ", ".join(column["prop"] for column in far_cols)
        fields = ", ".join(sw_string(column["key"]) for column in far_cols)
        return [
            f"/// Links a {info['entity']} and a {far_info['entity']} ({join['name']}).",
            f"public func {name}({params}) async throws {{",
            *_ind(
                _in_transaction(
                    [
                        f"_ = try await find(uow, {own_args})",
                        f"if try await {_repo(far_info)}.{query_name(context, far_read)}({far_args}) == nil {{",
                        f"    throw DomainError.notFound(entity: {sw_string(far_info['entity'])}, key: {_key_text(far_cols)})",
                        "}",
                        f"if {found} != nil {{",
                        f"    throw DomainError.conflict(entity: {sw_string(info['entity'])}, reason: {sw_string('is already linked to this ' + far_info['entity'])}, fields: [{fields}])",
                        "}",
                        f"try await {_repo(join)}.{query_name(context, insert)}({join['entity']}({values}))",
                    ],
                    False,
                )
            ),
            "}",
        ]
    remove = query(join, "delete")
    if not remove:
        return []
    return [
        f"/// Removes the link between a {info['entity']} and a {far_info['entity']} ({join['name']}).",
        f"public func {name}({params}) async throws {{",
        *_ind(
            _in_transaction(
                [
                    f"guard let link = {found} else {{",
                    f"    throw DomainError.notFound(entity: {sw_string(join['entity'])}, key: {_key_text(join['key'])})",
                    "}",
                    f"try await {_repo(join)}.{query_name(context, remove)}(link)",
                ],
                False,
            )
        ),
        "}",
    ]


TRANSACTIONS = {
    "operation": "Each write runs in its own transaction.",
    "caller": "It never commits: the caller owns the transaction.",
    "repository": "Repositories commit every write.",
}


def service_file(context: dict, info: dict) -> dict | None:
    if not info["service"]:
        return None
    dtos = context["settings"]["serviceTypes"] == "dtos"
    writer = {"context": context, "info": info, "dtos": dtos, "used": set(), "checkedLists": set()}
    operations = [block for block in (_operation_lines(writer, operation) for operation in info["operations"]) if block]
    used = writer["used"]
    helpers: list[list[str]] = []
    if "checkValues" in used or "apply" in used or "given" in used:
        helpers.append(_values_struct(info))
    if "checkValues" in used:
        helpers.append(_check_functions(writer))
    if "apply" in used:
        helpers.append(_apply_function(info))
    checked = [
        column["column"]["name"]
        for column in info["columns"]
        if ("checkValues" in used and is_in(column, create_columns(info)))
        or column["column"]["name"] in writer["checkedLists"]
    ]
    helpers += document_check_functions(context, info, checked)
    if "given" in used:
        helpers.append(_given_function(writer))
    if "find" in used:
        helpers.append(_find_function(writer))
    if "read" in used:
        helpers.append(_read_function(info))
    hidden_names = info["hidden"]
    hidden = bool(hidden_names) and not dtos
    one = len(hidden_names) == 1
    return sw_file(
        file_of(context, info, "service", service_type(info)),
        imports("Foundation"),
        [
            f"/// Operations on {info['name']}. {TRANSACTIONS[context['settings']['transactions']]}",
            f"public struct {service_type(info)}: Sendable {{",
            *(
                [
                    f"    // TODO: {', '.join(hidden_names)} {'is' if one else 'are'} returned with the entity; use DTOs to leave {'it' if one else 'them'} out"
                ]
                if hidden
                else []
            ),
            "    private let unitOfWork: any UnitOfWork",
            "",
            "    public init(unitOfWork: any UnitOfWork) {",
            "        self.unitOfWork = unitOfWork",
            "    }",
            *(line for block in operations for line in ["", *_ind(block)]),
            "}",
            *(line for block in helpers for line in ["", *block]),
        ],
    )
