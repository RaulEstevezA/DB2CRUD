"""The service of each table: its operations and what each one checks before it writes, in the order of the design
(docs/design.md, section 3). The values of a create or an update are gathered in an array of the fields given; every
write runs in $uow->transaction(...); errors are domain exceptions without HTTP codes. Mirrors
web/src/core/generators/php/common/services.ts."""

from ....js import number_text
from ...types import lines
from .context import (
    class_name,
    column_of,
    common_class,
    error_class,
    find_info,
    ind,
    namespace_of,
    operation_name,
    path_of,
    query,
    query_name,
    root_class,
    service_class,
)
from .documents import document_rule, list_of
from .dtos import (
    create_columns,
    create_dto,
    partial_shape,
    partial_updates,
    read_columns,
    read_dto,
    update_class,
    update_columns,
    update_type,
)
from .php import PhpUses, access, pascal_name, php_string
from .repositories import doc_block

NUMERIC = ("integer", "decimal", "float")

# The variables the checks already use: a column with one of these names gets Value after it
TAKEN = {
    "values",
    "errors",
    "creating",
    "current",
    "uow",
    "value",
    "other",
    "entity",
    "changes",
    "row",
    "link",
    "version",
    "data",
}


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _repo(info: dict, uow: str = "$uow") -> str:
    return f"{uow}->{info['attr']}"


def _key_params(info: dict) -> str:
    return ", ".join(f"{column['php']} ${column['field']}" for column in info["key"])


def _key_args(info: dict) -> str:
    return ", ".join(f"${column['field']}" for column in info["key"])


def _key_value(info: dict) -> str:
    return f"${info['key'][0]['field']}" if len(info["key"]) == 1 else f"[{_key_args(info)}]"


def _local(column: dict) -> str:
    field = column["field"]
    return f"${field}Value" if field in TAKEN else f"${field}"


def _given_or_current(column: dict) -> str:
    """The value of a field as the change gives it, or as the row has it."""
    field = php_string(column["field"])
    current = access("$current?", column["prop"])
    return f"{_local(column)} = array_key_exists({field}, $values) ? $values[{field}] : {current};"


def _values_doc(summary: str) -> list[str]:
    return doc_block(summary, ["@param array<string, mixed> $values"], "")


def _value_rules(column: dict, checks: list[dict]) -> list[str]:
    rules = []
    name = column["column"]["name"]
    column_type = column["column"]["type"]

    def rule(condition: str, message: str) -> list[str]:
        return [
            f"if ({condition}) {{",
            f"    $errors[] = new FieldError({php_string(name)}, {php_string(message)});",
            "}",
        ]

    if column_type["kind"] == "text" and column_type.get("length") is not None and not column_type.get("objectId"):
        length = column_type["length"]
        rules.extend(rule(f"is_string($value) && mb_strlen($value) > {length}", f"is longer than {length} characters"))
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != name:
            continue
        if parsed["kind"] == "in":
            values = [_text(item) for item in parsed["values"]]
            message = f"must be one of: {', '.join(values)}"
            if column_type["kind"] in NUMERIC:
                rules.extend(rule(f"!in_array((float) $value, [{', '.join(values)}])", message))
            else:
                choices = ", ".join(php_string(value) for value in values)
                rules.extend(rule(f"!in_array((string) $value, [{choices}], true)", message))
        if parsed["kind"] == "compare":
            op, bound = parsed["op"], _text(parsed["value"])
            rules.extend(rule(f"!((float) $value {op} {bound})", f"must be {op} {bound}"))
        if parsed["kind"] == "length":
            op, bound = parsed["op"], _text(parsed["value"])
            rules.extend(rule(f"!(mb_strlen((string) $value) {op} {bound})", f"must have {op} {bound} characters"))
    return rules


