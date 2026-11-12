"""The Sequelize repositories, over the models of a database and, when there is one, a transaction: instances become
the project's plain entities (whole numbers of 64 bits and decimals arrive as text or numbers depending on the driver,
and are made numbers and text), reads leave out rows marked as deleted, pages go by offset or after a key, new rows
are read back, and a database refusal becomes a ConflictError. Mirrors
web/src/core/generators/typescript/sequelize/repository.ts."""

from ..common.context import column_type, is_in, query
from ..typescript import TsImports


def _writable(column: dict) -> bool:
    return not isinstance(column["column"].get("generated"), dict)


def _changeable(info: dict, column: dict) -> bool:
    # A column the database sets on every change (ON UPDATE) is left for it to set
    return (
        _writable(column)
        and not is_in(column, info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    )


def _multiline(opening: str, items: list[str], closing: str) -> list:
    return [opening, *(f"    {item}," for item in items), closing]


def _read_property(column: dict) -> str:
    """name: value of a property read from a row, as the entity keeps it."""
    value = f"row.{column['prop']}"
    kind_of = column["column"]["type"]
    if kind_of["kind"] == "integer" and kind_of["bits"] == 64:
        converted = f"Number({value})"
    elif kind_of["kind"] == "decimal":
        converted = f"String({value})"
    else:
        return f"{column['prop']}: {value} as {column_type(column)}"
    if column["column"]["nullable"]:
        return f"{column['prop']}: {value} == null ? null : {converted}"
    return f"{column['prop']}: {converted}"


def sequelize_helpers(_context: dict, info: dict, imports: TsImports) -> list:
    """toEntity, insertValues and updateValues of a table."""
    imports.type("sequelize", "Model")
    entity = info["entity"]
    result: list = [
        f"/** The {entity} of an instance Sequelize read. */",
        f"function toEntity(instance: Model): {entity} {{",
        "  const row = instance.get({ plain: true }) as Record<string, unknown>",
        *_multiline(
            f"  return Object.assign(new {entity}(), {{",
            [_read_property(column) for column in info["columns"]],
            "  })",
        ),
        "}",
    ]
    if query(info, "insert"):
        result += [
            "",
            "/** The values of a new row; those left undefined take the database's default. */",
            f"function insertValues(entity: {entity}): Record<string, unknown> {{",
            *_multiline(
                "  const values: Record<string, unknown> = {",
                [f"{column['prop']}: entity.{column['prop']}" for column in info["columns"] if _writable(column)],
                "  }",
            ),
            "  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))",
            "}",
        ]
    changes = [column for column in info["columns"] if _changeable(info, column)]
    if query(info, "update") and changes:
        result += [
            "",
            "/** The values a change writes: not the key, nor what the database fills. */",
            f"function updateValues(entity: {entity}): Record<string, unknown> {{",
            *_multiline("  return {", [f"{column['prop']}: entity.{column['prop']}" for column in changes], "  }"),
            "}",
        ]
    return result


# Bodies


def _soft_condition(info: dict) -> str | None:
    soft = info["soft"]
    if not soft:
        return None
    return f"{soft['prop']}: {'false' if soft['column']['type']['kind'] == 'boolean' else 'null'}"


def _where_of(conditions: list) -> str | None:
    present = [item for item in conditions if item is not None]
    return f"where: {{ {', '.join(present)} }}" if present else None


def _options(items: list) -> str:
    present = [item for item in items if item is not None]
    return f"{{ {', '.join([*present, 'transaction: this.transaction'])} }}"


def _order(info: dict) -> str:
    columns = ", ".join("['" + column["prop"] + "', 'ASC']" for column in info["key"])
    return f"order: [{columns}]"


def _key_where(info: dict) -> str:
    conditions = ", ".join(f"{column['prop']}: entity.{column['prop']}" for column in info["key"])
    return f"where: {{ {conditions} }}"


def _write(info: dict, action: list, imports: TsImports) -> list:
    """A write, with a database refusal (a unique value, a row still pointed to) turned into a ConflictError."""
    imports.from_("sequelize", "DatabaseError", "ValidationError").from_("src/errors", "ConflictError")
    return [
        "try {",
        *((f"  {line}" if isinstance(line, str) else line) for line in action),
        "} catch (error) {",
        "  if (error instanceof DatabaseError || error instanceof ValidationError)",
        f"    throw new ConflictError('{info['entity']}', `the database refused the change: ${{error.message}}`)",
        "  throw error",
        "}",
    ]


def sequelize_body(context: dict, info: dict, method: dict, imports: TsImports) -> list:
    model = f"this.db.models.{info['attr']}"
    by_params = [
        next(item for item in info["columns"] if item["column"]["name"] == name)["prop"]
        for name in method["query"]["columns"]
    ]
    soft = _soft_condition(info)
    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        return [
            f"const row = await {model}.findOne({_options([_where_of([*by_params, soft])])})",
            "return row === null ? null : toEntity(row)",
        ]
    if kind in ("listByParent", "findAllBy"):
        return [
            f"return (await {model}.findAll({_options([_where_of([*by_params, soft]), _order(info)])})).map(toEntity)"
        ]
    if kind == "list":
        where = _where_of([soft])
        paging = context["settings"]["paging"]
        if paging == "offset":
            return [
                f"const {{ rows, count }} = await {model}.findAndCountAll({_options([where, _order(info), 'offset', 'limit'])})",
                "return { items: rows.map(toEntity), total: count, offset, limit }",
            ]
        if paging == "cursor":
            imports.from_("sequelize", "Op").type("sequelize", "WhereOptions")
            # After the key (a, b): a greater, or a the same and b greater
            key = info["key"]
            after = []
            for index, column in enumerate(key):
                parts = [*(f"{before['prop']}: after[{position}]" for position, before in enumerate(key[:index]))]
                parts.append(f"{column['prop']}: {{ [Op.gt]: after[{index}] }}")
                after.append(f"{{ {', '.join(parts)} }}")
            initial = f"{{ {soft} }}" if soft else "{}"
            if len(key) == 1:
                condition = f"if (after !== null) Object.assign(where, {after[0]})"
            else:
                condition = f"if (after !== null) Object.assign(where, {{ [Op.or]: [{', '.join(after)}] }})"
            last = ", ".join(f"last.{column['prop']}" for column in key)
            return [
                f"const where: WhereOptions = {initial}",
                condition,
                f"const rows = (await {model}.findAll({_options(['where', _order(info), 'limit: limit + 1'])})).map(toEntity)",
                "const items = rows.slice(0, limit)",
                "const last = items[items.length - 1]",
                f"return {{ items, next: rows.length > limit ? [{last}] : null }}",
            ]
        return [f"return (await {model}.findAll({_options([where, _order(info)])})).map(toEntity)"]
    if kind == "insert":
        # The values the database filled (the key, defaults) are read back into the entity
        return _write(
            info,
            [
                f"const row = await {model}.create(insertValues(entity), {{ transaction: this.transaction }})",
                bool(info["table"].get("primaryKey")) and "await row.reload({ transaction: this.transaction })",
                "return Object.assign(entity, toEntity(row))",
            ],
            imports,
        )
    if kind == "update":
        if not any(_changeable(info, column) for column in info["columns"]):
            return ["// Nothing of the row can change but its key", "return entity"]
        action = f"await {model}.update(updateValues(entity), {{ {_key_where(info)}, transaction: this.transaction }})"
        return [*_write(info, [action], imports), "return entity"]
    if kind == "delete":
        return _write(
            info, [f"await {model}.destroy({{ {_key_where(info)}, transaction: this.transaction }})"], imports
        )
    return ["throw new Error('not written')"]
