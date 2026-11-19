"""The service of each table: its operations and what each one checks before it writes, in the order of the design
(docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
version; then children and soft deletes. The values of a create or an update are gathered in a map of the fields given,
so every way an update can come is checked and applied the same way. Every write runs in
unitOfWork.transaction { ... }; errors are domain exceptions without HTTP codes. Mirrors
web/src/core/generators/kotlin/services.ts."""

import re

from ...js import js_string
from .context import (
    column_of,
    common_package,
    errors_package,
    find_info,
    kt_file,
    operation_name,
    package_of,
    path_of,
    qualified,
    query,
    query_name,
    service_class,
    stored,
)
from .dtos import create_columns, create_dto, read_columns, read_dto, update_class, update_columns, update_type
from .kotlin import KtImports, kt_string


def _repo(info: dict, uow: str = "uow") -> str:
    return f"{uow}.{info['attr']}"


def _key_params(info: dict) -> str:
    return ", ".join(f"{column['prop']}: {column['kt']}" for column in info["key"])


def _key_args(info: dict) -> str:
    return ", ".join(column["prop"] for column in info["key"])


def _key_value(info: dict) -> str:
    return info["key"][0]["prop"] if len(info["key"]) == 1 else f"listOf({_key_args(info)})"


def _ind(items: list[str], spaces: int = 4) -> list[str]:
    return ["" if line == "" else " " * spaces + line for line in items]


# The variables the checks already use: a column with one of these names gets Value after it
TAKEN = {"values", "errors", "creating", "current", "uow", "value", "other", "entity", "changes", "data", "link", "row"}


def _local(column: dict) -> str:
    return f"{column['key']}Value" if column["key"] in TAKEN else column["prop"]


NUMERIC_KINDS = {"integer", "decimal", "float"}


def _given_or_current(column: dict) -> str:
    """The value of a field as the change gives it, or as the row has it."""
    key = kt_string(column["key"])
    return (
        f"val {_local(column)} = if ({key} in values) values[{key}] as {column['kt']}? else current?.{column['prop']}"
    )


def _number(value) -> str:
    text = js_string(value)
    return text if re.search(r"[.eE]", text) else f"{text}.0"


def _value_rules(column: dict, checks: list[dict]) -> list[str]:
    rules: list[str] = []
    name = column["column"]["name"]
    column_type = column["column"]["type"]

    def rule(condition: str, message: str) -> str:
        return f"if ({condition}) errors += FieldError({kt_string(name)}, {kt_string(message)})"

    if column_type["kind"] == "text" and column_type.get("length") is not None:
        length = js_string(column_type["length"])
        rules.append(rule(f"value is String && value.length > {length}", f"is longer than {length} characters"))
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != name:
            continue
        if parsed["kind"] == "in":
            message = f"must be one of: {', '.join(js_string(item) for item in parsed['values'])}"
            if column_type["kind"] in NUMERIC_KINDS:
                values = ", ".join(_number(item) for item in parsed["values"])
                rules.append(rule(f"(value as Number).toDouble() !in listOf({values})", message))
            else:
                values = ", ".join(kt_string(js_string(item)) for item in parsed["values"])
                rules.append(rule(f"value.toString() !in listOf({values})", message))
        if parsed["kind"] == "compare":
            rules.append(
                rule(
                    f"!((value as Number).toDouble() {parsed['op']} {_number(parsed['value'])})",
                    f"must be {parsed['op']} {js_string(parsed['value'])}",
                )
            )
        if parsed["kind"] == "length":
            value = js_string(parsed["value"])
            rules.append(
                rule(
                    f"!(value.toString().length {parsed['op']} {value})", f"must have {parsed['op']} {value} characters"
                )
            )
    return rules