def _validate_method(writer: dict) -> list:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
    uses.add(
        error_class(context, "FieldError"),
        error_class(context, "ValidationFailedException"),
        root_class(context, "UnitOfWork"),
    )
    blocks = []
    for column in create_columns(info):
        name = column["column"]["name"]
        field = php_string(column["field"])
        if column["required"]:
            missing = {"condition": f"$creating || array_key_exists({field}, $values)", "message": "is required"}
        elif not column["column"]["nullable"]:
            missing = {"condition": f"!$creating && array_key_exists({field}, $values)", "message": "cannot be empty"}
        else:
            missing = None
        rules = _value_rules(column, info["table"]["checks"])
        nested = document_rule(context, column["column"]["type"])
        if nested is not None:
            uses.add(root_class(context, "Documents"))
            problems = f"Documents::problems($value, {nested}, {php_string(name)})"
            rules.append(f"$errors = [...$errors, ...{problems}];")
        if not missing and not rules:
            continue
        if missing:
            report = [
                f"    if ({missing['condition']}) {{",
                f"        $errors[] = new FieldError({php_string(name)}, {php_string(missing['message'])});",
                "    }",
            ]
            body = ["if ($value === null) {", *report, *(["} else {", *ind(rules)] if rules else []), "}"]
        else:
            body = ["if ($value !== null) {", *ind(rules), "}"]
        blocks.append([f"$value = $values[{field}] ?? null;", *body])
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
                    f"// TODO: {', '.join(key['columns'])} must point to a row of {key['references']['table']}; that "
                    "table has no read by key to check it"
                ]
            )
            continue
        columns = [column_of(info, name) for name in key["columns"]]
        present = " && ".join(f"{_local(column)} !== null" for column in columns)
        args = ", ".join(_local(column) for column in columns)
        blocks.append(
            [
                *(_given_or_current(column) for column in columns),
                f"if ({present} && {_repo(parent)}->{query_name(context, read)}({args}) === null) {{",
                f"    $errors[] = new FieldError({php_string(', '.join(key['columns']))}, "
                f"{php_string('no ' + parent['entity'] + ' has this key')});",
                "}",
            ]
        )
    return [
        *_values_doc(
            f'Checks the values against the rules of the "{info["name"]}" table, and the rows they point to; throws '
            "ValidationFailedException with every problem."
        ),
        f"private static function validate(UnitOfWork $uow, array $values, ?{info['entity']} $current): void",
        "{",
        "    $creating = $current === null;",
        "    $errors = [];",
        *(line for block in blocks for line in ind(block)),
        "    if ($errors !== []) {",
        f"        throw new ValidationFailedException({php_string(info['entity'])}, $errors);",
        "    }",
        "}",
    ]


def _unique_method(writer: dict) -> list:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
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
        uses.add(error_class(context, "ConflictException"))
        columns = [column_of(info, name) for name in unique["columns"]]
        other = " || ".join(
            f"{access('$other', column['prop'])} != {access('$current', column['prop'])}" for column in info["key"]
        )
        taken = php_string(f"{', '.join(unique['columns'])} is already taken")
        fields = ", ".join(php_string(column["field"]) for column in columns)
        checks.append(
            [
                *(_given_or_current(column) for column in columns),
                f"if ({' && '.join(f'{_local(column)} !== null' for column in columns)}) {{",
                f"    $other = {_repo(info)}->{query_name(context, read)}({', '.join(_local(column) for column in columns)});",
                f"    if ($other !== null && ($current === null || {other})) {{",
                f"        throw new ConflictException({php_string(info['entity'])}, {taken}, [{fields}]);",
                "    }",
                "}",
            ]
        )
    if not checks:
        return []
    return [
        *_values_doc("Values that must be unique are not taken by another row."),
        f"private static function checkUnique(UnitOfWork $uow, array $values, ?{info['entity']} $current): void",
        "{",
        *(line for block in checks for line in ind(block)),
        "}",
    ]


def _check_method(writer: dict) -> list:
    info = writer["info"]
    return [
        *_values_doc("Every check before a write: the values, the rows they point to, the unique values."),
        f"private static function check(UnitOfWork $uow, array $values, ?{info['entity']} $current): void",
        "{",
        "    self::validate($uow, $values, $current);",
        "    self::checkUnique($uow, $values, $current);" if info["table"]["uniques"] else None,
        "}",
    ]


