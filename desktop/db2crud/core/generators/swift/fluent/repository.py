"""* The Fluent repositories: queries on the table's model, on the database of the unit of work, models turned into entities, a
database refusal turned into a conflict, what the database fills read back after an insert. Mirrors
web/src/core/generators/swift/fluent/repository.ts."""

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


def _bound(context: dict, column: dict, value: str) -> str:
    """A value as it goes into a row: bound, or cast to the enum of PostgreSQL the column holds."""
    name = pg_enum(context, column)
    return (
        (f'.custom(SQLQueryString("\\(bind: {value})::\\(unsafeRaw: ' + sw_string(f'"{name}"') + ')"))')
        if name
        else f".bind({value})"
    )


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


def _key_filter(info: dict, value: dict):
    """The filters of a row, by its key as a source has it: entity.id! or model.id!."""
    return "".join(f".filter({model_path(info, column)} == {value(column)})" for column in mapped_key(info))


def _sort_by_key(info: dict):
    """The order of the key, by column name: a key path cannot go through a composite key."""
    return "".join(f".sort({sw_string(column['column']['name'])})" for column in info["key"])


def _set_line(context: dict, info: dict, column: dict) -> str:
    """The line of an update that sets a column."""
    key = sw_string(column["column"]["name"])
    if pg_enum(context, column):
        return (
            f"query.set([{key}: entity.{column['prop']}.map {{ {_bound(context, column, '$0')} }} ?? .null])"
            if column["column"]["nullable"]
            else f"if let value = entity.{column['prop']} {{ query.set([{key}: {_bound(context, column, 'value')}]) }}"
        )
    return (
        f"query.set({model_path(info, column)}, to: entity.{column['prop']})"
        if column["column"]["nullable"]
        else f"if let value = entity.{column['prop']} {{ query.set({model_path(info, column)}, to: value) }}"
    )


def fluent_body(context: dict, info: dict, method: dict) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_filter(info)
    query = f"{info['model']}.query(on: database)"
    by_columns = "".join(f".filter({model_path(info, column)} == {column['prop']})" for column in columns)
    if method["query"]["kind"] in ("getByKey", "findByUnique"):
        return [f"try await {query}{by_columns}{soft}.first().map(toEntity)"]
    if method["query"]["kind"] in ("listByParent", "findAllBy"):
        return [f"try await {query}{by_columns}{soft}{_sort_by_key(info)}.all().map(toEntity)"]
    if method["query"]["kind"] == "list":
        if context["settings"]["paging"] == "offset":
            return [
                f"let total = try await {query}{soft}.count()",
                f"let rows = try await {query}{soft}{_sort_by_key(info)}.offset(offset).limit(limit).all()",
                "return Page(items: rows.map(toEntity), total: total, offset: offset, limit: limit)",
            ]
        if context["settings"]["paging"] == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            def value(column: dict):
                return "after" if len(info["key"]) == 1 else f"after.{column['key']}"

            terms = []
            for index, column in enumerate(info["key"]):
                before = [f".filter({model_path(info, other)} == {value(other)})" for other in info["key"][:index]]
                greater = f".filter({model_path(info, column)} > {value(column)})"
                terms.append(
                    f"or{greater}" if index == 0 else f"or.group(.and) {{ and in and{''.join(before)}{greater} }}"
                )
            return [
                f"let query = {query}{soft}",
                "if let after {",
                *(
                    [f"    query.filter({model_path(info, info['key'][0])} > after)"]
                    if len(info["key"]) == 1
                    else ["    query.group(.or) { or in", *(f"        {term}" for term in terms), "    }"]
                ),
                "}",
                f"let rows = try await query{_sort_by_key(info)}.limit(limit + 1).all()",
                "let items = rows.prefix(limit).map(toEntity)",
                f"return CursorPage(items: items, next: rows.count > limit ? items.last.map {{ {key_value(info, '$0')} }} : nil)",
            ]
        return [f"try await {query}{soft}{_sort_by_key(info)}.all().map(toEntity)"]
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
            f"let stored = try await {query}{_key_filter(info, key_of)}.first()",
            "return stored.map(toEntity) ?? entity",
        ]
    if method["query"]["kind"] == "update":
        changing = _update_columns(info)
        if len(changing) == 0:
            return ["// Nothing of it can change", "return entity"]
        return [
            (f"let query = {query}" + _key_filter(info, lambda column: stored(f"entity.{column['prop']}", column))),
            *(_set_line(context, info, column) for column in changing),
            "try await write { try await query.update() }",
            "return entity",
        ]
    if method["query"]["kind"] == "delete":
        return [
            (
                f"try await write {{ try await {query}"
                + _key_filter(info, lambda column: stored(f"entity.{column['prop']}", column))
                + ".delete() }"
            )
        ]
    return ['fatalError("not written")']


def to_entity_function(info: dict) -> list[str]:
    """toEntity: how a model becomes an entity."""
    return [
        f"fileprivate func toEntity(_ model: {info['model']}) -> {info['entity']} {{",
        (
            f"    {info['entity']}("
            + ", ".join(f"{column['key']}: {model_value(info, column)}" for column in info["columns"])
            + ")"
        ),
        "}",
    ]