def _validate_method(writer: dict) -> list[str]:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    imports.add(
        qualified(errors_package(context), "FieldError"),
        qualified(errors_package(context), "ValidationFailedException"),
        qualified(context["base"], "UnitOfWork"),
    )
    blocks: list[list[str]] = []
    for column in create_columns(info):
        name = column["column"]["name"]
        key = kt_string(column["key"])
        if column["required"]:
            missing = {"condition": f"creating || {key} in values", "message": "is required"}
        elif not column["column"]["nullable"]:
            missing = {"condition": f"!creating && {key} in values", "message": "cannot be empty"}
        else:
            missing = None
        rules = _value_rules(column, info["table"]["checks"])
        if not missing and not rules:
            continue
        if missing:
            report = (
                f"if ({missing['condition']}) errors += FieldError({kt_string(name)}, {kt_string(missing['message'])})"
            )
            body = [
                "    if (value == null) {",
                f"        {report}",
                *(["    } else {", *_ind(rules, 8)] if rules else []),
                "    }",
            ]
        else:
            body = ["    if (value != null) {", *_ind(rules, 8), "    }"]
        blocks.append(["run {", f"    val value = values[{key}]", *body, "}"])
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
        set_ = " && ".join(f"{_local(column)} != null" for column in columns)
        args = ", ".join(_local(column) for column in columns)
        blocks.append(
            [
                "run {",
                *(f"    {_given_or_current(column)}" for column in columns),
                f"    if ({set_} && {_repo(parent)}.{query_name(context, read)}({args}) == null)",
                f"        errors += FieldError({kt_string(', '.join(key['columns']))}, {kt_string('no ' + parent['entity'] + ' has this key')})",
                "}",
            ]
        )
    return [
        f'/** Checks the values against the rules of the "{info["name"]}" table, and the rows they point to; throws ValidationFailedException with every problem. */',
        f"private fun validate(uow: UnitOfWork, values: Map<String, Any?>, current: {info['entity']}?) {{",
        "    val creating = current == null",
        "    val errors = mutableListOf<FieldError>()",
        *(line for block in blocks for line in _ind(block)),
        f"    if (errors.isNotEmpty()) throw ValidationFailedException({kt_string(info['entity'])}, errors)",
        "}",
    ]


def _unique_method(writer: dict) -> list[str]:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    checks: list[list[str]] = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        joined = ", ".join(unique["columns"])
        if not read:
            checks.append([f"// {joined} must be unique: the database refuses repeated values (ConflictException)"])
            continue
        imports.add(qualified(errors_package(context), "ConflictException"))
        columns = [column_of(info, name) for name in unique["columns"]]
        other = " || ".join(f"other.{column['prop']} != current.{column['prop']}" for column in info["key"])
        set_ = " && ".join(f"{_local(column)} != null" for column in columns)
        args = ", ".join(_local(column) for column in columns)
        fields = ", ".join(kt_string(column["key"]) for column in columns)
        checks.append(
            [
                "run {",
                *(f"    {_given_or_current(column)}" for column in columns),
                f"    if ({set_}) {{",
                f"        val other = {_repo(info)}.{query_name(context, read)}({args})",
                f"        if (other != null && (current == null || {other}))",
                f"            throw ConflictException({kt_string(info['entity'])}, {kt_string(joined + ' is already taken')}, listOf({fields}))",
                "    }",
                "}",
            ]
        )
    if not checks:
        return []
    return [
        "/** Values that must be unique are not taken by another row. */",
        f"private fun checkUnique(uow: UnitOfWork, values: Map<String, Any?>, current: {info['entity']}?) {{",
        *(line for block in checks for line in _ind(block)),
        "}",
    ]


def _check_method(writer: dict) -> list[str]:
    info = writer["info"]
    return [
        "/** Every check before a write: the values, the rows they point to, the unique values. */",
        f"private fun checkValues(uow: UnitOfWork, values: Map<String, Any?>, current: {info['entity']}?) {{",
        "    validate(uow, values, current)",
        *(["    checkUnique(uow, values, current)"] if info["table"]["uniques"] else []),
        "}",
    ]


def _apply_method(writer: dict) -> list[str]:
    info = writer["info"]
    return [
        "/** Sets the given values on the entity. */",
        f"private fun applyValues(entity: {info['entity']}, values: Map<String, Any?>) {{",
        *(
            f"    if ({kt_string(column['key'])} in values) entity.{column['prop']} = values[{kt_string(column['key'])}] as {column['kt']}?"
            for column in create_columns(info)
        ),
        "}",
    ]


def _find_method(writer: dict) -> list[str]:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    read = query(info, "getByKey")
    if not read:
        return []
    imports.add(qualified(errors_package(context), "NotFoundException"), qualified(context["base"], "UnitOfWork"))
    return [
        f"/** The {info['entity']} with this key; NotFoundException when there is none. */",
        f"private fun find(uow: UnitOfWork, {_key_params(info)}): {info['entity']} =",
        f"    {_repo(info)}.{query_name(context, read)}({_key_args(info)}) ?: throw NotFoundException({kt_string(info['entity'])}, {_key_value(info)})",
    ]


def _read_method(writer: dict) -> list[str]:
    if not writer["dtos"]:
        return []
    info = writer["info"]
    return [
        f"/** The {info['entity']} as services return it. */",
        f"private fun read(entity: {info['entity']}): {read_dto(info)} =",
        f"    {read_dto(info)}(",
        *(f"        {column['prop']} = {stored('entity.' + column['prop'], column)}," for column in read_columns(info)),
        "    )",
    ]