def _apply_method(writer: dict) -> list:
    info = writer["info"]
    result = [
        *_values_doc("Sets the given values on the entity."),
        f"private static function apply({info['entity']} $entity, array $values): void",
        "{",
    ]
    for column in create_columns(info):
        field = php_string(column["field"])
        result.extend(
            [
                f"    if (array_key_exists({field}, $values)) {{",
                f"        {access('$entity', column['prop'])} = $values[{field}];",
                "    }",
            ]
        )
    return [*result, "}"]


def _find_method(writer: dict) -> list:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
    read = query(info, "getByKey")
    if not read:
        return []
    uses.add(error_class(context, "NotFoundException"), root_class(context, "UnitOfWork"))
    return [
        f"/** The {info['entity']} with this key; NotFoundException when there is none. */",
        f"private static function find(UnitOfWork $uow, {_key_params(info)}): {info['entity']}",
        "{",
        f"    return {_repo(info)}->{query_name(context, read)}({_key_args(info)}) ?? throw new "
        f"NotFoundException({php_string(info['entity'])}, {_key_value(info)});",
        "}",
    ]


def _read_method(writer: dict) -> list:
    if not writer["dtos"]:
        return []
    info = writer["info"]
    return [
        f"/** The {info['entity']} as services return it. */",
        f"private static function read({info['entity']} $entity): {read_dto(info)}",
        "{",
        f"    return new {read_dto(info)}(",
        *(f"        {column['field']}: {access('$entity', column['prop'])}," for column in read_columns(info)),
        "    );",
        "}",
    ]


def _given_method(writer: dict) -> list:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
    if partial_updates(context):
        fields = ", ".join(php_string(column["field"]) for column in update_columns(info))
        return [
            "/**",
            " * The values an update gives, by field: only the fields of the table that can change.",
            " *",
            " * @param array<string, mixed> $changes",
            " * @return array<string, mixed>",
            " */",
            "private static function given(array $changes): array",
            "{",
            f"    return array_intersect_key($changes, array_flip([{fields}]));",
            "}",
        ]
    changes_type = update_type(context, info)
    uses.add(update_class(context, info))
    patch = context["settings"]["updates"] == "patch"
    body = []
    for column in update_columns(info):
        field, key = column["field"], php_string(column["field"])
        if patch:
            body.extend(
                [
                    f"    if ($changes->{field}->isPresent) {{",
                    f"        $values[{key}] = $changes->{field}->value;",
                    "    }",
                ]
            )
        else:
            body.append(f"    $values[{key}] = $changes->{field};")
    return [
        "/**",
        " * The values an update gives, by field.",
        " *",
        " * @return array<string, mixed>",
        " */",
        f"private static function given({changes_type} $changes): array",
        "{",
        "    $values = [];",
        *body,
        "    return $values;",
        "}",
    ]


def _out(writer: dict, expression: str) -> str:
    return f"self::read({expression})" if writer["dtos"] else expression


def _result_type(writer: dict) -> str:
    return read_dto(writer["info"]) if writer["dtos"] else writer["info"]["entity"]


def _version_check(writer: dict) -> list[str]:
    version = writer["info"]["version"]
    if not version:
        return []
    writer["uses"].add(error_class(writer["context"], "ConflictException"))
    return [
        f"if ({access('$current', version['prop'])} != $version) {{",
        f"    throw new ConflictException({php_string(writer['info']['entity'])}, 'was changed by someone else since it "
        f"was read', [{php_string(version['field'])}]);",
        "}",
    ]


