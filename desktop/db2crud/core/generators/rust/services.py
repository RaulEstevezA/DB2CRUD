"""The service of each table: its operations and what each one checks before it writes, in the order of the design
(docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
version; then children and soft deletes. The values of a create or an update are gathered in a Values struct of the
fields given (None when not given, Some(None) when given empty), so every way an update can come is checked and
applied the same way. Writes run in a transaction of the unit of work when the settings say so; errors are DomainError
values without HTTP codes. Rust refuses private code nobody calls, so only the helpers the operations use are written.
Mirrors web/src/core/generators/rust/services.ts."""

import re

from ...js import js_string
from .context import (
    column_of,
    file_of,
    find_info,
    is_in,
    key_type,
    module_of,
    operation_name,
    path_in,
    query,
    query_name,
    rs_file,
    service_type,
    stored,
)
from .documents import check_call, document_check_functions, document_rules, list_of
from .dtos import (
    create_columns,
    create_dto,
    read_columns,
    read_dto,
    update_columns,
    update_path,
    update_struct,
    update_type,
)
from .rust import RsUses, rs_string, snake_name, type_name
from .support import COMMON, DOMAIN_ERROR, ERRORS, UNIT_OF_WORK
from .values import now_of


def _ind(items: list[str], spaces: int = 4) -> list[str]:
    return ["" if line == "" else " " * spaces + line for line in items]


def _repo(info: dict) -> str:
    return f"uow.{info['attr']}()"


def _pass(column: dict) -> str:
    """A value passed on, cloned when it is not Copy so it can be used again."""
    return column["field"] if column["copy"] else f"{column['field']}.clone()"


def _key_params(info: dict) -> str:
    return ", ".join(f"{column['field']}: {column['rs']}" for column in info["key"])


def _key_args(info: dict) -> str:
    return ", ".join(column["field"] for column in info["key"])


def _key_value(info: dict) -> str:
    return info["key"][0]["field"] if len(info["key"]) == 1 else f"({_key_args(info)})"


# The variables the checks already use: a column with one of these names gets _value after it
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
    "data",
    "link",
    "row",
    "transaction",
}


def _local(column: dict) -> str:
    return f"{column['key']}_value" if column["key"] in TAKEN else column["field"]


NUMERIC_KINDS = {"integer", "decimal", "float"}


def _given_or_current(info: dict, column: dict) -> str:
    """The value a check uses: as the values give it, or as the row has it."""
    current = f"current.and_then(|current| current.{column['field']}{'' if column['copy'] else '.clone()'})"
    # A column the client never sends is only as the row has it
    if not is_in(column, create_columns(info)):
        return f"let {_local(column)} = {current};"
    return f"let {_local(column)} = values.{column['field']}.clone().unwrap_or_else(|| {current});"


def _number(value) -> str:
    text = js_string(value)
    return text if re.search(r"[.eE]", text) else f"{text}.0"


def _as_number(column: dict) -> str:
    """The value of a field being checked (value, a reference), as an f64."""
    return "f64::try_from(*value).unwrap_or(f64::NAN)" if column["rs"] == "rust_decimal::Decimal" else "(*value as f64)"


def _as_text(column: dict) -> str:
    """The value of a field being checked, as text."""
    return "value.as_str()" if column["rs"] == "String" else "value.to_string().as_str()"


def _value_rules(column: dict, checks: list[dict]) -> list[str]:
    rules: list[str] = []
    name = column["column"]["name"]
    column_type = column["column"]["type"]

    def rule(condition: str, message: str) -> list[str]:
        return [
            f"if {condition} {{",
            f"    errors.push(FieldError::new({rs_string(name)}, {rs_string(message)}));",
            "}",
        ]

    if column_type["kind"] == "text" and column_type.get("length") is not None and not column_type.get("objectId"):
        length = js_string(column_type["length"])
        rules += rule(f"value.chars().count() > {length}", f"is longer than {length} characters")
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != name:
            continue
        if parsed["kind"] == "in":
            message = f"must be one of: {', '.join(js_string(item) for item in parsed['values'])}"
            if column_type["kind"] in NUMERIC_KINDS:
                values = ", ".join(_number(item) for item in parsed["values"])
                rules += rule(f"![{values}].contains(&{_as_number(column)})", message)
            else:
                values = ", ".join(rs_string(js_string(item)) for item in parsed["values"])
                rules += rule(f"![{values}].contains(&{_as_text(column)})", message)
        if parsed["kind"] == "compare":
            rules += rule(
                f"!({_as_number(column)} {parsed['op']} {_number(parsed['value'])})",
                f"must be {parsed['op']} {js_string(parsed['value'])}",
            )
        if parsed["kind"] == "length":
            value = js_string(parsed["value"])
            rules += rule(
                f"!({_as_text(column)}.chars().count() {parsed['op']} {value})",
                f"must have {parsed['op']} {value} characters",
            )
    return rules