def _given_method(writer: dict) -> list[str]:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    type_ = update_type(context, info)
    imports.add(update_class(context, info))
    mode = context["settings"]["updates"]

    def line(column: dict) -> str:
        key = kt_string(column["key"])
        prop = column["prop"]
        if mode == "patch":
            return f"    if (changes.{prop}.isPresent) values[{key}] = changes.{prop}.value"
        if mode == "optional":
            return f"    changes.{prop}?.let {{ values[{key}] = it.orElse(null) }}"
        return f"    values[{key}] = changes.{prop}"

    return [
        "/** The values an update gives, by field. */",
        f"private fun given(changes: {type_}): Map<String, Any?> {{",
        "    val values = mutableMapOf<String, Any?>()",
        *(line(column) for column in update_columns(info)),
        "    return values",
        "}",
    ]


def _out(writer: dict, expression: str) -> str:
    return f"read({expression})" if writer["dtos"] else expression


def _result_type(writer: dict) -> str:
    return read_dto(writer["info"]) if writer["dtos"] else writer["info"]["entity"]


def _version_check(writer: dict) -> list[str]:
    version = writer["info"]["version"]
    if not version:
        return []
    writer["imports"].add(qualified(errors_package(writer["context"]), "ConflictException"))
    return [
        f"if (current.{version['prop']} != version)",
        f'    throw ConflictException({kt_string(writer["info"]["entity"])}, "was changed by someone else since it was read", listOf({kt_string(version["key"])}))',
    ]


def _children_lines(writer: dict) -> list[str]:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
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
        args = ", ".join(f"current.{column_of(info, name)['prop']}!!" for name in link["references"])
        rows = f"{_repo(child)}.{query_name(context, listing)}({args})"
        if info["children"]["policy"] == "block":
            imports.add(qualified(errors_package(context), "ConflictException"))
            result += [
                f"if ({rows}.isNotEmpty())",
                f"    throw ConflictException({kt_string(info['entity'])}, {kt_string('rows of ' + link['table'] + ' still point to it')}, listOf({kt_string(link['table'])}))",
            ]
        else:
            remove = query(child, "delete")
            if not remove:
                result.append(f"// TODO: rows of {link['table']} must be deleted first, and that table has no delete")
            else:
                result.append(f"{rows}.forEach {{ {_repo(child)}.{query_name(context, remove)}(it) }}")
    return result


def _in_transaction(items: list[str]) -> list[str]:
    return ["unitOfWork.transaction { uow ->", *_ind(items), "}"]