def _children_lines(writer: dict) -> list[str]:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
    if not info["children"]:
        return []
    result = []
    for link in info["children"]["links"]:
        child = find_info(context, link["table"])
        listing = query(child, "listByParent", link["columns"]) if child else None
        if not child or not listing:
            result.append(
                f"// TODO: rows of {link['table']} may point here; that table has no list by "
                f"{', '.join(link['columns'])} to look for them"
            )
            continue
        args = ", ".join(access("$current", column_of(info, name)["prop"]) for name in link["references"])
        rows = f"{_repo(child)}->{query_name(context, listing)}({args})"
        if info["children"]["policy"] == "block":
            uses.add(error_class(context, "ConflictException"))
            reason = php_string(f"rows of {link['table']} still point to it")
            result.extend(
                [
                    f"if ({rows} !== []) {{",
                    f"    throw new ConflictException({php_string(info['entity'])}, {reason}, [{php_string(link['table'])}]);",
                    "}",
                ]
            )
        else:
            remove = query(child, "delete")
            if not remove:
                result.append(f"// TODO: rows of {link['table']} must be deleted first, and that table has no delete")
            else:
                result.extend(
                    [f"foreach ({rows} as $row) {{", f"    {_repo(child)}->{query_name(context, remove)}($row);", "}"]
                )
    return result


def _in_transaction(items: list[str], captured: list[str], returns: str | None) -> list[str]:
    """$this->uow->transaction(function (UnitOfWork $uow) use (...): T { ... });"""
    use = f" use ({', '.join(captured)})" if captured else ""
    return [
        f"{'return ' if returns else ''}$this->uow->transaction(function (UnitOfWork $uow){use}: {returns or 'void'} {{",
        *(f"    {line}" for line in items),
        "});",
    ]


def _key_locals(info: dict) -> list[str]:
    return [f"${column['field']}" for column in info["key"]]