def _patterns(columns: list[dict]) -> tuple[str, str]:
    """The pattern and the value of an if let over the locals of some columns."""
    if len(columns) == 1:
        return f"Some({_local(columns[0])})", _local(columns[0])
    return (
        f"({', '.join(f'Some({_local(column)})' for column in columns)})",
        f"({', '.join(_local(column) for column in columns)})",
    )


def _validate_blocks(writer: dict) -> tuple[list[list[str]], bool, bool, bool]:
    """The checks of validate(), and whether they use creating, current and uow."""
    context, info = writer["context"], writer["info"]
    blocks: list[list[str]] = []
    creating = False
    current = False
    uow = False
    for column in create_columns(info):
        name = column["column"]["name"]
        field = column["field"]
        if column["required"]:
            missing = {"condition": f"creating || values.{field}.is_some()", "message": "is required"}
        elif not column["column"]["nullable"]:
            missing = {"condition": f"!creating && values.{field}.is_some()", "message": "cannot be empty"}
        else:
            missing = None
        rules = [*_value_rules(column, info["table"]["checks"]), *document_rules(context, info, column)]
        if not missing and not rules:
            continue
        value = f"values.{field}.as_ref().and_then(|value| value.as_ref())"
        if missing:
            creating = True
            blocks.append(
                [
                    f"match {value} {{",
                    "    None => {",
                    f"        if {missing['condition']} {{",
                    f"            errors.push(FieldError::new({rs_string(name)}, {rs_string(missing['message'])}));",
                    "        }",
                    "    }",
                    "    Some(value) => {" if rules else "    Some(_) => {}",
                    *([*_ind(rules, 8), "    }"] if rules else []),
                    "}",
                ]
            )
        else:
            blocks.append([f"if let Some(value) = {value} {{", *_ind(rules), "}"])
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
        current = True
        uow = True
        columns = [column_of(info, name) for name in key["columns"]]
        pattern, source = _patterns(columns)
        args = ", ".join(_local(column) for column in columns)
        blocks.append(
            [
                "{",
                *(f"    {_given_or_current(info, column)}" for column in columns),
                f"    if let {pattern} = {source} {{",
                f"        if {_repo(parent)}.{query_name(context, read)}({args}).await?.is_none() {{",
                f"            errors.push(FieldError::new({rs_string(', '.join(key['columns']))}, {rs_string('no ' + parent['entity'] + ' has this key')}));",
                "        }",
                "    }",
                "}",
            ]
        )
    return blocks, creating, current or creating, uow


def _param(name: str, used: bool) -> str:
    return name if used else f"_{name}"


def _validate_function(writer: dict) -> list[str]:
    info, uses = writer["info"], writer["uses"]
    blocks, creating, current, uow = _validate_blocks(writer)
    if all(len(block) == 1 and block[0].startswith("//") for block in blocks):
        return [line for block in blocks for line in block]
    uses.add(f"{ERRORS}::FieldError")
    return [
        f'/// Checks the values against the rules of the "{info["name"]}" table, and the rows they point to; ValidationFailed lists every problem.',
        f"async fn validate({_param('uow', uow)}: &dyn UnitOfWork, values: &Values, {_param('current', current)}: Option<&{info['entity']}>) -> Result<(), DomainError> {{",
        *(["    let creating = current.is_none();"] if creating else []),
        "    let mut errors = Vec::new();",
        *(line for block in blocks for line in _ind(block)),
        "    if errors.is_empty() {",
        "        Ok(())",
        "    } else {",
        f"        Err(DomainError::ValidationFailed {{ entity: {rs_string(info['entity'])}.to_string(), errors }})",
        "    }",
        "}",
    ]


