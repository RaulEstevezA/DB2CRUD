"""The service of each table: its operations and what each one checks before it writes. Mirrors
web/src/core/generators/python/sqlalchemy/services.ts."""

from ....js import number_text
from ...types import indent, lines
from ..python import Imports, js_json, snake_name
from .context import (
    aw,
    column_py_type,
    def_,
    find_info,
    is_in,
    module_of,
    operation_name,
    path_of,
    query,
    query_name,
    service_class,
)
from .dtos import create_columns, create_dto, read_columns, read_dto, update_dto


class _Writer:
    def __init__(self, context: dict, info: dict, imports: Imports, dtos: bool) -> None:
        self.context = context
        self.info = info
        self.imports = imports
        self.dtos = dtos
        self.a = aw(context)
        self.def_ = def_(context)


def _call(writer: _Writer, expression: str) -> str:
    return f"{writer.a}{expression}"


def _in_transaction(writer: _Writer, body: list) -> list:
    """with self._uow.transaction(): around the body, when operations own their transaction."""
    if writer.context["settings"]["transactions"] != "operation":
        return body
    keyword = "async with" if writer.context["async"] else "with"
    return [f"{keyword} self._uow.transaction():", indent(lines(*body))]


def _repo(info: dict) -> str:
    return f"self._uow.{info['attr']}"


def _key_params(writer: _Writer) -> str:
    return ", ".join(
        f"{column['attr']}: {column_py_type(column, writer.imports, False)}" for column in writer.info["key"]
    )


def _key_args(info: dict) -> str:
    return ", ".join(column["attr"] for column in info["key"])


def _key_value(info: dict) -> str:
    return info["key"][0]["attr"] if len(info["key"]) == 1 else f"({_key_args(info)})"


def _attr(info: dict, name: str) -> str:
    return next(column for column in info["columns"] if column["column"]["name"] == name)["attr"]


def _column(info: dict, name: str) -> dict:
    return next(column for column in info["columns"] if column["column"]["name"] == name)


# Checks


def _value_rules(column: dict, checks: list[dict]) -> list[str]:
    """The rules a value must follow, from the column's type and the CHECK constraints the rules understand."""
    rules = []
    name = column["column"]["name"]
    column_type = column["column"]["type"]
    if column_type["kind"] == "text" and "length" in column_type:
        length = column_type["length"]
        rules.append(
            f"if isinstance(value, str) and len(value) > {length}:\n"
            f'    errors.append(FieldError("{name}", "is longer than {length} characters"))'
        )
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != name:
            continue
        if parsed["kind"] == "in":
            values = ", ".join(js_json(item) for item in parsed["values"])
            text = ", ".join(item if isinstance(item, str) else number_text(item) for item in parsed["values"])
            rules.append(
                f'if value not in ({values},):\n    errors.append(FieldError("{name}", "must be one of: {text}"))'
            )
        if parsed["kind"] == "compare":
            op, value = parsed["op"], number_text(parsed["value"])
            rules.append(f'if not value {op} {value}:\n    errors.append(FieldError("{name}", "must be {op} {value}"))')
        if parsed["kind"] == "length":
            op, value = parsed["op"], number_text(parsed["value"])
            rules.append(
                f'if not len(value) {op} {value}:\n    errors.append(FieldError("{name}", "must have {op} {value} characters"))'
            )
    return rules