def _operation_lines(writer: dict, operation: dict) -> list:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
    name = operation_name(context, operation)
    entity = info["entity"]
    kind = operation["kind"]
    paging = context["settings"]["paging"]
    if kind == "create":
        insert = query(info, "insert")
        if not insert:
            return []
        if writer["dtos"]:
            uses.add(class_name(namespace_of(context, info, "dtos"), create_dto(info)))
        uses.add(root_class(context, "UnitOfWork"))
        variable = f"${entity[:1].lower()}{entity[1:]}"
        source = "$data" if writer["dtos"] else variable
        param = f"{create_dto(info)} $data" if writer["dtos"] else f"{entity} {variable}"
        values = [
            f"        {php_string(column['field'])} => "
            + (f"$data->{column['field']}" if writer["dtos"] else access(source, column["prop"]))
            + ","
            for column in create_columns(info)
        ]
        stored = f"{_repo(info)}->{query_name(context, insert)}({'$entity' if writer['dtos'] else variable})"
        return [
            f"/** Stores a new {entity} after checking it. */",
            f"public function {name}({param}): {_result_type(writer)}",
            "{",
            "    $values = array_filter([",
            *values,
            "    ], fn (mixed $value) => $value !== null);",
            *ind(
                _in_transaction(
                    [
                        "self::check($uow, $values, null);",
                        *([f"$entity = new {entity}();", "self::apply($entity, $values);"] if writer["dtos"] else []),
                        f"return {_out(writer, stored)};",
                    ],
                    ["$values"] if writer["dtos"] else ["$values", variable],
                    _result_type(writer),
                )
            ),
            "}",
        ]
    if kind == "get":
        if not query(info, "getByKey"):
            return []
        return [
            f"/** The {entity} with this key; NotFoundException when there is none. */",
            f"public function {name}({_key_params(info)}): {_result_type(writer)}",
            "{",
            f"    return {_out(writer, f'self::find($this->uow, {_key_args(info)})')};",
            "}",
        ]
    if kind == "list":
        listing = query(info, "list")
        if not listing:
            return []
        method = f"{_repo(info, '$this->uow')}->{query_name(context, listing)}"
        result = _result_type(writer)
        mapped = "->map(self::read(...))" if writer["dtos"] else ""
        if paging == "offset":
            uses.add(common_class(context, "Page"))
            return [
                *doc_block(f"A page of {info['name']}, by primary key.", [f"@return Page<{result}>"], ""),
                f"public function {name}(int $offset, int $limit): Page",
                "{",
                f"    return {method}($offset, $limit){mapped};",
                "}",
            ]
        if paging == "cursor":
            uses.add(common_class(context, "CursorPage"))
            return [
                *doc_block(
                    f"A page of {info['name']} after the key $after (null for the first page), by primary key.",
                    ["@param list<mixed>|null $after", f"@return CursorPage<{result}>"],
                    "",
                ),
                f"public function {name}(?array $after, int $limit): CursorPage",
                "{",
                f"    return {method}($after, $limit){mapped};",
                "}",
            ]
        every = f"array_map(self::read(...), {method}())" if writer["dtos"] else f"{method}()"
        return [
            *doc_block(f"Every {entity}, by primary key.", [f"@return list<{result}>"], ""),
            f"public function {name}(): array",
            "{",
            f"    return {every};",
            "}",
        ]
    if kind == "update":
        update = query(info, "update")
        if not update or not query(info, "getByKey"):
            return []
        uses.add(root_class(context, "UnitOfWork"))
        version = f", {info['version']['php']} $version" if info["version"] else ""
        partial = partial_updates(context)
        summary = f"Changes the given values of a {entity}{', read at $version' if info['version'] else ''}."
        changes = "array" if partial else update_type(context, info)
        stored = f"{_repo(info)}->{query_name(context, update)}($current)"
        return [
            *(doc_block(summary, [f"@param {partial_shape(info)} $changes"], "") if partial else [f"/** {summary} */"]),
            f"public function {name}({_key_params(info)}, {changes} $changes{version}): {_result_type(writer)}",
            "{",
            "    $values = self::given($changes);",
            *ind(
                _in_transaction(
                    [
                        f"$current = self::find($uow, {_key_args(info)});",
                        *_version_check(writer),
                        "self::check($uow, $values, $current);",
                        "self::apply($current, $values);",
                        *(
                            [f"{access('$current', info['version']['prop'])} = $version + 1;"]
                            if info["version"]
                            else []
                        ),
                        f"return {_out(writer, stored)};",
                    ],
                    [*_key_locals(info), "$values", *(["$version"] if info["version"] else [])],
                    _result_type(writer),
                )
            ),
            "}",
        ]
    if kind == "delete":
        remove = query(info, "delete")
        update = query(info, "update")
        soft = info["soft"]
        if not query(info, "getByKey") or (not soft and not remove) or (soft and not update):
            return []
        uses.add(root_class(context, "UnitOfWork"))
        version = f", {info['version']['php']} $version" if info["version"] else ""
        if not soft:
            mark = ""
        elif soft["column"]["type"]["kind"] == "boolean":
            mark = "true"
        elif soft["php"] == "\\DateTimeImmutable":
            mark = "new \\DateTimeImmutable()"
        else:
            mark = "date('Y-m-d H:i:s')"
        if soft:
            action = [
                f"{access('$current', soft['prop'])} = {mark};",
                f"{_repo(info)}->{query_name(context, update)}($current);",
            ]
            doc = f"/** Marks a {entity} as deleted ({soft['column']['name']}); reads leave it out from then on. */"
        else:
            action = [f"{_repo(info)}->{query_name(context, remove)}($current);"]
            doc = f"/** Deletes a {entity}. */"
        return [
            doc,
            f"public function {name}({_key_params(info)}{version}): void",
            "{",
            *ind(
                _in_transaction(
                    [
                        f"$current = self::find($uow, {_key_args(info)});",
                        *_version_check(writer),
                        *_children_lines(writer),
                        *action,
                    ],
                    [*_key_locals(info), *(["$version"] if info["version"] else [])],
                    None,
                )
            ),
            "}",
        ]
    if kind in ("find", "listByParent"):
        read = query(info, "findByUnique" if kind == "find" else "listByParent", operation["columns"])
        if not read:
            return []
        columns = [column_of(info, column) for column in operation["columns"]]
        params = ", ".join(f"{column['php']} ${column['field']}" for column in columns)
        rows = f"{_repo(info, '$this->uow')}->{query_name(context, read)}({', '.join('$' + column['field'] for column in columns)})"
        joined = " and ".join(operation["columns"])
        if kind == "find":
            body = (
                [f"    $entity = {rows};", "    return $entity === null ? null : self::read($entity);"]
                if writer["dtos"]
                else [f"    return {rows};"]
            )
            return [
                f"/** The {entity} with this {joined}, or null. */",
                f"public function {name}({params}): ?{_result_type(writer)}",
                "{",
                *body,
                "}",
            ]
        every = f"array_map(self::read(...), {rows})" if writer["dtos"] else rows
        return [
            *doc_block(f"The {info['name']} with this {joined}.", [f"@return list<{_result_type(writer)}>"], ""),
            f"public function {name}({params}): array",
            "{",
            f"    return {every};",
            "}",
        ]
    if kind in ("link", "unlink"):
        return _link_lines(writer, operation, name)
    # One item of a list: only document databases have them
    if kind in ("addItem", "removeItem"):
        return _item_lines(writer, operation, name)
    return []