def _unique_checks(writer: dict) -> tuple[list[list[str]], list[str]]:
    """The checks of the unique values that have a read, and notes for those that have none."""
    context, info = writer["context"], writer["info"]
    checks: list[list[str]] = []
    notes: list[str] = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        joined = ", ".join(unique["columns"])
        if not read:
            notes.append(f"// {joined} must be unique: the database refuses repeated values (Conflict)")
            continue
        columns = [column_of(info, name) for name in unique["columns"]]
        other = " || ".join(f"other.{column['field']} != current.{column['field']}" for column in info["key"])
        pattern, source = _patterns(columns)
        args = ", ".join(_local(column) for column in columns)
        fields = ", ".join(rs_string(column["key"]) for column in columns)
        checks.append(
            [
                "{",
                *(f"    {_given_or_current(info, column)}" for column in columns),
                f"    if let {pattern} = {source} {{",
                f"        if let Some(other) = {_repo(info)}.{query_name(context, read)}({args}).await? {{",
                f"            if current.is_none_or(|current| {other}) {{",
                f"                return Err(DomainError::conflict({rs_string(info['entity'])}, {rs_string(joined + ' is already taken')}, &[{fields}]));",
                "            }",
                "        }",
                "    }",
                "}",
            ]
        )
    return checks, notes


def _check_functions(writer: dict) -> list[str]:
    """validate, check_unique and check_values: every check before a write."""
    info = writer["info"]
    validate = _validate_function(writer)
    validates = any(line.startswith("async fn validate") for line in validate)
    checks, notes = _unique_checks(writer)
    unique = (
        [
            "/// Values that must be unique are not taken by another row.",
            f"async fn check_unique(uow: &dyn UnitOfWork, values: &Values, current: Option<&{info['entity']}>) -> Result<(), DomainError> {{",
            *(line for block in checks for line in _ind(block)),
            "    Ok(())",
            "}",
        ]
        if checks
        else []
    )
    used = validates or bool(checks)
    calls = [
        *(
            ["validate(uow, values, current).await?;"]
            if validates
            else [line for line in validate if line.startswith("//")]
        ),
        *notes,
        *(["check_unique(uow, values, current).await"] if checks else ["Ok(())"]),
    ]
    return [
        *([*validate, ""] if validates else []),
        *([*unique, ""] if unique else []),
        "/// Every check before a write: the values, the rows they point to, the unique values.",
        f"async fn check_values({_param('uow', used)}: &dyn UnitOfWork, {_param('values', used)}: &Values, {_param('current', used)}: Option<&{info['entity']}>) -> Result<(), DomainError> {{",
        *_ind(calls),
        "}",
    ]


def _values_struct(info: dict) -> list[str]:
    columns = create_columns(info)
    return [
        "/// The values a create or an update gives, by field: None when not given, Some(None) when given empty.",
        "#[derive(Default)]",
        "struct Values {" if columns else "struct Values {}",
        *(f"    {column['field']}: Option<Option<{column['rs']}>>," for column in columns),
        *(["}"] if columns else []),
    ]


def _apply_function(info: dict) -> list[str]:
    columns = create_columns(info)
    used = bool(columns)
    lines: list[str] = []
    for column in columns:
        lines += [
            f"    if let Some(value) = &values.{column['field']} {{",
            f"        entity.{column['field']} = {'*value' if column['copy'] else 'value.clone()'};",
            "    }",
        ]
    return [
        "/// Sets the given values on the entity.",
        f"fn apply_values({_param('entity', used)}: &mut {info['entity']}, {_param('values', used)}: &Values) {{",
        *lines,
        "}",
    ]


def _find_function(writer: dict) -> list[str]:
    context, info = writer["context"], writer["info"]
    read = query(info, "getByKey")
    args = ", ".join(_pass(column) for column in info["key"])
    return [
        f"/// The {info['entity']} with this key; NotFound when there is none.",
        f"async fn find(uow: &dyn UnitOfWork, {_key_params(info)}) -> Result<{info['entity']}, DomainError> {{",
        f"    {_repo(info)}.{query_name(context, read)}({args}).await?.ok_or_else(|| DomainError::not_found({rs_string(info['entity'])}, {_key_value(info)}))",
        "}",
    ]