def _validate_method(writer: _Writer) -> list:
    info, imports = writer.info, writer.imports
    imports.from_("app.errors", "FieldError", "ValidationFailedError").from_("typing", "Any")
    blocks = []
    for column in create_columns(info):
        name, attr = column["column"]["name"], column["attr"]
        if column["required"]:
            missing = f'if creating or "{attr}" in values:\n        errors.append(FieldError("{name}", "is required"))'
        elif not column["column"]["nullable"]:
            missing = f'if "{attr}" in values and not creating:\n        errors.append(FieldError("{name}", "cannot be empty"))'
        else:
            missing = "pass"
        rules = _value_rules(column, info["table"]["checks"])
        # A nullable column without rules has nothing to check
        if missing == "pass" and not rules:
            continue
        if missing == "pass":
            blocks.append(
                lines(f'value = values.get("{attr}")', "if value is not None:", *[indent(rule) for rule in rules])
            )
            continue
        blocks.append(
            lines(
                f'value = values.get("{attr}")',
                "if value is None:",
                f"    {missing}",
                bool(rules) and ["else:", *[indent(rule) for rule in rules]],
            )
        )
    # The key, what the database fills, and what the service itself keeps (the version, the soft-delete mark)
    unchangeable = [
        f'"{column["attr"]}"'
        for column in info["columns"]
        if column["generated"] or is_in(column, info["key"]) or column is info["version"] or column is info["soft"]
    ]
    return [
        "def _validate(self, values: dict[str, Any], creating: bool) -> None:",
        f'    """Checks the values against the rules of the "{info["name"]}" table; '
        'raises ValidationFailedError with every problem."""',
        "    errors: list[FieldError] = []",
        "    for name in values.keys() - _FIELDS:",
        f'        errors.append(FieldError(name, "is not a field of {info["entity"]}"))',
        bool(unchangeable)
        and [
            "    if not creating:",
            f"        for name in values.keys() & {{{', '.join(unchangeable)}}}:",
            '            errors.append(FieldError(name, "cannot be changed"))',
        ],
        *[indent(block) for block in blocks],
        *[indent(line) if isinstance(line, str) else line for line in _parent_checks(writer)],
        "    if errors:",
        f'        raise ValidationFailedError("{info["entity"]}", errors)',
    ]


