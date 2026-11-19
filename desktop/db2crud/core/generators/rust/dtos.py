"""What services take and return besides the entities: the DTOs of each table when services take DTOs (create, update
and read, in one module), and the changes of an update in every case, written as the settings say: a Patch per field,
a double Option per field (None when not sent, Some(None) to empty it), or every field. They carry no validation: the
service checks the values against the database's rules, so every caller gets the same errors. Mirrors
web/src/core/generators/rust/dtos.ts."""

from .context import file_of, is_in, module_of, path_in, rs_file, stored_type


def create_dto(info: dict) -> str:
    return f"{info['entity']}Create"


def read_dto(info: dict) -> str:
    return f"{info['entity']}Read"


def update_type(context: dict, info: dict) -> str:
    """The changes of an update: a DTO when services take DTOs, or the table's own changes when they take entities."""
    return f"{info['entity']}Update" if context["settings"]["serviceTypes"] == "dtos" else f"{info['entity']}Changes"


def create_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if not column["generated"]]


def update_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if not column["generated"] and not is_in(column, info["key"])]


def read_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if column["column"]["name"] not in info["hidden"]]


def update_path(context: dict, info: dict) -> str:
    """The path of the update type: in the DTOs' module, or in the service's."""
    kind = "dtos" if context["settings"]["serviceTypes"] == "dtos" else "service"
    return path_in(module_of(context, info, kind), update_type(context, info))


def update_field_type(context: dict, column: dict) -> str:
    """The type of a field of the update: Patch<Option<String>>, Option<Option<String>> or the stored type."""
    if context["settings"]["updates"] == "patch":
        return f"crate::common::Patch<Option<{column['rs']}>>"
    if context["settings"]["updates"] == "optional":
        return f"Option<Option<{column['rs']}>>"
    return stored_type(column)


def _struct(name: str, doc: str, derives: str, fields: list[dict]) -> list[str]:
    return [
        f"/// {doc}",
        f"#[derive({derives})]",
        f"pub struct {name} {{" if fields else f"pub struct {name} {{}}",
        *(f"    pub {field['name']}: {field['type']}," for field in fields),
        *(["}"] if fields else []),
    ]


UPDATE_DOC = {
    "patch": "fields left Absent keep their value; Patch::Set(None) empties one.",
    "optional": "fields left None keep their value; Some(None) empties one.",
    "full": "every field is replaced.",
    "partial": "",
}


def update_struct(context: dict, info: dict) -> list[str]:
    """The struct of the changes of an update."""
    mode = context["settings"]["updates"]
    return _struct(
        update_type(context, info),
        f"The values of a {info['entity']} that change: {UPDATE_DOC[mode]}",
        "Debug, Clone, PartialEq" if mode == "full" else "Debug, Clone, Default, PartialEq",
        [{"name": column["field"], "type": update_field_type(context, column)} for column in update_columns(info)],
    )


def dto_file(context: dict, info: dict) -> dict:
    """The DTOs of a table, in one module."""
    update = info["role"] == "entity"
    body: list[str] = []
    if update:
        body += [
            *_struct(
                create_dto(info),
                f"The values of a new {info['entity']}. Fields left None take the database's default; the service says which ones are required.",
                "Debug, Clone, Default, PartialEq",
                [{"name": column["field"], "type": f"Option<{column['rs']}>"} for column in create_columns(info)],
            ),
            "",
        ]
    body += _struct(
        read_dto(info),
        f"A {info['entity']} as services return it.",
        "Debug, Clone, PartialEq",
        [{"name": column["field"], "type": stored_type(column)} for column in read_columns(info)],
    )
    if update and info["service"]:
        body += ["", *update_struct(context, info)]
    return rs_file(
        file_of(module_of(context, info, "dtos")), "", body, [f"What the service of {info['name']} takes and returns."]
    )
