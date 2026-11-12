"""The service of each table: its operations and what each one checks before it writes, in the order of the design
(docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
version; then children and soft deletes. The values of a create or an update are gathered in a map of the fields
given, so the three ways an update can come (Patch, Optional, every field) are checked and applied the same way.
Every write runs in uow.transaction(...); errors are domain exceptions without HTTP codes. Mirrors
web/src/core/generators/java/services.ts."""

from ...js import number_text
from ..types import lines
from .context import (
    column_of,
    common_package,
    errors_package,
    find_info,
    operation_name,
    package_of,
    qualified,
    query,
    query_name,
    service_class,
)
from .dtos import (
    accessor,
    create_columns,
    create_dto,
    read_columns,
    read_dto,
    update_columns,
    update_package,
    update_type,
)
from .java import JavaImports, java_path, java_string


def _repo(info: dict, uow: str = "uow") -> str:
    return f"{uow}.{info['attr']}()"


def _key_params(info: dict) -> str:
    return ", ".join(f"{column['java']} {column['prop']}" for column in info["key"])


def _key_args(info: dict) -> str:
    return ", ".join(column["prop"] for column in info["key"])


def _key_value(info: dict, imports: JavaImports) -> str:
    if len(info["key"]) == 1:
        return info["key"][0]["prop"]
    imports.add("java.util.List")
    return f"List.of({_key_args(info)})"


def _body(items: list, spaces: int = 8) -> list:
    """A body indented inside a method"""
    return [(("" if line == "" else " " * spaces + line) if isinstance(line, str) else line) for line in items]


def _indent(block: list) -> list:
    return [(f"    {line}" if isinstance(line, str) else line) for line in block]


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


NUMERIC = ("integer", "decimal", "float")


def _value_rules(column: dict, checks: list[dict], uses_number: list[bool]) -> list[str]:
    """The rules a value must follow, from the column's type and the CHECK constraints the rules understand."""
    rules = []
    name = column["column"]["name"]
    column_type = column["column"]["type"]

    def error(message: str) -> str:
        return f"errors.add(new FieldError({java_string(name)}, {java_string(message)}));"

    if column_type["kind"] == "text" and column_type.get("length") is not None:
        length = column_type["length"]
        rules.append(
            f"if (value instanceof String text && text.length() > {length}) {error(f'is longer than {length} characters')}"
        )
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != name:
            continue
        if parsed["kind"] == "in":
            values = [_text(item) for item in parsed["values"]]
            choices = ", ".join(java_string(item) for item in values)
            message = f"must be one of: {', '.join(values)}"
            if column_type["kind"] in NUMERIC:
                uses_number[0] = True
                rules.append(
                    f"if (Stream.of({choices}).map(BigDecimal::new).noneMatch((choice) -> choice.compareTo(number(value)) == 0)) {error(message)}"
                )
            else:
                rules.append(f"if (!List.of({choices}).contains(String.valueOf(value))) {error(message)}")
        if parsed["kind"] == "compare":
            uses_number[0] = True
            bound = _text(parsed["value"])
            op = parsed["op"]
            rules.append(
                f"if (!(number(value).compareTo(new BigDecimal({java_string(bound)})) {op} 0)) {error(f'must be {op} {bound}')}"
            )
        if parsed["kind"] == "length":
            bound = _text(parsed["value"])
            op = parsed["op"]
            rules.append(
                f"if (!(String.valueOf(value).length() {op} {bound})) {error(f'must have {op} {bound} characters')}"
            )
    return rules