def _read_function(info: dict) -> list[str]:
    lines = []
    for column in read_columns(info):
        field = column["field"]
        if column["column"]["nullable"]:
            lines.append(f"        {field}: entity.{field},")
        else:
            lines.append(f"        {field}: entity.{field}.expect({rs_string(column['key'] + ' is set')}),")
    return [
        f"/// The {info['entity']} as services return it.",
        f"fn read(entity: {info['entity']}) -> {read_dto(info)} {{",
        f"    {read_dto(info)} {{",
        *lines,
        "    }",
        "}",
    ]


def _given_function(writer: dict) -> list[str]:
    context, info = writer["context"], writer["info"]
    mode = context["settings"]["updates"]
    columns = update_columns(info)

    def value(column: dict) -> str:
        field = column["field"]
        if mode == "patch":
            return f"changes.{field}.given()"
        if mode == "optional":
            return f"changes.{field}"
        return f"Some(changes.{field})" if column["column"]["nullable"] else f"Some(Some(changes.{field}))"

    every = len(columns) == len(create_columns(info))
    fields = ", ".join(f"{column['field']}: {value(column)}" for column in columns)
    return [
        "/// The values an update gives, by field.",
        f"fn given({_param('changes', bool(columns))}: {update_type(context, info)}) -> Values {{",
        "    Values::default()"
        if not columns
        else f"    Values {{ {fields}{'' if every else ', ..Default::default()'} }}",
        "}",
    ]


def _out(writer: dict, expression: str) -> str:
    if not writer["dtos"]:
        return expression
    writer["used"].add("read")
    return f"read({expression})"


def _reader(writer: dict) -> str:
    """read, the function that turns an entity into what the service returns."""
    writer["used"].add("read")
    return "read"


def _result_type(writer: dict) -> str:
    return read_dto(writer["info"]) if writer["dtos"] else writer["info"]["entity"]