def _parent_checks(writer: _Writer) -> list:
    """The rows each foreign key points to must exist; checked through the parent's repository."""
    context, info = writer.context, writer.info
    checks = []
    for key in info["table"]["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        read = query(parent, "getByKey") if parent else None
        same_key = parent is not None and ",".join(column["column"]["name"] for column in parent["key"]) == ",".join(
            key["references"]["columns"]
        )
        if not parent or not read or not same_key:
            checks.append(
                f"# TODO: {', '.join(key['columns'])} must point to a row of {key['references']['table']}; "
                "that table has no read by key to check it"
            )
            continue
        attrs = [_attr(info, name) for name in key["columns"]]
        for attr in attrs:
            checks.append(
                f'{attr} = values["{attr}"] if "{attr}" in values else '
                f'(getattr(current, "{attr}") if current is not None else None)'
            )
        present = " and ".join(f"{attr} is not None" for attr in attrs)
        lookup = _call(writer, f"{_repo(parent)}.{query_name(context, read)}({', '.join(attrs)})")
        checks.append(f"if {present} and {lookup} is None:")
        checks.append(
            f'    errors.append(FieldError("{", ".join(key["columns"])}", "no {parent["entity"]} has this key"))'
        )
    return checks


def _unique_method(writer: _Writer) -> list:
    context, info, imports = writer.context, writer.info, writer.imports
    checks = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        joined = ", ".join(unique["columns"])
        if not read:
            checks.append(f"# {joined} must be unique: the database refuses repeated values (ConflictError)")
            continue
        imports.from_("app.errors", "ConflictError")
        attrs = [_attr(info, name) for name in unique["columns"]]
        for attr in attrs:
            checks.append(
                f'{attr} = values["{attr}"] if "{attr}" in values else (current.{attr} if current is not None else None)'
            )
        quoted = ", ".join(f'"{attr}"' for attr in attrs)
        present = " and ".join(f"{attr} is not None" for attr in attrs)
        lookup = _call(writer, f"{_repo(info)}.{query_name(context, read)}({', '.join(attrs)})")
        checks += [
            f"if {present}:",
            f"    other = {lookup}",
            # Another row, by its key: ORMs without an identity map (Django) return a new object for the same row
            f"    if other is not None and (current is None or {_same_key(info)}):",
            f'        raise ConflictError("{info["entity"]}", "{joined} is already taken", ({quoted},))',
        ]
    if not checks:
        return []
    return [
        f"{writer.def_} _check_unique(self, values: dict[str, Any], current: {info['entity']} | None) -> None:",
        '    """Values that must be unique are not taken by another row."""',
        *[indent(line) if isinstance(line, str) else line for line in checks],
    ]


def _same_key(info: dict) -> str:
    """True when `other` is another row than `current`, compared by key."""
    if len(info["key"]) == 1:
        return f"other.{info['key'][0]['attr']} != current.{info['key'][0]['attr']}"
    others = ", ".join(f"other.{column['attr']}" for column in info["key"])
    currents = ", ".join(f"current.{column['attr']}" for column in info["key"])
    return f"({others}) != ({currents})"


def _check_method(writer: _Writer) -> list:
    info = writer.info
    return [
        f"{writer.def_} _check(self, values: dict[str, Any], current: {info['entity']} | None) -> None:",
        '    """Every check before a write: the values, the rows they point to, the unique values."""',
        f"    {'await ' if writer.context['async'] else ''}self._validate_all(values, current)",
        bool(info["table"]["uniques"]) and f"    {_call(writer, 'self._check_unique(values, current)')}",
    ]


def _validate_all(writer: _Writer) -> list:
    """_validate with the parent checks needs the repositories, so it is asynchronous when they are."""
    method = _validate_method(writer)
    doc, body = method[1], method[2:]
    return [
        f"{writer.def_} _validate_all(self, values: dict[str, Any], current: {writer.info['entity']} | None) -> None:",
        doc,
        "    creating = current is None",
        *body,
    ]


def _find_method(writer: _Writer) -> list:
    context, info = writer.context, writer.info
    read = query(info, "getByKey")
    if not read:
        return []
    writer.imports.from_("app.errors", "NotFoundError")
    return [
        f"{writer.def_} _find(self, {_key_params(writer)}) -> {info['entity']}:",
        f'    """The {info["entity"]} with this key; NotFoundError when there is none."""',
        f"    entity = {_call(writer, f'{_repo(info)}.{query_name(context, read)}({_key_args(info)})')}",
        "    if entity is None:",
        f'        raise NotFoundError("{info["entity"]}", {_key_value(info)})',
        "    return entity",
    ]


# Conversions


def _read_method(writer: _Writer) -> list:
    if not writer.dtos:
        return []
    info = writer.info
    if writer.context["settings"]["dtoKind"] == "pydantic":
        body = f"    return {read_dto(info)}.model_validate(entity)"
    else:
        fields = ", ".join(f"{column['attr']}=entity.{column['attr']}" for column in read_columns(info))
        body = f"    return {read_dto(info)}({fields})"
    return [
        "@staticmethod",
        f"def _read(entity: {info['entity']}) -> {read_dto(info)}:",
        f'    """The {info["entity"]} as services return it."""',
        body,
    ]


def _dumped(writer: _Writer, variable: str) -> str:
    """The values a DTO carries, leaving out the fields it does not set."""
    if writer.context["settings"]["dtoKind"] == "pydantic":
        return f"{variable}.model_dump(exclude_unset=True)"
    writer.imports.from_("dataclasses", "asdict")
    return f"{{name: value for name, value in asdict({variable}).items() if value is not None}}"


def _out(writer: _Writer, expression: str) -> str:
    return f"self._read({expression})" if writer.dtos else expression


def _result_type(writer: _Writer) -> str:
    return read_dto(writer.info) if writer.dtos else writer.info["entity"]


# Operations


def _version_check(writer: _Writer) -> list:
    version = writer.info["version"]
    if not version:
        return []
    writer.imports.from_("app.errors", "ConflictError")
    return [
        f"if current.{version['attr']} != version:",
        f'    raise ConflictError("{writer.info["entity"]}", "was changed by someone else since it was read", '
        f'("{version["attr"]}",))',
    ]


def _children_lines(writer: _Writer) -> list:
    context, info, imports = writer.context, writer.info, writer.imports
    children = info["children"]
    if not children:
        return []
    result = []
    for link in children["links"]:
        child = find_info(context, link["table"])
        listing = query(child, "listByParent", link["columns"]) if child else None
        if not child or not listing:
            result.append(
                f"# TODO: rows of {link['table']} may point here; that table has no list by "
                f"{', '.join(link['columns'])} to look for them"
            )
            continue
        args = ", ".join(f"current.{_attr(info, name)}" for name in link["references"])
        rows = _call(writer, f"{_repo(child)}.{query_name(context, listing)}({args})")
        if children["policy"] == "block":
            imports.from_("app.errors", "ConflictError")
            result += [
                f"if {rows}:",
                f'    raise ConflictError("{info["entity"]}", "rows of {link["table"]} still point to it", ("{link["table"]}",))',
            ]
        else:
            remove = query(child, "delete")
            if not remove:
                result.append(f"# TODO: rows of {link['table']} must be deleted first, and that table has no delete")
            else:
                result += [
                    f"for row in {rows}:",
                    f"    {_call(writer, f'{_repo(child)}.{query_name(context, remove)}(row)')}",
                ]
    return result


def _operation_lines(writer: _Writer, operation: dict) -> list:
    context, info, imports = writer.context, writer.info, writer.imports
    name = operation_name(context, operation)
    entity = info["entity"]
    method_def = writer.def_
    kind = operation["kind"]
    if kind == "create":
        insert = query(info, "insert")
        if not insert:
            return []
        variable = snake_name(entity)
        param = f"data: {create_dto(info)}" if writer.dtos else f"{variable}: {entity}"
        values = _dumped(writer, "data") if writer.dtos else f"{{name: getattr({variable}, name) for name in _FIELDS}}"
        stored = f"{entity}(**values)" if writer.dtos else variable
        return [
            f"{method_def} {name}(self, {param}) -> {_result_type(writer)}:",
            f'    """Stores a new {entity} after checking it."""',
            f"    values = {values}",
            indent(
                lines(
                    *_in_transaction(
                        writer,
                        [
                            _call(writer, "self._check(values, None)"),
                            f"created = {_call(writer, f'{_repo(info)}.{query_name(context, insert)}({stored})')}",
                            f"return {_out(writer, 'created')}",
                        ],
                    )
                )
            ),
        ]
    if kind == "get":
        if not query(info, "getByKey"):
            return []
        return [
            f"{method_def} {name}(self, {_key_params(writer)}) -> {_result_type(writer)}:",
            f'    """The {entity} with this key; NotFoundError when there is none."""',
            f"    return {_out(writer, _call(writer, f'self._find({_key_args(info)})'))}",
        ]
    if kind == "list":
        listing = query(info, "list")
        if not listing:
            return []
        paging = context["settings"]["paging"]
        method = f"{_repo(info)}.{query_name(context, listing)}"
        result = _result_type(writer)
        if paging == "offset":
            imports.from_("app.paging", "Page")
            return [
                f"{method_def} {name}(self, offset: int = 0, limit: int = 50) -> Page[{result}]:",
                f'    """A page of {info["name"]}, by primary key."""',
                [
                    f"    page = {_call(writer, f'{method}(offset, limit)')}",
                    "    return Page(items=[self._read(entity) for entity in page.items], total=page.total, "
                    "offset=page.offset, limit=page.limit)",
                ]
                if writer.dtos
                else f"    return {_call(writer, f'{method}(offset, limit)')}",
            ]
        if paging == "cursor":
            imports.from_("app.paging", "CursorPage")
            return [
                f"{method_def} {name}(self, after: tuple[Any, ...] | None = None, limit: int = 50) -> CursorPage[{result}]:",
                f'    """A page of {info["name"]} after the key `after`, by primary key."""',
                [
                    f"    page = {_call(writer, f'{method}(after, limit)')}",
                    "    return CursorPage(items=[self._read(entity) for entity in page.items], next=page.next)",
                ]
                if writer.dtos
                else f"    return {_call(writer, f'{method}(after, limit)')}",
            ]
        return [
            f"{method_def} {name}(self) -> list[{result}]:",
            f'    """Every {entity}, by primary key."""',
            f"    return [self._read(entity) for entity in {_call(writer, f'{method}()')}]"
            if writer.dtos
            else f"    return {_call(writer, f'{method}()')}",
        ]
    if kind == "update":
        update = query(info, "update")
        if not update or not query(info, "getByKey"):
            return []
        imports.from_("typing", "Any")
        if not writer.dtos:
            imports.from_("collections.abc", "Mapping")
        param = f"data: {update_dto(info)}" if writer.dtos else "changes: Mapping[str, Any]"
        version = info["version"]
        version_param = f", version: {column_py_type(version, imports, False)}" if version else ""
        return [
            f"{method_def} {name}(self, {_key_params(writer)}, {param}{version_param}) -> {_result_type(writer)}:",
            f'    """Changes the given values of a {entity}{", read at `version`" if version else ""}."""',
            f"    values = {_dumped(writer, 'data') if writer.dtos else 'dict(changes)'}",
            indent(
                lines(
                    *_in_transaction(
                        writer,
                        [
                            f"current = {_call(writer, f'self._find({_key_args(info)})')}",
                            *_version_check(writer),
                            _call(writer, "self._check(values, current)"),
                            "for name, value in values.items():",
                            "    setattr(current, name, value)",
                            bool(version) and f"current.{version['attr']} = version + 1",
                            f"updated = {_call(writer, f'{_repo(info)}.{query_name(context, update)}(current)')}",
                            f"return {_out(writer, 'updated')}",
                        ],
                    )
                )
            ),
        ]
    if kind == "delete":
        remove = query(info, "delete")
        update = query(info, "update")
        soft = info["soft"]
        if not query(info, "getByKey") or (not soft and not remove) or (soft and not update):
            return []
        version = info["version"]
        version_param = f", version: {column_py_type(version, imports, False)}" if version else ""
        if soft:
            value = "True" if soft["column"]["type"]["kind"] == "boolean" else "datetime.now(UTC)"
            if value != "True":
                imports.from_("datetime", "UTC", "datetime")
            action = [
                f"current.{soft['attr']} = {value}",
                _call(writer, f"{_repo(info)}.{query_name(context, update)}(current)"),
            ]
            doc = f'    """Marks a {entity} as deleted ({soft["column"]["name"]}); reads leave it out from then on."""'
        else:
            action = [_call(writer, f"{_repo(info)}.{query_name(context, remove)}(current)")]
            doc = f'    """Deletes a {entity}."""'
        return [
            f"{method_def} {name}(self, {_key_params(writer)}{version_param}) -> None:",
            doc,
            indent(
                lines(
                    *_in_transaction(
                        writer,
                        [
                            f"current = {_call(writer, f'self._find({_key_args(info)})')}",
                            *_version_check(writer),
                            *_children_lines(writer),
                            *action,
                        ],
                    )
                )
            ),
        ]
    if kind in ("find", "listByParent"):
        read = query(info, "findByUnique" if kind == "find" else "listByParent", operation["columns"])
        if not read:
            return []
        columns = [_column(info, name) for name in operation["columns"]]
        params = ", ".join(f"{column['attr']}: {column_py_type(column, imports, False)}" for column in columns)
        args = ", ".join(column["attr"] for column in columns)
        rows = _call(writer, f"{_repo(info)}.{query_name(context, read)}({args})")
        joined = " and ".join(operation["columns"])
        if kind == "find":
            return [
                f"{method_def} {name}(self, {params}) -> {_result_type(writer)} | None:",
                f'    """The {entity} with this {joined}, or None."""',
                [f"    entity = {rows}", "    return self._read(entity) if entity is not None else None"]
                if writer.dtos
                else f"    return {rows}",
            ]
        return [
            f"{method_def} {name}(self, {params}) -> list[{_result_type(writer)}]:",
            f'    """The {info["name"]} with this {joined}."""',
            f"    return [self._read(entity) for entity in {rows}]" if writer.dtos else f"    return {rows}",
        ]
    return _link_lines(writer, operation, name)


def _link_lines(writer: _Writer, operation: dict, name: str) -> list:
    context, info, imports = writer.context, writer.info, writer.imports
    join = find_info(context, operation["through"]) if operation.get("through") else None
    if not join:
        return []
    own = next((key for key in join["table"]["foreignKeys"] if key["references"]["table"] == info["name"]), None)
    far = next((key for key in join["table"]["foreignKeys"] if key is not own), None)
    far_info = find_info(context, far["references"]["table"]) if far else None
    read = query(join, "getByKey")
    if not own or not far or not far_info or not read:
        return []
    own_columns = [_column(join, name) for name in own["columns"]]
    far_columns = [_column(join, name) for name in far["columns"]]
    both = [*own_columns, *far_columns]
    params = ", ".join(f"{column['attr']}: {column_py_type(column, imports, False)}" for column in both)
    join_key = ", ".join(column["attr"] for column in join["key"])
    found = _call(writer, f"{_repo(join)}.{query_name(context, read)}({join_key})")
    imports.from_("app.errors", "NotFoundError").from_(module_of(context, join, "entity"), join["entity"])
    if operation["kind"] == "link":
        insert = query(join, "insert")
        far_read = query(far_info, "getByKey")
        if not insert or not far_read or not query(info, "getByKey"):
            return []
        imports.from_("app.errors", "ConflictError")
        far_args = ", ".join(column["attr"] for column in far_columns)
        far_value = far_args if len(far_columns) == 1 else f"({far_args})"
        quoted = ", ".join(f'"{column["attr"]}"' for column in far_columns)
        values = ", ".join(f"{column['attr']}={column['attr']}" for column in both)
        own_args = ", ".join(column["attr"] for column in own_columns)
        return [
            f"{writer.def_} {name}(self, {params}) -> None:",
            f'    """Links a {info["entity"]} and a {far_info["entity"]} ({join["name"]})."""',
            indent(
                lines(
                    *_in_transaction(
                        writer,
                        [
                            _call(writer, f"self._find({own_args})"),
                            f"if {_call(writer, f'{_repo(far_info)}.{query_name(context, far_read)}({far_args})')} is None:",
                            f'    raise NotFoundError("{far_info["entity"]}", {far_value})',
                            f"if {found} is not None:",
                            f'    raise ConflictError("{info["entity"]}", "is already linked to this {far_info["entity"]}", '
                            f"({quoted},))",
                            _call(writer, f"{_repo(join)}.{query_name(context, insert)}({join['entity']}({values}))"),
                        ],
                    )
                )
            ),
        ]
    remove = query(join, "delete")
    if not remove:
        return []
    return [
        f"{writer.def_} {name}(self, {params}) -> None:",
        f'    """Removes the link between a {info["entity"]} and a {far_info["entity"]} ({join["name"]})."""',
        indent(
            lines(
                *_in_transaction(
                    writer,
                    [
                        f"link = {found}",
                        "if link is None:",
                        f'    raise NotFoundError("{join["entity"]}", ({join_key}))',
                        _call(writer, f"{_repo(join)}.{query_name(context, remove)}(link)"),
                    ],
                )
            )
        ),
    ]


TRANSACTIONS = {
    "operation": "Each write runs in its own transaction.",
    "caller": "It never commits: the caller owns the transaction.",
    "repository": "Repositories commit every write.",
}


def service_file(context: dict, info: dict) -> dict | None:
    if not info["service"]:
        return None
    imports = (
        Imports()
        .from_("app.unit_of_work", "UnitOfWork")
        .from_(module_of(context, info, "entity"), info["entity"])
        .from_("typing", "Any")
    )
    dtos = context["settings"]["serviceTypes"] == "dtos"
    writer = _Writer(context, info, imports, dtos)
    if dtos:
        module = module_of(context, info, "dtos")
        imports.from_(module, read_dto(info))
        if info["role"] == "entity":
            imports.from_(module, create_dto(info), update_dto(info))
    writes = info["role"] == "entity"
    operations = [block for block in (_operation_lines(writer, operation) for operation in info["operations"]) if block]
    helpers = [_find_method(writer), _read_method(writer)]
    if writes:
        helpers = [_validate_all(writer), _unique_method(writer), _check_method(writer), *helpers]
    hidden = info["hidden"]
    fields = [f'"{column["attr"]}"' for column in create_columns(info)] if writes else []
    one = len(hidden) == 1
    content = lines(
        f'"""Operations on {info["name"]}: what each one checks before it writes."""',
        "",
        imports.write("app"),
        writes
        and [
            "",
            "# Columns a client may send: the database fills the others",
            f"_FIELDS = frozenset({{{', '.join(fields)}}})",
        ],
        "",
        "",
        f"class {service_class(info)}:",
        f'    """Operations on {info["name"]}. {TRANSACTIONS[context["settings"]["transactions"]]}"""',
        bool(hidden)
        and not dtos
        and f"    # TODO: {', '.join(hidden)} {'is' if one else 'are'} returned with the entity; "
        f"use DTOs to leave {'it' if one else 'them'} out",
        "",
        "    def __init__(self, uow: UnitOfWork) -> None:",
        "        self._uow = uow",
        *[item for block in [*helpers, *operations] if block for item in ["", indent(lines(*block))]],
        "",
    )
    return {"path": path_of(module_of(context, info, "service")), "content": content}