def _validate_method(writer: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    imports.add(
        f"{errors_package(context)}.ValidationFailedException",
        f"{errors_package(context)}.FieldError",
        "java.util.ArrayList",
        "java.util.List",
        "java.util.Map",
        f"{context['base']}.UnitOfWork",
    )
    uses_number = [False]
    blocks = []
    for column in create_columns(info):
        name = column["column"]["name"]
        prop = column["prop"]
        if column["required"]:
            missing = f'if (creating || values.containsKey({java_string(prop)})) errors.add(new FieldError({java_string(name)}, "is required"));'
        elif not column["column"]["nullable"]:
            missing = f'if (!creating && values.containsKey({java_string(prop)})) errors.add(new FieldError({java_string(name)}, "cannot be empty"));'
        else:
            missing = None
        rules = _value_rules(column, info["table"]["checks"], uses_number)
        if not missing and not rules:
            continue
        if missing:
            inner = ["    if (value == null) {", f"        {missing}"]
            if rules:
                inner += ["    } else {", *(f"        {rule}" for rule in rules)]
            inner.append("    }")
        else:
            inner = ["    if (value != null) {", *(f"        {rule}" for rule in rules), "    }"]
        blocks.append(["{", f"    Object value = values.get({java_string(prop)});", *inner, "}"])
    if uses_number[0]:
        imports.add("java.math.BigDecimal", "java.util.stream.Stream")
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
        blocks.append(
            [
                "{",
                *(
                    f"    {column['java']} {column['prop']} = ({column['java']}) (values.containsKey({java_string(column['prop'])}) ? values.get({java_string(column['prop'])}) : current == null ? null : current.{column['getter']}());"
                    for column in columns
                ),
                f"    if ({' && '.join(column['prop'] + ' != null' for column in columns)} && {_repo(parent)}.{query_name(context, read)}({', '.join(column['prop'] for column in columns)}).isEmpty())",
                f"        errors.add(new FieldError({java_string(', '.join(key['columns']))}, {java_string('no ' + parent['entity'] + ' has this key')}));",
                "}",
            ]
        )
    result = [
        f'/** Checks the values against the rules of the "{info["name"]}" table, and the rows they point to; throws ValidationFailedException with every problem. */',
        f"private void validate(UnitOfWork uow, Map<String, Object> values, {info['entity']} current) {{",
        "    boolean creating = current == null;",
        "    List<FieldError> errors = new ArrayList<>();",
        *[line for block in blocks for line in _indent(block)],
        f'    if (!errors.isEmpty()) throw new ValidationFailedException("{info["entity"]}", errors);',
        "}",
    ]
    if uses_number[0]:
        result += [
            "",
            "/** A number of any type, to compare it. */",
            "private static BigDecimal number(Object value) {",
            "    return new BigDecimal(String.valueOf(value));",
            "}",
        ]
    return result


def _unique_method(writer: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    checks = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        if not read:
            checks.append(
                [
                    f"// {', '.join(unique['columns'])} must be unique: the database refuses repeated values (ConflictException)"
                ]
            )
            continue
        imports.add(
            f"{errors_package(context)}.ConflictException", "java.util.List", "java.util.Objects", "java.util.Optional"
        )
        columns = [column_of(info, name) for name in unique["columns"]]
        other = " || ".join(
            f"!Objects.equals(other.get().{column['getter']}(), current.{column['getter']}())" for column in info["key"]
        )
        fields = ", ".join(java_string(column["prop"]) for column in columns)
        taken = java_string(f"{', '.join(unique['columns'])} is already taken")
        checks.append(
            [
                "{",
                *(
                    f"    {column['java']} {column['prop']} = ({column['java']}) (values.containsKey({java_string(column['prop'])}) ? values.get({java_string(column['prop'])}) : current == null ? null : current.{column['getter']}());"
                    for column in columns
                ),
                f"    if ({' && '.join(column['prop'] + ' != null' for column in columns)}) {{",
                f"        Optional<{info['entity']}> other = {_repo(info)}.{query_name(context, read)}({', '.join(column['prop'] for column in columns)});",
                f"        if (other.isPresent() && (current == null || {other}))",
                f'            throw new ConflictException("{info["entity"]}", {taken}, List.of({fields}));',
                "    }",
                "}",
            ]
        )
    if not checks:
        return []
    return [
        "/** Values that must be unique are not taken by another row. */",
        f"private void checkUnique(UnitOfWork uow, Map<String, Object> values, {info['entity']} current) {{",
        *[line for block in checks for line in _indent(block)],
        "}",
    ]


def _check_method(writer: dict) -> list:
    info = writer["info"]
    return [
        "/** Every check before a write: the values, the rows they point to, the unique values. */",
        f"private void check(UnitOfWork uow, Map<String, Object> values, {info['entity']} current) {{",
        "    validate(uow, values, current);",
        bool(info["table"]["uniques"]) and "    checkUnique(uow, values, current);",
        "}",
    ]


def _apply_method(writer: dict) -> list:
    info, imports = writer["info"], writer["imports"]
    imports.add("java.util.Map")
    return [
        "/** Sets the given values on the entity. */",
        f"private static void apply({info['entity']} entity, Map<String, Object> values) {{",
        *(
            f"    if (values.containsKey({java_string(column['prop'])})) entity.{column['setter']}(({column['java']}) values.get({java_string(column['prop'])}));"
            for column in create_columns(info)
        ),
        "}",
    ]


def _find_method(writer: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    read = query(info, "getByKey")
    if not read:
        return []
    imports.add(f"{errors_package(context)}.NotFoundException", f"{context['base']}.UnitOfWork")
    return [
        f"/** The {info['entity']} with this key; NotFoundException when there is none. */",
        f"private {info['entity']} find(UnitOfWork uow, {_key_params(info)}) {{",
        f'    return {_repo(info)}.{query_name(context, read)}({_key_args(info)}).orElseThrow(() -> new NotFoundException("{info["entity"]}", {_key_value(info, imports)}));',
        "}",
    ]


def _read_method(writer: dict) -> list:
    if not writer["dtos"]:
        return []
    info = writer["info"]
    values = ", ".join(f"entity.{column['getter']}()" for column in read_columns(info))
    return [
        f"/** The {info['entity']} as services return it. */",
        f"private static {read_dto(info)} read({info['entity']} entity) {{",
        f"    return new {read_dto(info)}({values});",
        "}",
    ]


def _changes_method(writer: dict) -> list:
    """The values given in an update, by field."""
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    type_name = update_type(context, info)
    record = context["settings"]["dtoKind"] != "class" if writer["dtos"] else True
    imports.add("java.util.LinkedHashMap", "java.util.Map")
    if update_package(context, info) != package_of(context, info, "service"):
        imports.add(f"{update_package(context, info)}.{type_name}")
    updates = context["settings"]["updates"]
    body = []
    for column in update_columns(info):
        get = f"changes.{accessor(context, column['prop'], record)}"
        prop = java_string(column["prop"])
        if updates == "patch":
            body.append(f"if ({get} != null && {get}.isPresent()) values.put({prop}, {get}.value());")
        elif updates == "optional":
            body.append(f"if ({get} != null) values.put({prop}, {get}.orElse(null));")
        else:
            body.append(f"values.put({prop}, {get});")
    return [
        "/** The values an update gives, by field. */",
        f"private static Map<String, Object> given({type_name} changes) {{",
        "    Map<String, Object> values = new LinkedHashMap<>();",
        *(f"    {line}" for line in body),
        "    return values;",
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
    writer["imports"].add(
        f"{errors_package(writer['context'])}.ConflictException", "java.util.List", "java.util.Objects"
    )
    return [
        f"if (!Objects.equals(current.{version['getter']}(), version))",
        f'    throw new ConflictException("{writer["info"]["entity"]}", "was changed by someone else since it was read", List.of({java_string(version["prop"])}));',
    ]


def _children_lines(writer: dict) -> list[str]:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    if not info["children"]:
        return []
    result = []
    for link in info["children"]["links"]:
        child = find_info(context, link["table"])
        listing = query(child, "listByParent", link["columns"]) if child else None
        if not child or not listing:
            result.append(
                f"// TODO: rows of {link['table']} may point here; that table has no list by {', '.join(link['columns'])} to look for them"
            )
            continue
        args = ", ".join(f"current.{column_of(info, name)['getter']}()" for name in link["references"])
        rows = f"{_repo(child)}.{query_name(context, listing)}({args})"
        if info["children"]["policy"] == "block":
            imports.add(f"{errors_package(context)}.ConflictException", "java.util.List")
            reason = java_string(f"rows of {link['table']} still point to it")
            result.append(
                f'if (!{rows}.isEmpty()) throw new ConflictException("{info["entity"]}", {reason}, List.of({java_string(link["table"])}));'
            )
        else:
            remove = query(child, "delete")
            if not remove:
                result.append(f"// TODO: rows of {link['table']} must be deleted first, and that table has no delete")
            else:
                imports.add(qualified(context, child, "entity", child["entity"]))
                result.append(
                    f"for ({child['entity']} row : {rows}) {_repo(child)}.{query_name(context, remove)}(row);"
                )
    return result


def _in_transaction(items: list[str], returns: bool) -> list[str]:
    return [
        f"{'return ' if returns else ''}uow.transaction((uow) -> {{",
        *(f"    {line}" for line in items),
        *([] if returns else ["    return null;"]),
        "});",
    ]


def _next_version(column: dict) -> str:
    """version + 1, in the type of the version column."""
    return "(short) (version + 1)" if column["java"] == "Short" else "version + 1"


def _operation_lines(writer: dict, operation: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    name = operation_name(context, operation)
    entity = info["entity"]
    record = context["settings"]["dtoKind"] != "class"
    dtos = writer["dtos"]
    kind = operation["kind"]
    paging = context["settings"]["paging"]
    if kind == "create":
        insert = query(info, "insert")
        if not insert:
            return []
        imports.add("java.util.LinkedHashMap", "java.util.Map")
        if dtos:
            imports.add(qualified(context, info, "dtos", create_dto(info)))
        variable = entity[:1].lower() + entity[1:]

        def get(column: dict) -> str:
            return f"data.{accessor(context, column['prop'], record)}" if dtos else f"{variable}.{column['getter']}()"

        stored = _out(writer, f"{_repo(info)}.{query_name(context, insert)}({'entity' if dtos else variable})")
        return [
            f"/** Stores a new {entity} after checking it. */",
            f"public {_result_type(writer)} {name}({f'{create_dto(info)} data' if dtos else f'{entity} {variable}'}) {{",
            "    Map<String, Object> values = new LinkedHashMap<>();",
            *(
                f"    if ({get(column)} != null) values.put({java_string(column['prop'])}, {get(column)});"
                for column in create_columns(info)
            ),
            *_body(
                _in_transaction(
                    [
                        "check(uow, values, null);",
                        *([f"{entity} entity = new {entity}();", "apply(entity, values);"] if dtos else []),
                        f"return {stored};",
                    ],
                    True,
                ),
                4,
            ),
            "}",
        ]
    if kind == "get":
        if not query(info, "getByKey"):
            return []
        return [
            f"/** The {entity} with this key; NotFoundException when there is none. */",
            f"public {_result_type(writer)} {name}({_key_params(info)}) {{",
            f"    return {_out(writer, f'find(uow, {_key_args(info)})')};",
            "}",
        ]
    if kind == "list":
        listing = query(info, "list")
        if not listing:
            return []
        method = f"{_repo(info)}.{query_name(context, listing)}"

        def mapped(expression: str, shape: str) -> str:
            if not dtos:
                return expression
            if shape == "page":
                return f"{expression}.map({service_class(info)}::read)"
            return f"{expression}.stream().map({service_class(info)}::read).toList()"

        if paging == "offset":
            imports.add(f"{common_package(context)}.Page")
            return [
                f"/** A page of {info['name']}, by primary key. */",
                f"public Page<{_result_type(writer)}> {name}(int offset, int limit) {{",
                f"    return {mapped(f'{method}(offset, limit)', 'page')};",
                "}",
            ]
        if paging == "cursor":
            imports.add(f"{common_package(context)}.CursorPage", "java.util.List")
            return [
                f"/** A page of {info['name']} after the key after (null for the first page), by primary key. */",
                f"public CursorPage<{_result_type(writer)}> {name}(List<Object> after, int limit) {{",
                f"    return {mapped(f'{method}(after, limit)', 'page')};",
                "}",
            ]
        imports.add("java.util.List")
        return [
            f"/** Every {entity}, by primary key. */",
            f"public List<{_result_type(writer)}> {name}() {{",
            f"    return {mapped(f'{method}()', 'list')};",
            "}",
        ]
    if kind == "update":
        update = query(info, "update")
        if not update or not query(info, "getByKey"):
            return []
        version = info["version"]
        version_param = f", {version['java']} version" if version else ""
        return [
            f"/** Changes the given values of a {entity}{', read at version' if version else ''}. */",
            f"public {_result_type(writer)} {name}({_key_params(info)}, {update_type(context, info)} changes{version_param}) {{",
            "    Map<String, Object> values = given(changes);",
            *_body(
                _in_transaction(
                    [
                        f"{entity} current = find(uow, {_key_args(info)});",
                        *_version_check(writer),
                        "check(uow, values, current);",
                        "apply(current, values);",
                        *([f"current.{version['setter']}({_next_version(version)});"] if version else []),
                        f"return {_out(writer, f'{_repo(info)}.{query_name(context, update)}(current)')};",
                    ],
                    True,
                ),
                4,
            ),
            "}",
        ]
    if kind == "delete":
        remove = query(info, "delete")
        update = query(info, "update")
        soft = info["soft"]
        if not query(info, "getByKey") or (not soft and not remove) or (soft and not update):
            return []
        version = info["version"]
        version_param = f", {version['java']} version" if version else ""
        mark = "Boolean.TRUE"
        if soft and soft["column"]["type"]["kind"] != "boolean":
            if soft["java"] == "OffsetDateTime":
                imports.add("java.time.OffsetDateTime", "java.time.ZoneOffset")
                mark = "OffsetDateTime.now(ZoneOffset.UTC)"
            else:
                if soft["javaImport"]:
                    imports.add(soft["javaImport"])
                mark = f"{soft['java']}.now()"
        if soft:
            action = [f"current.{soft['setter']}({mark});", f"{_repo(info)}.{query_name(context, update)}(current);"]
        else:
            action = [f"{_repo(info)}.{query_name(context, remove)}(current);"]
        doc = (
            f"/** Marks a {entity} as deleted ({soft['column']['name']}); reads leave it out from then on. */"
            if soft
            else f"/** Deletes a {entity}. */"
        )
        return [
            doc,
            f"public void {name}({_key_params(info)}{version_param}) {{",
            *_body(
                _in_transaction(
                    [
                        f"{entity} current = find(uow, {_key_args(info)});",
                        *_version_check(writer),
                        *_children_lines(writer),
                        *action,
                    ],
                    False,
                ),
                4,
            ),
            "}",
        ]
    if kind in ("find", "listByParent"):
        read = query(info, "findByUnique" if kind == "find" else "listByParent", operation["columns"])
        if not read:
            return []
        columns = [column_of(info, column) for column in operation["columns"]]
        params = ", ".join(f"{column['java']} {column['prop']}" for column in columns)
        rows = f"{_repo(info)}.{query_name(context, read)}({', '.join(column['prop'] for column in columns)})"
        joined = " and ".join(operation["columns"])
        if kind == "find":
            imports.add("java.util.Optional")
            return [
                f"/** The {entity} with this {joined}, if there is one. */",
                f"public Optional<{_result_type(writer)}> {name}({params}) {{",
                f"    return {f'{rows}.map({service_class(info)}::read)' if dtos else rows};",
                "}",
            ]
        imports.add("java.util.List")
        return [
            f"/** The {info['name']} with this {joined}. */",
            f"public List<{_result_type(writer)}> {name}({params}) {{",
            f"    return {f'{rows}.stream().map({service_class(info)}::read).toList()' if dtos else rows};",
            "}",
        ]
    if kind in ("link", "unlink"):
        return _link_lines(writer, operation, name)
    return []


def _link_lines(writer: dict, operation: dict, name: str) -> list:
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
    params = ", ".join(f"{column['java']} {column['prop']}" for column in [*own_cols, *far_cols])
    join_key = ", ".join(column["prop"] for column in join["key"])
    found = f"{_repo(join)}.{query_name(context, read)}({join_key})"
    imports.add(
        f"{errors_package(context)}.NotFoundException",
        qualified(context, join, "entity", join["entity"]),
        "java.util.List",
    )
    if operation["kind"] == "link":
        insert = query(join, "insert")
        far_read = query(far_info, "getByKey")
        if not insert or not far_read or not query(info, "getByKey"):
            return []
        imports.add(f"{errors_package(context)}.ConflictException")
        far_args = ", ".join(column["prop"] for column in far_cols)
        missing_key = far_args if len(far_cols) == 1 else f"List.of({far_args})"
        linked = java_string(f"is already linked to this {far_info['entity']}")
        far_fields = ", ".join(java_string(column["prop"]) for column in far_cols)
        return [
            f"/** Links a {info['entity']} and a {far_info['entity']} ({join['name']}). */",
            f"public void {name}({params}) {{",
            *_body(
                _in_transaction(
                    [
                        f"find(uow, {', '.join(column['prop'] for column in own_cols)});",
                        f'if ({_repo(far_info)}.{query_name(context, far_read)}({far_args}).isEmpty()) throw new NotFoundException("{far_info["entity"]}", {missing_key});',
                        f'if ({found}.isPresent()) throw new ConflictException("{info["entity"]}", {linked}, List.of({far_fields}));',
                        f"{join['entity']} link = new {join['entity']}();",
                        *(f"link.{column['setter']}({column['prop']});" for column in [*own_cols, *far_cols]),
                        f"{_repo(join)}.{query_name(context, insert)}(link);",
                    ],
                    False,
                ),
                4,
            ),
            "}",
        ]
    remove = query(join, "delete")
    if not remove:
        return []
    return [
        f"/** Removes the link between a {info['entity']} and a {far_info['entity']} ({join['name']}). */",
        f"public void {name}({params}) {{",
        *_body(
            _in_transaction(
                [
                    f'{join["entity"]} link = {found}.orElseThrow(() -> new NotFoundException("{join["entity"]}", List.of({join_key})));',
                    f"{_repo(join)}.{query_name(context, remove)}(link);",
                ],
                False,
            ),
            4,
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
    imports = JavaImports(pkg).add(qualified(context, info, "entity", info["entity"]), f"{context['base']}.UnitOfWork")
    for column in info["columns"]:
        if column["javaImport"]:
            imports.add(column["javaImport"])
    dtos = context["settings"]["serviceTypes"] == "dtos"
    writer = {"context": context, "info": info, "imports": imports, "dtos": dtos}
    if dtos:
        imports.add(qualified(context, info, "dtos", read_dto(info)))
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
        helpers.append(_changes_method(writer))
    hidden = bool(info["hidden"]) and not dtos
    members = []
    for block in [*helpers, *operations]:
        if block:
            members += [
                "",
                *[(("" if line == "" else f"    {line}") if isinstance(line, str) else line) for line in block],
            ]
    one = len(info["hidden"]) == 1
    content = lines(
        f"package {pkg};",
        "",
        imports.write(),
        "",
        f"/** Operations on {info['name']}. {TRANSACTIONS[context['settings']['transactions']]} */",
        f"public class {service_class(info)} {{",
        hidden
        and f"    // TODO: {', '.join(info['hidden'])} {'is' if one else 'are'} returned with the entity; use DTOs to leave {'it' if one else 'them'} out",
        "    private final UnitOfWork uow;",
        "",
        f"    public {service_class(info)}(UnitOfWork uow) {{",
        "        this.uow = uow;",
        "    }",
        *members,
        "}",
        "",
    )
    return {"path": java_path(pkg, service_class(info)), "content": content}
