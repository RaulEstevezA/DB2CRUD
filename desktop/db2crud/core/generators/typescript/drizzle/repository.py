"""The Drizzle repositories, over a database or a transaction: rows become the project's plain entities (Drizzle's rows
already have their types), reads leave out rows marked as deleted, pages go by offset or after a key, new rows are read
back (with returning(), or by their key on MySQL), and a database refusal becomes a ConflictError. Mirrors
web/src/core/generators/typescript/drizzle/repository.ts."""

from ..common.context import is_in, query
from ..typescript import TsImports
from .schema import dialect_of, native_enum, schema_module, table_var


def _writable(column: dict) -> bool:
    """A computed column is never written."""
    return not isinstance(column["column"].get("generated"), dict)


def _changeable(info: dict, column: dict) -> bool:
    """Nor the key of a stored row, nor what the database fills."""
    # A column the database sets on every change (ON UPDATE) is left for it, or the ORM, to set
    return (
        _writable(column)
        and not is_in(column, info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    )


def _multiline(opening: str, items: list[str], closing: str) -> list:
    return [opening, *(f"    {item}," for item in items), closing]


def _value(context: dict, info: dict, column: dict) -> str:
    """name: entity.name, with the type Drizzle asks for when the column is an enum of the database."""
    cast = ""
    if native_enum(context, column["column"]["type"]):
        cast = f" as (typeof {table_var(info)}.$inferInsert)['{column['prop']}']"
    return f"{column['prop']}: entity.{column['prop']}{cast}"


def drizzle_helpers(context: dict, info: dict, imports: TsImports) -> list:
    """toEntity, insertValues and updateValues of a table."""
    table = table_var(info)
    entity = info["entity"]
    imports.from_(schema_module(context), table)
    result: list = [
        f"/** The {entity} of a row Drizzle read. */",
        f"function toEntity(row: typeof {table}.$inferSelect): {entity} {{",
        f"  return Object.assign(new {entity}(), row)",
        "}",
    ]
    if query(info, "insert"):
        result += [
            "",
            "/** The values of a new row; those left undefined take the database's default. */",
            f"function insertValues(entity: {entity}): typeof {table}.$inferInsert {{",
            *_multiline(
                "  return {", [_value(context, info, column) for column in info["columns"] if _writable(column)], "  }"
            ),
            "}",
        ]
    changes = [column for column in info["columns"] if _changeable(info, column)]
    if query(info, "update") and changes:
        result += [
            "",
            "/** The values a change writes: not the key, nor what the database fills. */",
            f"function updateValues(entity: {entity}): Partial<typeof {table}.$inferInsert> {{",
            *_multiline("  return {", [_value(context, info, column) for column in changes], "  }"),
            "}",
        ]
    return result


# Bodies


def _soft_condition(info: dict, imports: TsImports) -> str | None:
    """The condition that leaves out rows marked as deleted."""
    soft = info["soft"]
    if not soft:
        return None
    column = f"{table_var(info)}.{soft['prop']}"
    if soft["column"]["type"]["kind"] == "boolean":
        imports.from_("drizzle-orm", "eq")
        return f"eq({column}, false)"
    imports.from_("drizzle-orm", "isNull")
    return f"isNull({column})"


def _both(conditions: list, imports: TsImports) -> str | None:
    present = [item for item in conditions if item is not None]
    if not present:
        return None
    if len(present) == 1:
        return present[0]
    imports.from_("drizzle-orm", "and")
    return f"and({', '.join(present)})"


def _equal(info: dict, column: dict, value: str, imports: TsImports) -> str:
    imports.from_("drizzle-orm", "eq")
    return f"eq({table_var(info)}.{column['prop']}, {value})"


def _key_of(info: dict, imports: TsImports, target: str = "entity") -> str:
    return _both([_equal(info, column, f"{target}.{column['prop']}", imports) for column in info["key"]], imports)


def _order_by(info: dict, imports: TsImports) -> str:
    imports.from_("drizzle-orm", "asc")
    columns = ", ".join("asc(" + table_var(info) + "." + column["prop"] + ")" for column in info["key"])
    return f".orderBy({columns})"


def _where_of(condition: str | None) -> str:
    return f".where({condition})" if condition else ""


def _write(info: dict, action: list[str], imports: TsImports) -> list:
    """A write, with a database refusal (a unique value, a row still pointed to) turned into a ConflictError."""
    imports.from_("src/database", "isRefusal").from_("src/errors", "ConflictError")
    return [
        "try {",
        *(f"  {line}" for line in action),
        "} catch (error) {",
        f"  if (isRefusal(error)) throw new ConflictError('{info['entity']}', `the database refused the change: ${{(error as Error).message}}`)",
        "  throw error",
        "}",
    ]


def drizzle_body(context: dict, info: dict, method: dict, imports: TsImports) -> list:
    table = table_var(info)
    select = f"this.db.select().from({table})"
    by_params = []
    for name in method["query"]["columns"]:
        column = next(item for item in info["columns"] if item["column"]["name"] == name)
        by_params.append(_equal(info, column, column["prop"], imports))
    kind = method["query"]["kind"]
    reads = kind in ("getByKey", "findByUnique", "listByParent", "findAllBy", "list")
    soft = _soft_condition(info, imports) if reads else None
    if kind in ("getByKey", "findByUnique"):
        return [
            f"const [row] = await {select}{_where_of(_both([*by_params, soft], imports))}.limit(1)",
            "return row === undefined ? null : toEntity(row)",
        ]
    if kind in ("listByParent", "findAllBy"):
        where = _where_of(_both([*by_params, soft], imports))
        return [f"return (await {select}{where}{_order_by(info, imports)}).map(toEntity)"]
    if kind == "list":
        where = _where_of(_both([soft], imports))
        paging = context["settings"]["paging"]
        if paging == "offset":
            imports.from_("drizzle-orm", "count")
            return [
                f"const rows = await {select}{where}{_order_by(info, imports)}.limit(limit).offset(offset)",
                f"const [{{ total }}] = await this.db.select({{ total: count() }}).from({table}){where}",
                "return { items: rows.map(toEntity), total, offset, limit }",
            ]
        if paging == "cursor":
            imports.from_("drizzle-orm", "gt", "and").type("drizzle-orm", "SQL")
            # After the key (a, b): a greater, or a the same and b greater
            key = info["key"]

            def at(index: int) -> str:
                return f"after[{index}] as {key[index]['ts']}"

            options = []
            for index, column in enumerate(key):
                parts = [
                    *(_equal(info, before, at(position), imports) for position, before in enumerate(key[:index])),
                    f"gt({table}.{column['prop']}, {at(index)})",
                ]
                options.append(parts[0] if len(parts) == 1 else f"and({', '.join(parts)})")
            if len(options) > 1:
                imports.from_("drizzle-orm", "or")
            after = options[0] if len(options) == 1 else f"or({', '.join(options)})"
            last = ", ".join(f"last.{column['prop']}" for column in key)
            return [
                f"const conditions: (SQL | undefined)[] = [{soft or ''}]",
                f"if (after !== null) conditions.push({after})",
                f"const rows = (await {select}.where(and(...conditions)){_order_by(info, imports)}.limit(limit + 1)).map(toEntity)",
                "const items = rows.slice(0, limit)",
                "const last = items[items.length - 1]",
                f"return {{ items, next: rows.length > limit ? [{last}] : null }}",
            ]
        return [f"return (await {select}{where}{_order_by(info, imports)}).map(toEntity)"]
    if kind == "insert":
        if dialect_of(context) != "mysql":
            # The values the database filled (the key, defaults) are read back into the entity
            return _write(
                info,
                [
                    f"const [row] = await this.db.insert({table}).values(insertValues(entity)).returning()",
                    "return Object.assign(entity, toEntity(row))",
                ],
                imports,
            )
        # MySQL returns only the new key: the row is read back by it
        identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
        if identity:
            action = [
                f"const [ids] = await this.db.insert({table}).values(insertValues(entity)).$returningId()",
                "Object.assign(entity, ids)",
            ]
        else:
            action = [f"await this.db.insert({table}).values(insertValues(entity))"]
        return [
            *_write(info, action, imports),
            f"const [row] = await {select}.where({_key_of(info, imports)}).limit(1)",
            "return row === undefined ? entity : Object.assign(entity, toEntity(row))",
        ]
    if kind == "update":
        if not any(_changeable(info, column) for column in info["columns"]):
            return ["// Nothing of the row can change but its key", "return entity"]
        action = f"await this.db.update({table}).set(updateValues(entity)).where({_key_of(info, imports)})"
        return [*_write(info, [action], imports), "return entity"]
    if kind == "delete":
        return _write(info, [f"await this.db.delete({table}).where({_key_of(info, imports)})"], imports)
    return ["throw new Error('not written')"]
