"""What services take and return besides the entities: the DTOs of each table when services take DTOs (create, update
and read, as records or classes), and the changes of an update in every case, written as the settings say: a Patch<T>
per field, an Optional<T> per field (null when not sent), or every field. They carry no validation: the service checks
the values against the database's rules, so every caller gets the same errors. Mirrors
web/src/core/generators/java/dtos.ts."""

from ..types import lines
from .context import common_package, is_in, package_of
from .java import JavaImports, capitalized, java_path


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


def accessor(context: dict, field: str, record: bool | None = None) -> str:
    """How a field of a DTO is read: name() of a record, getName() of a class."""
    if record is None:
        record = context["settings"]["dtoKind"] != "class"
    return f"{field}()" if record else f"get{capitalized(field)}()"


def update_field_type(context: dict, column: dict) -> str:
    updates = context["settings"]["updates"]
    if updates == "patch":
        return f"Patch<{column['java']}>"
    if updates == "optional":
        return f"Optional<{column['java']}>"
    return column["java"]


def _type(name: str, doc: str, fields: list[dict], record: bool) -> list[str]:
    """A record, or a class with a constructor and getters."""
    if record:
        if not fields:
            return [f"/** {doc} */", f"public record {name}() {{}}"]
        return [
            f"/** {doc} */",
            f"public record {name}(",
            *(
                f"        {field['type']} {field['name']}{',' if index < len(fields) - 1 else ''}"
                for index, field in enumerate(fields)
            ),
            ") {}",
        ]
    getters = []
    for field in fields:
        getters += [
            "",
            f"    public {field['type']} get{capitalized(field['name'])}() {{",
            f"        return {field['name']};",
            "    }",
        ]
    return [
        f"/** {doc} */",
        f"public class {name} {{",
        *(f"    private final {field['type']} {field['name']};" for field in fields),
        "",
        f"    public {name}({', '.join(field['type'] + ' ' + field['name'] for field in fields)}) {{",
        *(f"        this.{field['name']} = {field['name']};" for field in fields),
        "    }",
        *getters,
        "}",
    ]


def _unit(pkg: str, name: str, imports: JavaImports, body: list[str]) -> dict:
    written = imports.write()
    return {
        "path": java_path(pkg, name),
        "content": lines(f"package {pkg};", "", written != "" and [written, ""], *body, ""),
    }


def _imports_of(context: dict, pkg: str, columns: list[dict], update: bool) -> JavaImports:
    imports = JavaImports(pkg)
    for column in columns:
        if column["javaImport"]:
            imports.add(column["javaImport"])
    if update and context["settings"]["updates"] == "patch":
        imports.add(f"{common_package(context)}.Patch")
    if update and context["settings"]["updates"] == "optional":
        imports.add("java.util.Optional")
    return imports


UPDATE_DOC = {
    "patch": "fields left absent keep their value; Patch.of(null) empties one.",
    "optional": "fields left null keep their value; Optional.empty() empties one.",
    "full": "every field is replaced.",
    "partial": "",
}


def dto_files(context: dict, info: dict) -> list[dict]:
    files = []
    dtos = context["settings"]["serviceTypes"] == "dtos"
    record = context["settings"]["dtoKind"] != "class"

    def fields_of(columns: list[dict]) -> list[dict]:
        return [{"type": column["java"], "name": column["prop"]} for column in columns]

    update_fields = [
        {"type": update_field_type(context, column), "name": column["prop"]} for column in update_columns(info)
    ]
    update = info["role"] == "entity"
    entity = info["entity"]
    if dtos:
        pkg = package_of(context, info, "dtos")
        if update:
            files.append(
                _unit(
                    pkg,
                    create_dto(info),
                    _imports_of(context, pkg, create_columns(info), False),
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
                pkg,
                read_dto(info),
                _imports_of(context, pkg, read_columns(info), False),
                _type(read_dto(info), f"A {entity} as services return it.", fields_of(read_columns(info)), record),
            )
        )
    if update and info["service"]:
        pkg = update_package(context, info)
        files.append(
            _unit(
                pkg,
                update_type(context, info),
                _imports_of(context, pkg, update_columns(info), True),
                _type(
                    update_type(context, info),
                    f"The values of a {entity} that change: {UPDATE_DOC[context['settings']['updates']]}",
                    update_fields,
                    record if dtos else True,
                ),
            )
        )
    return files
