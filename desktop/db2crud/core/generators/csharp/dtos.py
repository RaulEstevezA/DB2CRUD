"""What services take and return besides the entities: the DTOs of each table when services take DTOs (create, update
and read, as records or classes), and the changes of an update in every case, written as the settings say: a Patch<T>
per field, or every field. They carry no validation: the service checks the values against the database's rules, so
every caller gets the same errors. Mirrors web/src/core/generators/csharp/dtos.ts."""

from ..types import lines
from .context import common_namespace, is_in, namespace_of, path_of
from .csharp import CsUsings


def create_dto(info: dict) -> str:
    return f"{info['entity']}Create"


def read_dto(info: dict) -> str:
    return f"{info['entity']}Read"


def update_type(context: dict, info: dict) -> str:
    return f"{info['entity']}Update" if context["settings"]["serviceTypes"] == "dtos" else f"{info['entity']}Changes"


def create_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if not column["generated"]]


def update_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if not column["generated"] and not is_in(column, info["key"])]


def read_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if column["column"]["name"] not in info["hidden"]]


def update_namespace(context: dict, info: dict) -> str:
    return namespace_of(context, info, "dtos" if context["settings"]["serviceTypes"] == "dtos" else "service")


def _type(name: str, doc: str, fields: list[dict], record: bool) -> list[str]:
    """A positional record, or a class with init-only properties."""
    if record:
        return [
            f"/// <summary>{doc}</summary>",
            f"public record {name}(",
            *(
                f"    {field['type']} {field['name']}{',' if index < len(fields) - 1 else ''}"
                for index, field in enumerate(fields)
            ),
            ");",
        ]
    return [
        f"/// <summary>{doc}</summary>",
        f"public class {name}",
        "{",
        *(
            f"    public {field['type']} {field['name']} {{ get; init; }}{' = null!;' if field['required'] else ''}"
            for field in fields
        ),
        "}",
    ]


def _unit(ns: str, name: str, usings: CsUsings, body: list[str]) -> dict:
    written = usings.write()
    return {
        "path": path_of(ns, name),
        "content": lines(written != "" and [written, ""], f"namespace {ns};", "", *body, ""),
    }


UPDATE_DOC = {
    "patch": "fields left Patch.Absent keep their value; Patch.Of(null) empties one.",
    "full": "every field is replaced.",
    "optional": "",
    "partial": "",
}


def dto_files(context: dict, info: dict) -> list[dict]:
    files = []
    dtos = context["settings"]["serviceTypes"] == "dtos"
    record = context["settings"]["dtoKind"] != "class"

    def fields_of(columns: list[dict]) -> list[dict]:
        return [
            {
                "type": column["propType"],
                "name": column["prop"],
                "required": not column["optional"] and not column["valueType"],
            }
            for column in columns
        ]

    patch = context["settings"]["updates"] == "patch"
    update_fields = [
        {
            "type": f"Patch<{column['propType']}>" if patch else column["propType"],
            "name": column["prop"],
            "required": patch or (not column["optional"] and not column["valueType"]),
        }
        for column in update_columns(info)
    ]
    update = info["role"] == "entity"
    entity = info["entity"]
    if dtos:
        ns = namespace_of(context, info, "dtos")
        if update:
            files.append(
                _unit(
                    ns,
                    create_dto(info),
                    CsUsings(ns),
                    _type(
                        create_dto(info),
                        f"The values of a new {entity}. Fields left null take the database's default.",
                        fields_of(create_columns(info)),
                        record,
                    ),
                )
            )
        files.append(
            _unit(
                ns,
                read_dto(info),
                CsUsings(ns),
                _type(read_dto(info), f"A {entity} as services return it.", fields_of(read_columns(info)), record),
            )
        )
    if update and info["service"]:
        ns = update_namespace(context, info)
        usings = CsUsings(ns)
        if patch:
            usings.add(common_namespace(context))
        files.append(
            _unit(
                ns,
                update_type(context, info),
                usings,
                _type(
                    update_type(context, info),
                    f"The values of a {entity} that change: {UPDATE_DOC[context['settings']['updates']]}",
                    update_fields,
                    record if dtos else True,
                ),
            )
        )
    return files
