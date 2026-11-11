"""The DTOs of each table, when services take and return DTOs: create, update (every field optional) and read
(without the hidden columns). Mirrors web/src/core/generators/python/sqlalchemy/dtos.ts."""

from ...types import lines
from ..python import Imports
from .context import column_py_type, is_in, module_of, path_of


def create_dto(info: dict) -> str:
    return f"{info['entity']}Create"


def update_dto(info: dict) -> str:
    return f"{info['entity']}Update"


def read_dto(info: dict) -> str:
    return f"{info['entity']}Read"


def create_columns(info: dict) -> list[dict]:
    """Columns a client sends when creating: everything the database does not fill."""
    return [column for column in info["columns"] if not column["generated"]]


def update_columns(info: dict) -> list[dict]:
    """Columns a client may change: not the key, not what the database fills."""
    return [column for column in info["columns"] if not column["generated"] and not is_in(column, info["key"])]


def read_columns(info: dict) -> list[dict]:
    """Columns returned: all but the hidden ones."""
    return [column for column in info["columns"] if column["column"]["name"] not in info["hidden"]]


def dtos_file(context: dict, info: dict) -> dict:
    imports = Imports()
    pydantic = context["settings"]["dtoKind"] == "pydantic"
    if pydantic:
        imports.from_("pydantic", "BaseModel")
    else:
        imports.from_("dataclasses", "dataclass")

    def field(column: dict, optional: bool) -> str:
        optional = optional or column["column"]["nullable"]
        return f"    {column['attr']}: {column_py_type(column, imports, optional)}{' = None' if optional else ''}"

    def header(name: str, doc: str) -> list[str]:
        if pydantic:
            return [f"class {name}(BaseModel):", f'    """{doc}"""', ""]
        return ["@dataclass(kw_only=True)", f"class {name}:", f'    """{doc}"""', ""]

    create = [field(column, not column["required"]) for column in create_columns(info)]
    update = [field(column, True) for column in update_columns(info)]
    read = [field(column, False) for column in read_columns(info)]
    if pydantic:
        imports.from_("pydantic", "ConfigDict")
    entity = info["entity"]
    content = lines(
        f'"""What services take and return for the "{info["name"]}" table."""',
        "",
        imports.write("app"),
        info["role"] == "entity"
        and [
            "",
            "",
            *header(
                create_dto(info), f"The values of a new {entity}. Optional fields left out take the database's default."
            ),
            *(create or ["    pass"]),
            "",
            "",
            *header(update_dto(info), f"The values of a {entity} that change; fields left out keep their value."),
            *(update or ["    pass"]),
        ],
        "",
        "",
        *header(read_dto(info), f"A {entity} as services return it."),
        pydantic and ["    model_config = ConfigDict(from_attributes=True)", ""],
        *(read or ["    pass"]),
        "",
    )
    return {"path": path_of(module_of(context, info, "dtos")), "content": content}
