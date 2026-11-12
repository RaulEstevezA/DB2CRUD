"""Plain entities, for the ORMs that keep their tables outside classes (a Prisma schema): one class per table with a
property per column and the TypeScript types every TypeScript project uses (common/context.py), so services, DTOs and
tests are the same whatever the ORM. The ORM's repositories turn its rows into them. Mirrors
web/src/core/generators/typescript/common/entities.ts."""

from ...types import lines
from .context import column_type, module_of, path_of


def plain_entity_file(context: dict, info: dict, where: str) -> dict:
    module = module_of(context, info, "entity")
    table = info["table"]

    def primary(column: dict) -> bool:
        return any(column is item for item in info["key"]) and table.get("primaryKey") is not None

    properties = []
    for index, column in enumerate(info["columns"]):
        if index > 0:
            properties.append("")
        if column["column"].get("comment"):
            properties.append(f"  /** {column['column']['comment']} */")
        optional = column["column"]["nullable"] and not primary(column)
        properties.append(f"  {column['prop']}!: {column_type(column, optional)}")
    comment = f": {table['comment']}" if table.get("comment") else ""
    content = lines(
        f'/** Entity of the "{info["name"]}" table{comment}. */',
        "",
        f'/** A row of the "{info["name"]}" table, as the repositories read and write it. {where} */',
        f"export class {info['entity']} {{",
        *properties,
        "}",
        "",
    )
    return {"path": path_of(module), "content": content}