def _operation_lines(writer: dict, operation: dict) -> list[str]:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    name = operation_name(context, operation)
    entity = info["entity"]
    dtos = writer["dtos"]
    kind = operation["kind"]
    paging = context["settings"]["paging"]
    if kind == "create":
        insert = query(info, "insert")
        if not insert:
            return []
        if dtos:
            imports.add(qualified(package_of(context, info, "dtos"), create_dto(info)))
        variable = f"{entity[:1].lower()}{entity[1:]}"
        source = "data" if dtos else variable
        body = _in_transaction(
            [
                "checkValues(uow, values, null)",
                *([f"val entity = {entity}()", "applyValues(entity, values)"] if dtos else []),
                _out(writer, f"{_repo(info)}.{query_name(context, insert)}({'entity' if dtos else variable})"),
            ]
        )
        joined = "\n    ".join(body)
        return [
            f"/** Stores a new {entity} after checking it. */",
            f"fun {name}({f'data: {create_dto(info)}' if dtos else f'{variable}: {entity}'}): {_result_type(writer)} {{",
            "    val values = mapOf(",
            *(f"        {kt_string(column['key'])} to {source}.{column['prop']}," for column in create_columns(info)),
            "    ).filterValues { it != null }",
            f"    return {joined}",
            "}",
        ]
    if kind == "get":
        if not query(info, "getByKey"):
            return []
        return [
            f"/** The {entity} with this key; NotFoundException when there is none. */",
            f"fun {name}({_key_params(info)}): {_result_type(writer)} = {_out(writer, f'find(unitOfWork, {_key_args(info)})')}",
        ]
    if kind == "list":
        listing = query(info, "list")
        if not listing:
            return []
        method = f"unitOfWork.{info['attr']}.{query_name(context, listing)}"
        mapped = ".map { read(it) }" if dtos else ""
        if paging == "offset":
            imports.add(qualified(common_package(context), "Page"))
            return [
                f"/** A page of {info['name']}, by primary key. */",
                f"fun {name}(offset: Int, limit: Int): Page<{_result_type(writer)}> = {method}(offset, limit){mapped}",
            ]
        if paging == "cursor":
            imports.add(qualified(common_package(context), "CursorPage"))
            return [
                f"/** A page of {info['name']} after the key after (null for the first page), by primary key. */",
                f"fun {name}(after: List<Any>?, limit: Int): CursorPage<{_result_type(writer)}> = {method}(after, limit){mapped}",
            ]
        return [
            f"/** Every {entity}, by primary key. */",
            f"fun {name}(): List<{_result_type(writer)}> = {method}(){mapped}",
        ]
    if kind == "update":
        update = query(info, "update")
        if not update or not query(info, "getByKey"):
            return []
        version = info["version"]
        version_param = f", version: {version['kt']}" if version else ""
        body = _in_transaction(
            [
                f"val current = find(uow, {_key_args(info)})",
                *_version_check(writer),
                "checkValues(uow, values, current)",
                "applyValues(current, values)",
                *(
                    [
                        f"current.{version['prop']} = {'(version + 1).toShort()' if version['kt'] == 'Short' else 'version + 1'}"
                    ]
                    if version
                    else []
                ),
                _out(writer, f"{_repo(info)}.{query_name(context, update)}(current)"),
            ]
        )
        joined = "\n    ".join(body)
        return [
            f"/** Changes the given values of a {entity}{', read at version' if version else ''}. */",
            f"fun {name}({_key_params(info)}, changes: {update_type(context, info)}{version_param}): {_result_type(writer)} {{",
            "    val values = given(changes)",
            f"    return {joined}",
            "}",
        ]
    if kind == "delete":
        remove = query(info, "delete")
        update = query(info, "update")
        soft = info["soft"]
        if not query(info, "getByKey") or (not soft and not remove) or (soft and not update):
            return []
        version = info["version"]
        version_param = f", version: {version['kt']}" if version else ""
        mark = ""
        if soft:
            if soft["column"]["type"]["kind"] == "boolean":
                mark = "true"
            else:
                if soft["ktImport"]:
                    imports.add(soft["ktImport"])
                mark = f"{soft['kt']}.now()"
        action = (
            [f"current.{soft['prop']} = {mark}", f"{_repo(info)}.{query_name(context, update)}(current)"]
            if soft
            else [f"{_repo(info)}.{query_name(context, remove)}(current)"]
        )
        return [
            f"/** Marks a {entity} as deleted ({soft['column']['name']}); reads leave it out from then on. */"
            if soft
            else f"/** Deletes a {entity}. */",
            f"fun {name}({_key_params(info)}{version_param}) {{",
            *_ind(
                _in_transaction(
                    [
                        f"val current = find(uow, {_key_args(info)})",
                        *_version_check(writer),
                        *_children_lines(writer),
                        *action,
                    ]
                )
            ),
            "}",
        ]
    if kind in ("find", "listByParent"):
        read = query(info, "findByUnique" if kind == "find" else "listByParent", operation["columns"])
        if not read:
            return []
        columns = [column_of(info, column) for column in operation["columns"]]
        for column in columns:
            if column["ktImport"]:
                imports.add(column["ktImport"])
        params = ", ".join(f"{column['prop']}: {column['kt']}" for column in columns)
        rows = (
            f"unitOfWork.{info['attr']}.{query_name(context, read)}({', '.join(column['prop'] for column in columns)})"
        )
        joined = " and ".join(operation["columns"])
        if kind == "find":
            return [
                f"/** The {entity} with this {joined}, or null. */",
                f"fun {name}({params}): {_result_type(writer)}? = {rows}{'?.let { read(it) }' if dtos else ''}",
            ]
        return [
            f"/** The {info['name']} with this {joined}. */",
            f"fun {name}({params}): List<{_result_type(writer)}> = {rows}{'.map { read(it) }' if dtos else ''}",
        ]
    if kind in ("link", "unlink"):
        return _link_lines(writer, operation, name)
    return []