def _item_lines(writer: dict, operation: dict, name: str) -> list:
    """Adds or removes one item of a list, so two people changing the same list do not undo each other."""
    context, info, uses = writer["context"], writer["info"], writer["uses"]
    adds = operation["kind"] == "addItem"
    change = query(info, "addItem" if adds else "removeItem", operation["columns"])
    if not change or not query(info, "getByKey"):
        return []
    listed = list_of(context, info, change)
    kept = listed["column"]["column"]["name"]
    params = [{"name": listed["item"], "type": listed["php"]}] if adds else listed["params"]
    param = params[0]["name"]
    version = f", {info['version']['php']} $version" if info["version"] else ""
    items = f"({access('$current', listed['column']['prop'])} ?? [])"
    if listed["by"] == "id":
        missing = f"!in_array(${param}, array_column({items}, '_id'), true)"
    elif listed["by"] == "value":
        missing = f"!in_array(${param}, {items}, true)"
    else:
        missing = f"!array_key_exists(${param}, {items})"
    position = not adds and listed["by"] == "position"
    uses.add(error_class(context, "NotFoundException"), root_class(context, "UnitOfWork"))
    if position:
        uses.add(error_class(context, "ConflictException"))
    rule = document_rule(context, listed["type"]) if adds else None
    if rule is not None:
        uses.add(root_class(context, "Documents"), error_class(context, "ValidationFailedException"))
    entity = php_string(info["entity"])
    if position:
        field = php_string(listed["column"]["field"])
        gone = f"new ConflictException({entity}, 'was changed by someone else since it was read', [{field}])"
    else:
        gone = f"new NotFoundException({entity}, {_key_value(info)})"
    names = [f"${item['name']}" for item in params]
    args = ", ".join([_key_args(info), *names, *([f"count({items})"] if position else [])])
    read_at = ", read at $version" if info["version"] else ""
    by = "identifier" if listed["by"] == "id" else listed["by"]
    signature = ", ".join(f"{item['type']} ${item['name']}" for item in params)
    call = f"{_repo(info)}->{query_name(context, change)}({args}) ?? throw {gone}"
    label = php_string(pascal_name(listed["item"]))
    return [
        f"/** Adds an item to {kept}{read_at}. */"
        if adds
        else f"/** Removes an item from {kept}, by its {by}{read_at}. */",
        f"public function {name}({_key_params(info)}, {signature}{version}): {_result_type(writer)}",
        "{",
        *(
            [
                f"    $errors = Documents::problems(${listed['item']}, {rule}, {php_string(kept)});",
                "    if ($errors !== []) {",
                f"        throw new ValidationFailedException({entity}, $errors);",
                "    }",
            ]
            if rule is not None
            else []
        ),
        *ind(
            _in_transaction(
                [
                    f"{'' if adds and not info['version'] else '$current = '}self::find($uow, {_key_args(info)});",
                    *_version_check(writer),
                    *(
                        []
                        if adds
                        else [f"if ({missing}) {{", f"    throw new NotFoundException({label}, ${param});", "}"]
                    ),
                    f"return {_out(writer, call)};",
                ],
                [*_key_locals(info), *names, *(["$version"] if info["version"] else [])],
                _result_type(writer),
            )
        ),
        "}",
    ]


