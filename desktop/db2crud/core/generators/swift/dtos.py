"""What services take and return besides the entities: the DTOs of each table when services take DTOs (create, update
and read), and the changes of an update in every case, written as the settings say: a Patch per field, a double
optional per field (nil when not sent, .some(nil) to empty it), or every field. They carry no validation: the service
checks the values against the database's rules, so every caller gets the same errors. Mirrors
web/src/core/generators/swift/dtos.ts."""

from .context import file_of, is_in, stored_type, sw_file
from .swift import imports


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


def update_field_type(context: dict, column: dict) -> str:
    """The type of a field of the update: Patch<String?>, String?? or the stored type."""
    if context["settings"]["updates"] == "patch":
        return f"Patch<{column['sw']}?>"
    if context["settings"]["updates"] == "optional":
        return f"{column['sw']}??"
    return stored_type(column)


def _struct(name: str, doc: str, conformances: str, fields: list[dict]) -> list[str]:
    """A struct with public properties and a public initializer that takes them."""
    params = ", ".join(
        f"{field['name']}: {field['type']}{' = ' + field['initial'] if field.get('initial') else ''}"
        for field in fields
    )
    return [
        f"/// {doc}",
        f"public struct {name}: {conformances} {{",
        *(f"    public var {field['name']}: {field['type']}" for field in fields),
        *([""] if fields else []),
        f"    public init({params}) {{",
        *(f"        self.{field['name']} = {field['name']}" for field in fields),
        "    }",
        "}",
    ]


UPDATE_DOC = {
    "patch": "fields left .absent keep their value; .set(nil) empties one.",
    "optional": "fields left nil keep their value; .some(nil) empties one.",
    "full": "every field is replaced.",
    "partial": "",
}


def update_struct(context: dict, info: dict) -> list[str]:
    """The struct of the changes of an update."""
    mode = context["settings"]["updates"]
    initial = ".absent" if mode == "patch" else "nil" if mode == "optional" else None
    return _struct(
        update_type(context, info),
        f"The values of a {info['entity']} that change: {UPDATE_DOC[mode]}",
        "Sendable",
        [
            {"name": column["prop"], "type": update_field_type(context, column), "initial": initial}
            for column in update_columns(info)
        ],
    )


def update_file(context: dict, info: dict) -> dict:
    """The changes of an update, in a file of their own: a DTO, or next to the service."""
    kind = "dtos" if context["settings"]["serviceTypes"] == "dtos" else "service"
    return sw_file(
        file_of(context, info, kind, update_type(context, info)), imports("Foundation"), update_struct(context, info)
    )


def dto_files(context: dict, info: dict) -> list[dict]:
    files: list[dict] = []
    if info["role"] == "entity":
        files.append(
            sw_file(
                file_of(context, info, "dtos", create_dto(info)),
                imports("Foundation"),
                _struct(
                    create_dto(info),
                    f"The values of a new {info['entity']}. Fields left nil take the database's default; the service says which ones are required.",
                    "Sendable, Equatable",
                    [
                        {"name": column["prop"], "type": f"{column['sw']}?", "initial": "nil"}
                        for column in create_columns(info)
                    ],
                ),
            )
        )
    files.append(
        sw_file(
            file_of(context, info, "dtos", read_dto(info)),
            imports("Foundation"),
            _struct(
                read_dto(info),
                f"A {info['entity']} as services return it.",
                "Sendable, Equatable",
                [{"name": column["prop"], "type": stored_type(column)} for column in read_columns(info)],
            ),
        )
    )
    return files