def _version_check(writer: dict) -> list[str]:
    version = writer["info"]["version"]
    if not version:
        return []
    return [
        f"if current.{version['field']} != Some(version) {{",
        f'    return Err(DomainError::conflict({rs_string(writer["info"]["entity"])}, "was changed by someone else since it was read", &[{rs_string(version["key"])}]));',
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
        args = ", ".join(
            stored(f"current.{column_of(info, name)['field']}", column_of(info, name)) for name in link["references"]
        )
        rows = f"{_repo(child)}.{query_name(context, listing)}({args}).await?"
        if info["children"]["policy"] == "block":
            result += [
                f"if !{rows}.is_empty() {{",
                f"    return Err(DomainError::conflict({rs_string(info['entity'])}, {rs_string('rows of ' + link['table'] + ' still point to it')}, &[{rs_string(link['table'])}]));",
                "}",
            ]
        else:
            remove = query(child, "delete")
            if not remove:
                result.append(f"// TODO: rows of {link['table']} must be deleted first, and that table has no delete")
            else:
                result += [
                    f"for row in {rows} {{",
                    f"    {_repo(child)}.{query_name(context, remove)}(&row).await?;",
                    "}",
                ]
    return result


def _in_transaction(writer: dict, items: list[str], result: str) -> list[str]:
    """The lines of a write: in a transaction of its own when each operation has one."""
    if writer["context"]["settings"]["transactions"] != "operation":
        return ["let uow = self.unit_of_work.as_ref();", *items, result]
    return [
        "let transaction = self.unit_of_work.begin().await?;",
        "let uow = transaction.as_ref();",
        *items,
        "transaction.commit().await?;",
        result,
    ]


def _fn(signature: str, body: list[str]) -> list[str]:
    return [f"pub async fn {signature} {{", *_ind(body), "}"]


def _operation_lines(writer: dict, operation: dict) -> list[str]:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
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
            uses.add(path_in(module_of(context, info, "dtos"), create_dto(info)))
        writer["used"].update(("checkValues", "apply"))
        variable = "data" if dtos else snake_name(entity)
        columns = create_columns(info)
        values = ", ".join(f"{column['field']}: {variable}.{column['field']}.map(Some)" for column in columns)
        return [
            f"/// Stores a new {entity} after checking it.",
            *_fn(
                f"{name}(&self, {variable}: {create_dto(info) if dtos else entity}) -> Result<{_result_type(writer)}, DomainError>",
                [
                    f"let values = Values {{ {values} }};" if columns else "let values = Values {};",
                    *([f"let _ = {variable};"] if not columns else []),
                    *_in_transaction(
                        writer,
                        [
                            "check_values(uow, &values, None).await?;",
                            f"let mut entity = {entity}::default();",
                            "apply_values(&mut entity, &values);",
                            f"let created = {_repo(info)}.{query_name(context, insert)}(entity).await?;",
                        ],
                        f"Ok({_out(writer, 'created')})",
                    ),
                ],
            ),
        ]
    if kind == "get":
        if not query(info, "getByKey"):
            return []
        writer["used"].add("find")
        mapped = f".map({_reader(writer)})" if dtos else ""
        return [
            f"/// The {entity} with this key; NotFound when there is none.",
            *_fn(
                f"{name}(&self, {_key_params(info)}) -> Result<{_result_type(writer)}, DomainError>",
                [f"find(self.unit_of_work.as_ref(), {_key_args(info)}).await{mapped}"],
            ),
        ]
    if kind == "list":
        listing = query(info, "list")
        if not listing:
            return []
        method = f"self.unit_of_work.{info['attr']}().{query_name(context, listing)}"
        result = _result_type(writer)
        if paging == "offset":
            uses.add(f"{COMMON}::Page")
            mapped = f".map(|page| page.map({_reader(writer)}))" if dtos else ""
            return [
                f"/// A page of {info['name']}, by primary key.",
                *_fn(
                    f"{name}(&self, offset: u64, limit: u64) -> Result<Page<{result}>, DomainError>",
                    [f"{method}(offset, limit).await{mapped}"],
                ),
            ]
        if paging == "cursor":
            uses.add(f"{COMMON}::CursorPage")
            mapped = f".map(|page| page.map({_reader(writer)}))" if dtos else ""
            return [
                f"/// A page of {info['name']} after the key after (None for the first page), by primary key.",
                *_fn(
                    f"{name}(&self, after: Option<{key_type(info)}>, limit: u64) -> Result<CursorPage<{result}, {key_type(info)}>, DomainError>",
                    [f"{method}(after, limit).await{mapped}"],
                ),
            ]
        mapped = f".map(|rows| rows.into_iter().map({_reader(writer)}).collect())" if dtos else ""
        return [
            f"/// Every {entity}, by primary key.",
            *_fn(f"{name}(&self) -> Result<Vec<{result}>, DomainError>", [f"{method}().await{mapped}"]),
        ]
    if kind == "update":
        update = query(info, "update")
        if not update or not query(info, "getByKey"):
            return []
        if dtos:
            uses.add(update_path(context, info))
        writer["used"].update(("given", "find", "checkValues", "apply"))
        version = info["version"]
        version_param = f", version: {version['rs']}" if version else ""
        return [
            f"/// Changes the given values of a {entity}{', read at version' if version else ''}.",
            *_fn(
                f"{name}(&self, {_key_params(info)}, changes: {update_type(context, info)}{version_param}) -> Result<{_result_type(writer)}, DomainError>",
                [
                    "let values = given(changes);",
                    *_in_transaction(
                        writer,
                        [
                            f"let mut current = find(uow, {_key_args(info)}).await?;",
                            *_version_check(writer),
                            "check_values(uow, &values, Some(&current)).await?;",
                            "apply_values(&mut current, &values);",
                            *([f"current.{version['field']} = Some(version + 1);"] if version else []),
                            f"let updated = {_repo(info)}.{query_name(context, update)}(current).await?;",
                        ],
                        f"Ok({_out(writer, 'updated')})",
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
        version_param = f", version: {version['rs']}" if version else ""
        if soft:
            mark = "true" if soft["column"]["type"]["kind"] == "boolean" else (now_of(soft) or "Default::default()")
            action = [
                f"current.{soft['field']} = Some({mark});",
                f"{_repo(info)}.{query_name(context, update)}(current).await?;",
            ]
        else:
            action = [f"{_repo(info)}.{query_name(context, remove)}(&current).await?;"]
        return [
            f"/// Marks a {entity} as deleted ({soft['column']['name']}); reads leave it out from then on."
            if soft
            else f"/// Deletes a {entity}.",
            *_fn(
                f"{name}(&self, {_key_params(info)}{version_param}) -> Result<(), DomainError>",
                _in_transaction(
                    writer,
                    [
                        f"let {'mut ' if soft else ''}current = find(uow, {_key_args(info)}).await?;",
                        *_version_check(writer),
                        *_children_lines(writer),
                        *action,
                    ],
                    "Ok(())",
                ),
            ),
        ]
    if kind in ("find", "listByParent"):
        read = query(info, "findByUnique" if kind == "find" else "listByParent", operation["columns"])
        if not read:
            return []
        columns = [column_of(info, column) for column in operation["columns"]]
        params = ", ".join(f"{column['field']}: {column['rs']}" for column in columns)
        rows = f"self.unit_of_work.{info['attr']}().{query_name(context, read)}({', '.join(column['field'] for column in columns)}).await"
        mapper = _reader(writer) if dtos else ""
        joined = " and ".join(operation["columns"])
        if kind == "find":
            return [
                f"/// The {entity} with this {joined}, or None.",
                *_fn(
                    f"{name}(&self, {params}) -> Result<Option<{_result_type(writer)}>, DomainError>",
                    [f"{rows}.map(|row| row.map({mapper}))" if dtos else rows],
                ),
            ]
        return [
            f"/// The {info['name']} with this {joined}.",
            *_fn(
                f"{name}(&self, {params}) -> Result<Vec<{_result_type(writer)}>, DomainError>",
                [f"{rows}.map(|rows| rows.into_iter().map({mapper}).collect())" if dtos else rows],
            ),
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
    params = [{"name": items["item"], "type": items["rs"]}] if adds else items["params"]
    given = params[0]["name"]
    version = info["version"]
    read_at = ", read at version" if version else ""
    held = f"current.{items['column']['field']}.as_deref().unwrap_or_default()"
    if items["by"] == "id":
        present = f"{held}.iter().any(|item| item.id.as_ref() == Some(&{given}))"
    elif items["by"] == "value":
        present = f"{held}.contains(&{given})"
    else:
        present = f"{given} < {held}.len()"
    position = not adds and items["by"] == "position"
    checked = adds and items["nested"] and items["type"]["kind"] == "json"
    if checked:
        writer["checkedLists"].add(kept)
        writer["uses"].add(f"{ERRORS}::FieldError")
    entity = rs_string(info["entity"])
    if position:
        key = rs_string(items["column"]["key"])
        gone = f'DomainError::conflict({entity}, "was changed by someone else since it was read", &[{key}])'
    else:
        gone = f"DomainError::not_found({entity}, {_key_value(info)})"
    keys = ", ".join(_pass(column) for column in info["key"])
    args = ", ".join([keys, *(item["name"] for item in params), *(["size"] if position else [])])
    by = "identifier" if items["by"] == "id" else items["by"]
    item_name = rs_string(type_name(re.sub(r"^r#", "", items["item"])))
    signature = ", ".join(f"{item['name']}: {item['type']}" for item in params)
    version_param = f", version: {version['rs']}" if version else ""
    body = [
        f"{'' if adds and not version else 'let current = '}find(uow, {keys}).await?;",
        *_version_check(writer),
    ]
    if not adds:
        body += [f"if !({present}) {{", f"    return Err(DomainError::not_found({item_name}, {given}));", "}"]
    if position:
        body.append(f"let size = {held}.len();")
    body.append(f"let changed = {_repo(info)}.{query_name(context, change)}({args}).await?.ok_or_else(|| {gone})?;")
    lines = []
    if checked:
        lines += [
            "let mut errors: Vec<FieldError> = Vec::new();",
            check_call(items["nested"], items["item"], kept),
            "if !errors.is_empty() {",
            f"    return Err(DomainError::ValidationFailed {{ entity: {entity}.to_string(), errors }});",
            "}",
        ]
    lines += _in_transaction(writer, body, f"Ok({_out(writer, 'changed')})")
    result = _result_type(writer)
    return [
        f"/// Adds an item to {kept}{read_at}." if adds else f"/// Removes an item from {kept}, by its {by}{read_at}.",
        f"pub async fn {name}(&self, {_key_params(info)}, {signature}{version_param}) -> Result<{result}, DomainError> {{",
        *_ind(lines),
        "}",
    ]


def _link_lines(writer: dict, operation: dict, name: str) -> list[str]:
    context, info, uses = writer["context"], writer["info"], writer["uses"]
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
    params = ", ".join(f"{column['field']}: {column['rs']}" for column in every)
    join_key = ", ".join(_pass(column) for column in join["key"])
    found = f"{_repo(join)}.{query_name(context, read)}({join_key}).await?"

    def tuple_of(columns: list[dict]) -> str:
        return _pass(columns[0]) if len(columns) == 1 else f"({', '.join(_pass(column) for column in columns)})"

    writer["used"].add("find")
    if operation["kind"] == "link":
        insert = query(join, "insert")
        far_read = query(far_info, "getByKey")
        if not insert or not far_read:
            return []
        uses.add(path_in(module_of(context, join, "entity"), join["entity"]))
        values = ", ".join(f"{column['field']}: Some({column['field']})" for column in every)
        whole = len(every) == len(join["columns"]) and not context["orm"].get("documents")
        rest = "" if whole else ", ..Default::default()"
        fields = ", ".join(rs_string(column["key"]) for column in far_cols)
        return [
            f"/// Links a {info['entity']} and a {far_info['entity']} ({join['name']}).",
            f"pub async fn {name}(&self, {params}) -> Result<(), DomainError> {{",
            *_ind(
                _in_transaction(
                    writer,
                    [
                        f"find(uow, {', '.join(_pass(column) for column in own_cols)}).await?;",
                        f"if {_repo(far_info)}.{query_name(context, far_read)}({', '.join(_pass(column) for column in far_cols)}).await?.is_none() {{",
                        f"    return Err(DomainError::not_found({rs_string(far_info['entity'])}, {tuple_of(far_cols)}));",
                        "}",
                        f"if {found}.is_some() {{",
                        f"    return Err(DomainError::conflict({rs_string(info['entity'])}, {rs_string('is already linked to this ' + far_info['entity'])}, &[{fields}]));",
                        "}",
                        f"{_repo(join)}.{query_name(context, insert)}({join['entity']} {{ {values}{rest} }}).await?;",
                    ],
                    "Ok(())",
                )
            ),
            "}",
        ]
    remove = query(join, "delete")
    if not remove:
        return []
    return [
        f"/// Removes the link between a {info['entity']} and a {far_info['entity']} ({join['name']}).",
        f"pub async fn {name}(&self, {params}) -> Result<(), DomainError> {{",
        *_ind(
            _in_transaction(
                writer,
                [
                    f"let link = {found}.ok_or_else(|| DomainError::not_found({rs_string(join['entity'])}, {tuple_of(join['key'])}))?;",
                    f"{_repo(join)}.{query_name(context, remove)}(&link).await?;",
                ],
                "Ok(())",
            )
        ),
        "}",
    ]


TRANSACTIONS = {
    "operation": "Each write runs in a transaction of its own.",
    "caller": "It never commits: the caller owns the transaction.",
    "repository": "Repositories commit every write.",
}


def service_file(context: dict, info: dict) -> dict | None:
    if not info["service"]:
        return None
    module = module_of(context, info, "service")
    uses = RsUses().add("std::sync::Arc", UNIT_OF_WORK, DOMAIN_ERROR)
    dtos = context["settings"]["serviceTypes"] == "dtos"
    writer = {"context": context, "info": info, "uses": uses, "dtos": dtos, "used": set(), "checkedLists": set()}
    operations = [block for block in (_operation_lines(writer, operation) for operation in info["operations"]) if block]
    if operations:
        uses.add(path_in(module_of(context, info, "entity"), info["entity"]))
    used = writer["used"]
    if dtos and "read" in used:
        uses.add(path_in(module_of(context, info, "dtos"), read_dto(info)))
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
    # The changes of an update, when services take entities
    changes = update_struct(context, info) if info["role"] == "entity" and not dtos else []
    return rs_file(
        file_of(module),
        uses.write(),
        [
            *([*changes, ""] if changes else []),
            f"/// Operations on {info['name']}. {TRANSACTIONS[context['settings']['transactions']]}",
            f"pub struct {service_type(info)} {{",
            "    unit_of_work: Arc<dyn UnitOfWork>,",
            "}",
            "",
            f"impl {service_type(info)} {{",
            *(
                [
                    f"    // TODO: {', '.join(hidden_names)} {'is' if one else 'are'} returned with the entity; use DTOs to leave {'it' if one else 'them'} out"
                ]
                if hidden
                else []
            ),
            "    pub fn new(unit_of_work: Arc<dyn UnitOfWork>) -> Self {",
            "        Self { unit_of_work }",
            "    }",
            *(line for block in operations for line in ["", *_ind(block)]),
            "}",
            *(line for block in helpers for line in ["", *block]),
        ],
        [f'The service of the "{info["name"]}" table.'],
    )
