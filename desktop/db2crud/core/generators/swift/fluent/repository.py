"""* The Fluent repositories: queries on the table's model, on the database of the unit of work, models turned into entities, a
database refusal turned into a conflict, what the database fills read back after an insert. Mirrors
web/src/core/generators/swift/fluent/repository.ts."""

from ....schema.ddl import type_sql
from ..context import column_of, is_in, stored
from ..repositories import key_value
from ..swift import sw_string
from .entities import mapped_key, model_path, model_value


def pg_enum(context: dict, column: dict) -> str | None:
    """The enum of PostgreSQL a column holds: its values go in cast to it, as PostgreSQL takes no text for it."""
    type_ = column["column"]["type"]
    if type_["kind"] != "enum" or context["settings"]["database"] != "postgresql":
        return None
    item = next((candidate for candidate in context["schema"]["enums"] if candidate["name"] == type_["name"]), None)
    return item["name"] if (item or {}).get("storage") == "native" else None


def _is_mysql(context: dict) -> bool:
    return context["settings"]["database"] in ("mysql", "mariadb")


def _is_maria_uuid(context: dict, column: dict) -> bool:
    """A column of MariaDB's own uuid type, which Fluent reads and writes as 16 bytes."""
    column_type = column["column"]["type"]
    return (
        column_type["kind"] == "uuid"
        and context["settings"]["database"] == "mariadb"
        and context["schema"].get("dialect") == "mariadb"
        and column_type["sql"].lower() == "uuid"
    )


