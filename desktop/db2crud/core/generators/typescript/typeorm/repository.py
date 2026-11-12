"""The bodies of the TypeORM repositories, over an EntityManager: find options with the soft-delete filter, pages by
offset or after a key (a query builder), and writes that turn a database refusal into a ConflictError. Mirrors
web/src/core/generators/typescript/typeorm/repository.ts."""

from ..common.context import find_info
from ..typescript import TsImports


def _soft_option(info: dict, imports: TsImports) -> str | None:
    """The condition that leaves out rows marked as deleted, as a find option."""
    soft = info["soft"]
    if not soft:
        return None
    if soft["column"]["type"]["kind"] == "boolean":
        return f"{soft['prop']}: false"
    imports.from_("typeorm", "IsNull")
    return f"{soft['prop']}: IsNull()"


def _where(info: dict, conditions: list[str], imports: TsImports) -> str | None:
    every = [item for item in [*conditions, _soft_option(info, imports)] if item is not None]
    return f"where: {{ {', '.join(every)} }}" if every else None


def _order(info: dict) -> str:
    return f"order: {{ {', '.join(column['prop'] + ': ' + chr(39) + 'ASC' + chr(39) for column in info['key'])} }}"


def _options(items: list) -> str:
    present = [item for item in items if item is not None]
    return f", {{ {', '.join(present)} }}" if present else ""


def _write(info: dict, action: str, imports: TsImports) -> list:
    """A write, with a database refusal (a unique value, a row still pointed to) turned into a ConflictError."""
    imports.from_("typeorm", "QueryFailedError").from_("src/errors", "ConflictError")
    return [
        "try {",
        f"  {action}",
        "} catch (error) {",
        f"  if (error instanceof QueryFailedError) throw new ConflictError('{info['entity']}', `the database refused the change: ${{error.message}}`)",
        "  throw error",
        "}",
    ]


def _reaches_json(context: dict, info: dict, seen: set) -> bool:
    """Whether the entity holds JSON (unknown) values, itself or through the rows its relations point to: TypeORM's
    insert() then cannot check it against its deep partial type, and is told what it is."""
    if info["name"] in seen:
        return False
    seen.add(info["name"])
    if any(column["column"]["type"]["kind"] in ("json", "array") for column in info["columns"]):
        return True
    for key in info["table"]["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        if (
            parent is not None
            and parent["table"].get("primaryKey") is not None
            and _reaches_json(context, parent, seen)
        ):
            return True
    return False


def typeorm_body(context: dict, info: dict, method: dict, imports: TsImports) -> list:
    entity = info["entity"]
    params = [param["name"] for param in method["params"]]
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [f"return this.manager.findOne({entity}{_options([_where(info, params, imports)])})"]
    if kind in ("listByParent", "findAllBy"):
        return [f"return this.manager.find({entity}{_options([_where(info, params, imports), _order(info)])})"]
    if kind == "list":
        if paging == "offset":
            found = _options([_where(info, [], imports), _order(info), "skip: offset", "take: limit"])
            return [
                f"const [items, total] = await this.manager.findAndCount({entity}{found})",
                "return { items, total, offset, limit }",
            ]
        if paging == "cursor":
            columns = [f"row.{column['prop']}" for column in info["key"]]
            marks = [f":k{index}" for index in range(len(info["key"]))]
            values = ", ".join(f"k{index}: after[{index}]" for index in range(len(info["key"])))
            after = (
                f"{columns[0]} > {marks[0]}" if len(columns) == 1 else f"({', '.join(columns)}) > ({', '.join(marks)})"
            )
            soft = info["soft"]
            if soft:
                soft_condition = (
                    f"row.{soft['prop']} = false"
                    if soft["column"]["type"]["kind"] == "boolean"
                    else f"row.{soft['prop']} IS NULL"
                )
            else:
                soft_condition = None
            last = ", ".join(f"last.{column['prop']}" for column in info["key"])
            return [
                f"const query = this.manager.createQueryBuilder({entity}, 'row')",
                *(
                    f"query.{'orderBy' if index == 0 else 'addOrderBy'}('{column}', 'ASC')"
                    for index, column in enumerate(columns)
                ),
                "query.limit(limit + 1)",
                soft_condition and f"query.andWhere('{soft_condition}')",
                f"if (after !== null) query.andWhere('{after}', {{ {values} }})",
                "const rows = await query.getMany()",
                "const items = rows.slice(0, limit)",
                "const last = items[items.length - 1]",
                f"return {{ items, next: rows.length > limit ? [{last}] : null }}",
            ]
        return [f"return this.manager.find({entity}{_options([_where(info, [], imports), _order(info)])})"]
    if kind == "insert":
        # insert() puts the values the database filled (the key, defaults) back into the entity, but a new 64-bit key
        # as the driver returns it: text. Reads return it as a number (the data source asks for that)
        big_keys = [
            column
            for column in info["columns"]
            if column["column"].get("generated") == "identity"
            and column["column"]["type"]["kind"] == "integer"
            and column["column"]["type"].get("bits") == 64
        ]
        json = _reaches_json(context, info, set())
        if json:
            imports.type("typeorm", "QueryDeepPartialEntity")
        value = f"entity as QueryDeepPartialEntity<{entity}>" if json else "entity"
        return [
            *_write(info, f"await this.manager.insert({entity}, {value})", imports),
            bool(big_keys) and "// The driver returns a new 64-bit key as text",
            *(f"entity.{column['prop']} = Number(entity.{column['prop']})" for column in big_keys),
            "return entity",
        ]
    if kind == "update":
        return [*_write(info, f"await this.manager.save({entity}, entity)", imports), "return entity"]
    if kind == "delete":
        key = ", ".join(f"{column['prop']}: entity.{column['prop']}" for column in info["key"])
        return _write(info, f"await this.manager.delete({entity}, {{ {key} }})", imports)
    return ["throw new Error('not written')"]
