"""The DTOs of each table, when services take and return DTOs instead of entities: what a new row needs (create),
what may change (update, every field optional) and what is returned (read, without the hidden columns). As
interfaces or classes, as the settings say. Mirrors web/src/core/generators/typescript/common/dtos.ts."""

from ...types import lines
from .context import column_type, is_in, module_of, path_of


def create_dto(info: dict) -> str:
    return f"{info['entity']}Create"


def update_dto(info: dict) -> str:
    return f"{info['entity']}Update"


def read_dto(info: dict) -> str:
    return f"{info['entity']}Read"


def create_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if not column["generated"]]


def update_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if not column["generated"] and not is_in(column, info["key"])]


def read_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if column["column"]["name"] not in info["hidden"]]


def dtos_file(context: dict, info: dict) -> dict:
    as_class = context["settings"]["dtoKind"] == "class"
    keyword = "export class" if as_class else "export interface"

    def field(column: dict, optional: bool) -> str:
        mark = "?" if optional else "!" if as_class else ""
        return f"  {column['prop']}{mark}: {column_type(column)}"

    def block(name: str, doc: str, fields: list[str]) -> list[str]:
        return [f"/** {doc} */", f"{keyword} {name} {{", *fields, "}"]

    entity = info["entity"]
    content = lines(
        f'/** What services take and return for the "{info["name"]}" table. */',
        "",
        info["role"] == "entity"
        and [
            *block(
                create_dto(info),
                f"The values of a new {entity}. Optional fields left out take the database's default.",
                [field(column, not column["required"]) for column in create_columns(info)],
            ),
            "",
            *block(
                update_dto(info),
                f"The values of a {entity} that change; fields left out keep their value.",
                [field(column, True) for column in update_columns(info)],
            ),
            "",
        ],
        *block(
            read_dto(info),
            f"A {entity} as services return it.",
            [field(column, False) for column in read_columns(info)],
        ),
        "",
    )
    return {"path": path_of(module_of(context, info, "dtos")), "content": content}
