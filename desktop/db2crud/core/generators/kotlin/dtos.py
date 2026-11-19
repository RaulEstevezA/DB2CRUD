"""What services take and return besides the entities: the DTOs of each table when services take DTOs (create, update
and read, as data classes or plain classes), and the changes of an update in every case, written as the settings say: a
Patch per field, an Optional per field (null when not sent), or every field. They carry no validation: the service
checks the values against the database's rules, so every caller gets the same errors. Mirrors
web/src/core/generators/kotlin/dtos.ts."""

from .context import (
    common_package,
    is_in,
    kt_file,
    optional_type,
    package_of,
    path_of,
    qualified,
    stored_type,
)
from .kotlin import KtImports


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


def update_package(context: dict, info: dict) -> str:
    """The package of the update type: the DTOs', or the service's."""
    return package_of(context, info, "dtos" if context["settings"]["serviceTypes"] == "dtos" else "service")


def update_class(context: dict, info: dict) -> str:
    return qualified(update_package(context, info), update_type(context, info))


def update_field_type(context: dict, column: dict) -> str:
    """The type of a field of the update: Patch<String?>, Optional<String>? or the stored type."""
    if context["settings"]["updates"] == "patch":
        return f"Patch<{optional_type(column)}>"
    if context["settings"]["updates"] == "optional":
        return f"Optional<{column['kt']}>?"
    return stored_type(column)


def _data_class(name: str, doc: str, fields: list[dict], data: bool) -> list[str]:
    """A class whose fields are the parameters of its constructor."""
    # A data class needs a field: without one (a table where nothing can change) it is a plain class
    if not fields:
        return [f"/** {doc} */", f"class {name}"]
    return [
        f"/** {doc} */",
        f"{'data ' if data else ''}class {name}(",
        *(
            f"    val {field['name']}: {field['type']}{' = ' + field['initial'] if field.get('initial') else ''},"
            for field in fields
        ),
        ")",
    ]


UPDATE_DOC = {
    "patch": "fields left absent keep their value; Patch.of(null) empties one.",
    "optional": "fields left null keep their value; Optional.empty() empties one.",
    "full": "every field is replaced.",
    "partial": "",
}


def dto_files(context: dict, info: dict) -> list[dict]:
    files: list[dict] = []
    dtos = context["settings"]["serviceTypes"] == "dtos"
    data = context["settings"]["dtoKind"] != "class"

    def imports(pkg: str, columns: list[dict]) -> KtImports:
        result = KtImports(pkg)
        for column in columns:
            if column["ktImport"]:
                result.add(column["ktImport"])
        return result

    update = info["role"] == "entity"
    if dtos:
        pkg = package_of(context, info, "dtos")
        if update:
            files.append(
                kt_file(
                    path_of(pkg, create_dto(info)),
                    pkg,
                    imports(pkg, create_columns(info)).write(),
                    _data_class(
                        create_dto(info),
                        f"The values of a new {info['entity']}. Fields left null take the database's default; the service says which ones are required.",
                        [
                            {"type": optional_type(column), "name": column["prop"], "initial": "null"}
                            for column in create_columns(info)
                        ],
                        data,
                    ),
                )
            )
        files.append(
            kt_file(
                path_of(pkg, read_dto(info)),
                pkg,
                imports(pkg, read_columns(info)).write(),
                _data_class(
                    read_dto(info),
                    f"A {info['entity']} as services return it.",
                    [{"type": stored_type(column), "name": column["prop"]} for column in read_columns(info)],
                    data,
                ),
            )
        )
    if update and info["service"]:
        pkg = update_package(context, info)
        field_imports = imports(pkg, update_columns(info))
        mode = context["settings"]["updates"]
        if mode == "patch":
            field_imports.add(qualified(common_package(context), "Patch"))
        if mode == "optional":
            field_imports.add("java.util.Optional")
        initial = "Patch.absent()" if mode == "patch" else "null" if mode == "optional" else None
        files.append(
            kt_file(
                path_of(pkg, update_type(context, info)),
                pkg,
                field_imports.write(),
                _data_class(
                    update_type(context, info),
                    f"The values of a {info['entity']} that change: {UPDATE_DOC[mode]}",
                    [
                        {"type": update_field_type(context, column), "name": column["prop"], "initial": initial}
                        for column in update_columns(info)
                    ],
                    data if dtos else True,
                ),
            )
        )
    return files