def _link_lines(writer: dict, operation: dict, name: str) -> list:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
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
    params = ", ".join(f"{column['php']} ${column['field']}" for column in every)
    captured = [f"${column['field']}" for column in every]
    join_key = ", ".join(f"${column['field']}" for column in join["key"])
    found = f"{_repo(join)}->{query_name(context, read)}({join_key})"
    uses.add(error_class(context, "NotFoundException"), root_class(context, "UnitOfWork"))
    if operation["kind"] == "link":
        insert = query(join, "insert")
        far_read = query(far_info, "getByKey")
        if not insert or not far_read or not query(info, "getByKey"):
            return []
        uses.add(
            error_class(context, "ConflictException"), class_name(namespace_of(context, join, "entity"), join["entity"])
        )
        far_args = ", ".join(f"${column['field']}" for column in far_cols)
        far_key = far_args if len(far_cols) == 1 else f"[{far_args}]"
        linked = php_string(f"is already linked to this {far_info['entity']}")
        far_fields = ", ".join(php_string(column["field"]) for column in far_cols)
        return [
            f"/** Links a {info['entity']} and a {far_info['entity']} ({join['name']}). */",
            f"public function {name}({params}): void",
            "{",
            *ind(
                _in_transaction(
                    [
                        f"self::find($uow, {', '.join('$' + column['field'] for column in own_cols)});",
                        f"if ({_repo(far_info)}->{query_name(context, far_read)}({far_args}) === null) {{",
                        f"    throw new NotFoundException({php_string(far_info['entity'])}, {far_key});",
                        "}",
                        f"if ({found} !== null) {{",
                        f"    throw new ConflictException({php_string(info['entity'])}, {linked}, [{far_fields}]);",
                        "}",
                        f"$link = new {join['entity']}();",
                        *(f"{access('$link', column['prop'])} = ${column['field']};" for column in every),
                        f"{_repo(join)}->{query_name(context, insert)}($link);",
                    ],
                    captured,
                    None,
                )
            ),
            "}",
        ]
    remove = query(join, "delete")
    if not remove:
        return []
    return [
        f"/** Removes the link between a {info['entity']} and a {far_info['entity']} ({join['name']}). */",
        f"public function {name}({params}): void",
        "{",
        *ind(
            _in_transaction(
                [
                    f"$link = {found} ?? throw new NotFoundException({php_string(join['entity'])}, [{join_key}]);",
                    f"{_repo(join)}->{query_name(context, remove)}($link);",
                ],
                captured,
                None,
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
    ns = namespace_of(context, info, "service")
    uses = PhpUses(ns).add(
        class_name(namespace_of(context, info, "entity"), info["entity"]), root_class(context, "UnitOfWork")
    )
    dtos = context["settings"]["serviceTypes"] == "dtos"
    writer = {"context": context, "info": info, "uses": uses, "dtos": dtos}
    if dtos:
        uses.add(class_name(namespace_of(context, info, "dtos"), read_dto(info)))
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
    hidden = bool(info["hidden"]) and not dtos
    members = [block for block in [*helpers, *operations] if block]
    hidden_line = None
    if hidden:
        one = len(info["hidden"]) == 1
        hidden_line = (
            f"    // TODO: {', '.join(info['hidden'])} {'is' if one else 'are'} returned with the entity; use DTOs to "
            f"leave {'it' if one else 'them'} out"
        )
    return {
        "path": path_of(ns, service_class(info)),
        "content": lines(
            "<?php",
            "",
            "declare(strict_types=1);",
            "",
            f"namespace {ns};",
            "",
            uses.write(),
            "",
            f"/** Operations on {info['name']}. {TRANSACTIONS[context['settings']['transactions']]} */",
            f"final class {service_class(info)}",
            "{",
            hidden_line,
            "    public function __construct(private readonly UnitOfWork $uow)",
            "    {",
            "    }",
            *(line for block in members for line in ["", *ind(block)]),
            "}",
            "",
        ),
    }