def _read_cast(context: dict, column: dict) -> str | None:
    """The type a column is cast to when it is read, when Fluent cannot read its own."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    if context["settings"]["database"] == "postgresql":
        if kind in ("json", "array", "unknown"):
            return "text"
        return "time" if kind == "time" and column_type.get("timezone") else None
    if not _is_mysql(context):
        return None
    if kind == "json" or column["sw"] == "TimeOfDay":
        return "CHAR"
    return "BINARY(16)" if _is_maria_uuid(context, column) else None


def _write_cast(context: dict, column: dict) -> str | None:
    """The type a value is cast to when it goes to the database, when it would not take it as it is."""
    column_type = column["column"]["type"]
    kind = column_type["kind"]
    name = pg_enum(context, column)
    if name:
        return f'"{name}"'
    if context["settings"]["database"] == "postgresql":
        if kind in ("json", "array", "unknown") or (kind == "time" and column_type.get("timezone")):
            return type_sql(context["schema"], "postgresql", column_type)
        return None
    return "UUID" if _is_maria_uuid(context, column) else None


def _is_date(context: dict, column: dict) -> bool:
    return context["settings"]["database"] != "sqlite" and column["column"]["type"]["kind"] == "date"


def uses_sql(context: dict, info: dict) -> bool:
    """Whether the repository of a table writes SQL of its own."""
    return any(
        _read_cast(context, column) is not None or _write_cast(context, column) is not None or _is_date(context, column)
        for column in info["columns"]
    )


def _cast(context: dict, value: str, type_: str) -> str:
    """A bound value cast to a type."""
    if context["settings"]["database"] == "postgresql":
        return f"\\(bind: {value})::\\(unsafeRaw: {sw_string(type_)})"
    return f"CAST(\\(bind: {value}) AS {type_})"


def _bound(context: dict, column: dict, value: str) -> str:
    """A value as it goes into a row: bound, or cast to the type of the column."""
    type_ = _write_cast(context, column)
    return f'.custom(SQLQueryString("{_cast(context, value, type_)}"))' if type_ else f".bind({value})"


def _compare(context: dict, info: dict, column: dict, value: str, operator: str = "==") -> str:
    """The filter that compares a column with a value."""
    # A date would be compared with the date and time Fluent sends
    if _is_date(context, column):
        type_ = "DATE"
    else:
        type_ = None if pg_enum(context, column) else _write_cast(context, column)
    if not type_:
        return f".filter({model_path(info, column)} {operator} {value})"
    sign = "=" if operator == "==" else operator
    sql = f"\\(ident: {sw_string(column['column']['name'])}) {sign} {_cast(context, value, type_)}"
    return f'.filter(.custom(SQLQueryString("{sql}")))'


def _soft_filter(info: dict) -> str:
    """The filter that leaves out rows marked as deleted."""
    if not info["soft"]:
        return ""
    path = model_path(info, info["soft"])
    if info["soft"]["column"]["type"]["kind"] != "boolean":
        return f".filter({path} == nil)"
    return f".group(.or) {{ $0.filter({path} == false).filter({path} == nil) }}"


def _insert_columns(info: dict):
    """The columns written by an insert: not those the database fills (uuids are made first)."""
    return [
        column
        for column in info["columns"]
        if column["column"].get("generated") is None or column["column"].get("generated") == "uuid"
    ]


def _update_columns(info: dict):
    """The columns written by an update: not the key, nor those the database fills."""
    return [
        column
        for column in info["columns"]
        if column["column"].get("generated") is None and not is_in(column, info["key"])
    ]


def _key_filter(context: dict, info: dict, value):
    """The filters of a row, by its key as a source has it: entity.id! or model.id!."""
    return "".join(_compare(context, info, column, value(column)) for column in mapped_key(info))


def _sort_by_key(info: dict):
    """The order of the key, by column name: a key path cannot go through a composite key."""
    return "".join(f".sort({sw_string(column['column']['name'])})" for column in info["key"])


def _set_lines(context: dict, columns: list[dict]) -> list[str]:
    """The lines of an update that set the columns: first those cast to their type, as setting several at once replaces
    what was set."""
    casts = [column for column in columns if _write_cast(context, column)]
    if not casts:
        return []
    result = ["var values: [FieldKey: DatabaseQuery.Value] = [:]"]
    for column in casts:
        key = sw_string(column["column"]["name"])
        if column["column"]["nullable"]:
            result.append(f"values[{key}] = entity.{column['prop']}.map {{ {_bound(context, column, '$0')} }} ?? .null")
        else:
            result.append(
                f"if let value = entity.{column['prop']} {{ values[{key}] = {_bound(context, column, 'value')} }}"
            )
    return [*result, "query.set(values)"]


def _set_line(info: dict, column: dict) -> str:
    """The line of an update that sets a column."""
    return (
        f"query.set({model_path(info, column)}, to: entity.{column['prop']})"
        if column["column"]["nullable"]
        else f"if let value = entity.{column['prop']} {{ query.set({model_path(info, column)}, to: value) }}"
    )


def fluent_body(context: dict, info: dict, method: dict) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_filter(info)
    query = f"{info['model']}.query(on: database)"
    # What is read of a row, with the columns Fluent cannot read cast by the database
    reads_cast = any(_read_cast(context, column) for column in info["columns"])
    read = f"{query}.selecting({info['model']}.selected)" if reads_cast else query
    by_columns = "".join(_compare(context, info, column, column["prop"]) for column in columns)
    if method["query"]["kind"] in ("getByKey", "findByUnique"):
        return [f"try await {read}{by_columns}{soft}.first().map(toEntity)"]
    if method["query"]["kind"] in ("listByParent", "findAllBy"):
        return [f"try await {read}{by_columns}{soft}{_sort_by_key(info)}.all().map(toEntity)"]
    if method["query"]["kind"] == "list":
        if context["settings"]["paging"] == "offset":
            return [
                f"let total = try await {query}{soft}.count()",
                f"let rows = try await {read}{soft}{_sort_by_key(info)}.offset(offset).limit(limit).all()",
                "return Page(items: rows.map(toEntity), total: total, offset: offset, limit: limit)",
            ]
        if context["settings"]["paging"] == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            def value(column: dict):
                return "after" if len(info["key"]) == 1 else f"after.{column['key']}"

            terms = []
            for index, column in enumerate(info["key"]):
                before = [_compare(context, info, other, value(other)) for other in info["key"][:index]]
                greater = _compare(context, info, column, value(column), ">")
                terms.append(
                    f"or{greater}" if index == 0 else f"or.group(.and) {{ and in and{''.join(before)}{greater} }}"
                )
            return [
                f"let query = {read}{soft}",
                "if let after {",
                *(
                    [f"    query{_compare(context, info, info['key'][0], 'after', '>')}"]
                    if len(info["key"]) == 1
                    else ["    query.group(.or) { or in", *(f"        {term}" for term in terms), "    }"]
                ),
                "}",
                f"let rows = try await query{_sort_by_key(info)}.limit(limit + 1).all()",
                "let items = rows.prefix(limit).map(toEntity)",
                f"return CursorPage(items: items, next: rows.count > limit ? items.last.map {{ {key_value(info, '$0')} }} : nil)",
            ]
        return [f"try await {read}{soft}{_sort_by_key(info)}.all().map(toEntity)"]
    if method["query"]["kind"] == "insert":
        key = mapped_key(info)
        identity = key[0] if len(key) == 1 and key[0]["column"].get("generated") == "identity" else None
        uuids = [column for column in _insert_columns(info) if column["column"].get("generated") == "uuid"]
        values = [
            (
                f"values[{sw_string(column['column']['name'])}] = .bind({column['prop']})"
                if column["column"].get("generated") == "uuid"
                else f"if let value = entity.{column['prop']} {{ values[{sw_string(column['column']['name'])}] = {_bound(context, column, 'value')} }}"
            )
            for column in _insert_columns(info)
        ]

        # The row is read back by the key it now has: the one the database numbered, the one made here, or the one given
        def key_of(column: dict):
            return (
                "numbered!"
                if column == identity
                else (column["prop"] if column in uuids else f"entity.{column['prop']}!")
            )

        return [
            *(f"let {column['prop']} = entity.{column['prop']} ?? UUID()" for column in uuids),
            f"{('var' if len(values) > 0 else 'let')} values: [FieldKey: DatabaseQuery.Value] = [:]",
            *values,
            f"let insert = {query}.set(values)",
            "insert.query.action = .create",
            *(
                [
                    f"nonisolated(unsafe) var numbered: {identity['sw']}?",
                    f"try await write {{ try await insert.run {{ numbered = try? $0.decode({sw_string(identity['column']['name'])}, as: {identity['sw']}.self) }} }}",
                ]
                if identity
                else ["try await write { try await insert.run() }"]
            ),
            f"let stored = try await {read}{_key_filter(context, info, key_of)}.first()",
            "return stored.map(toEntity) ?? entity",
        ]
    if method["query"]["kind"] == "update":
        changing = _update_columns(info)
        if len(changing) == 0:
            return ["// Nothing of it can change", "return entity"]
        return [
            (
                f"let query = {query}"
                + _key_filter(context, info, lambda column: stored(f"entity.{column['prop']}", column))
            ),
            *_set_lines(context, changing),
            *(_set_line(info, column) for column in changing if not _write_cast(context, column)),
            "try await write { try await query.update() }",
            "return entity",
        ]
    if method["query"]["kind"] == "delete":
        return [
            (
                f"try await write {{ try await {query}"
                + _key_filter(context, info, lambda column: stored(f"entity.{column['prop']}", column))
                + ".delete() }"
            )
        ]
    return ['fatalError("not written")']


def _selected_columns(context: dict, info: dict) -> list[str]:
    """The columns a read selects, when the database casts some of them."""
    if not any(_read_cast(context, column) for column in info["columns"]):
        return []
    schema = info["table"].get("schema")
    table = [*([schema] if schema else []), info["table"]["name"]]
    fields = []
    for column in info["columns"]:
        name = column["column"]["name"]
        type_ = _read_cast(context, column)
        if not type_:
            fields.append(f"            .extendedPath([{sw_string(name)}], schema: schema, space: space),")
            continue
        path = ".".join(f"\\(ident: {sw_string(part)})" for part in [*table, name])
        alias = sw_string("_".join([*table, name]))
        fields.append(f'            .custom(SQLQueryString("CAST({path} AS {type_}) AS \\(ident: {alias})")),')
    return [
        f"extension {info['model']} {{",
        "    /// The columns of a row, those Fluent cannot read cast by the database.",
        "    fileprivate static var selected: [DatabaseQuery.Field] {",
        "        [",
        *fields,
        "        ]",
        "    }",
        "}",
        "",
        "extension QueryBuilder {",
        "    fileprivate func selecting(_ fields: [DatabaseQuery.Field]) -> Self {",
        "        query.fields = fields",
        "        return self",
        "    }",
        "}",
        "",
    ]


def to_entity_function(context: dict, info: dict) -> list[str]:
    """toEntity: how a model becomes an entity."""
    return [
        *_selected_columns(context, info),
        f"fileprivate func toEntity(_ model: {info['model']}) -> {info['entity']} {{",
        (
            f"    {info['entity']}("
            + ", ".join(f"{column['key']}: {model_value(info, column)}" for column in info["columns"])
            + ")"
        ),
        "}",
    ]