def _link_lines(writer: dict, operation: dict, name: str) -> list[str]:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    join = find_info(context, operation["through"]) if operation.get("through") else None
    if not join:
        return []
    own = next((key for key in join["table"]["foreignKeys"] if key["references"]["table"] == info["name"]), None)
    far = next((key for key in join["table"]["foreignKeys"] if key is not own), None)
    far_info = find_info(context, far["references"]["table"]) if far else None
    read = query(join, "getByKey")
    if not own or not far or not far_info or not read:
        return []
    own_cols = [column_of(join, column) for column in own["columns"]]
    far_cols = [column_of(join, column) for column in far["columns"]]
    every = [*own_cols, *far_cols]
    for column in every:
        if column["ktImport"]:
            imports.add(column["ktImport"])
    params = ", ".join(f"{column['prop']}: {column['kt']}" for column in every)
    join_key = ", ".join(column["prop"] for column in join["key"])
    found = f"{_repo(join)}.{query_name(context, read)}({join_key})"
    imports.add(qualified(errors_package(context), "NotFoundException"))
    if operation["kind"] == "link":
        insert = query(join, "insert")
        far_read = query(far_info, "getByKey")
        if not insert or not far_read or not query(info, "getByKey"):
            return []
        imports.add(
            qualified(errors_package(context), "ConflictException"),
            qualified(package_of(context, join, "entity"), join["entity"]),
        )
        far_args = ", ".join(column["prop"] for column in far_cols)
        far_key = far_args if len(far_cols) == 1 else f"listOf({far_args})"
        fields = ", ".join(kt_string(column["key"]) for column in far_cols)
        values = ", ".join(f"{column['prop']} = {column['prop']}" for column in every)
        return [
            f"/** Links a {info['entity']} and a {far_info['entity']} ({join['name']}). */",
            f"fun {name}({params}) {{",
            *_ind(
                _in_transaction(
                    [
                        f"find(uow, {', '.join(column['prop'] for column in own_cols)})",
                        f"if ({_repo(far_info)}.{query_name(context, far_read)}({far_args}) == null)",
                        f"    throw NotFoundException({kt_string(far_info['entity'])}, {far_key})",
                        f"if ({found} != null)",
                        f"    throw ConflictException({kt_string(info['entity'])}, {kt_string('is already linked to this ' + far_info['entity'])}, listOf({fields}))",
                        f"{_repo(join)}.{query_name(context, insert)}({join['entity']}({values}))",
                    ]
                )
            ),
            "}",
        ]
    remove = query(join, "delete")
    if not remove:
        return []
    return [
        f"/** Removes the link between a {info['entity']} and a {far_info['entity']} ({join['name']}). */",
        f"fun {name}({params}) {{",
        *_ind(
            _in_transaction(
                [
                    f"val link = {found} ?: throw NotFoundException({kt_string(join['entity'])}, listOf({join_key}))",
                    f"{_repo(join)}.{query_name(context, remove)}(link)",
                ]
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
    pkg = package_of(context, info, "service")
    imports = KtImports(pkg).add(
        qualified(package_of(context, info, "entity"), info["entity"]), qualified(context["base"], "UnitOfWork")
    )
    # The types the services name: the key, the version, and the values a write casts
    for column in info["key"]:
        if column["ktImport"]:
            imports.add(column["ktImport"])
    if info["role"] == "entity":
        for column in create_columns(info):
            if column["ktImport"]:
                imports.add(column["ktImport"])
    if info["version"] and info["version"]["ktImport"]:
        imports.add(info["version"]["ktImport"])
    dtos = context["settings"]["serviceTypes"] == "dtos"
    writer = {"context": context, "info": info, "imports": imports, "dtos": dtos}
    if dtos:
        imports.add(qualified(package_of(context, info, "dtos"), read_dto(info)))
    writes = info["role"] == "entity"
    operations = [block for block in (_operation_lines(writer, operation) for operation in info["operations"]) if block]
    updates = (
        any(operation["kind"] == "update" for operation in info["operations"])
        and query(info, "update")
        and query(info, "getByKey")
    )
    helpers = [_find_method(writer), _read_method(writer)]
    if writes:
        helpers = [
            _validate_method(writer),
            _unique_method(writer),
            _check_method(writer),
            _apply_method(writer),
            *helpers,
        ]
    if writes and updates:
        helpers.append(_given_method(writer))
    hidden_names = info["hidden"]
    hidden = bool(hidden_names) and not dtos
    members = [*operations, *(block for block in helpers if block)]
    lines: list[str] = []
    for index, block in enumerate(members):
        if index > 0 or hidden:
            lines.append("")
        lines += _ind([part for line in block for part in line.split("\n")])
    one = len(hidden_names) == 1
    return kt_file(
        path_of(pkg, service_class(info)),
        pkg,
        imports.write(),
        [
            f"/** Operations on {info['name']}. {TRANSACTIONS[context['settings']['transactions']]} */",
            f"class {service_class(info)}(private val unitOfWork: UnitOfWork) {{",
            hidden
            and f"    // TODO: {', '.join(hidden_names)} {'is' if one else 'are'} returned with the entity; use DTOs to leave {'it' if one else 'them'} out",
            *lines,
            "}",
        ],
    )
