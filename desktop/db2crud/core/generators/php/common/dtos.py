"""What services take and return besides the entities: the DTOs of each table when services take DTOs (create, update
and read, as readonly or plain classes with promoted constructors), and the changes of an update in every case,
written as the settings say: a Patch per field, an array of the changed fields (no class), or every field. Mirrors
web/src/core/generators/php/common/dtos.ts."""

import re

from .context import (
    class_name,
    common_class,
    is_in,
    namespace_of,
    optional_type,
    path_of,
    php_file,
    stored_type,
)
from .php import PhpUses


def create_dto(info: dict) -> str:
    return f"{info['entity']}Create"


def read_dto(info: dict) -> str:
    return f"{info['entity']}Read"


def update_type(context: dict, info: dict) -> str:
    """The changes of an update: a DTO when services take DTOs, or the table's own changes when they take entities."""
    return f"{info['entity']}Update" if context["settings"]["serviceTypes"] == "dtos" else f"{info['entity']}Changes"


def partial_updates(context: dict) -> bool:
    """Whether the changes of an update are an array of the changed fields, with no class of their own."""
    return context["settings"]["updates"] == "partial"


def create_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if not column["generated"]]


def update_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if not column["generated"] and not is_in(column, info["key"])]


def read_columns(info: dict) -> list[dict]:
    return [column for column in info["columns"] if column["column"]["name"] not in info["hidden"]]


def update_namespace(context: dict, info: dict) -> str:
    """The namespace of the update type: the DTOs', or the service's."""
    return namespace_of(context, info, "dtos" if context["settings"]["serviceTypes"] == "dtos" else "service")


def doc_type(column: dict) -> str:
    """The type of a stored value as PHPDoc writes it: string|null."""
    return re.sub(r"^\?(.*)$", r"\1|null", stored_type(column))


def partial_shape(info: dict) -> str:
    """The shape of the array an update takes when updates are partial: array{email?: string, ...}."""
    return "array{" + ", ".join(f"{column['field']}?: {doc_type(column)}" for column in update_columns(info)) + "}"


def _data_class(name: str, doc: list[str], params: list[dict], readonly: bool, params_doc: list[str] | None = None):
    """A class whose fields are the parameters of its constructor."""
    params_doc = params_doc or []
    return [
        *doc,
        f"final {'readonly ' if readonly else ''}class {name}",
        "{",
        *(["    /**", *(f"     * {line}" for line in params_doc), "     */"] if params_doc else []),
        "    public function __construct(",
        *(
            f"        public {param['type']} ${param['name']}{' = ' + param['initial'] if param.get('initial') else ''},"
            for param in params
        ),
        "    ) {",
        "    }",
        "}",
    ]


UPDATE_DOC = {
    "patch": "fields left absent keep their value; Patch::of(null) empties one.",
    "full": "every field is replaced.",
    "optional": "",
    "partial": "",
}


def dto_files(context: dict, info: dict) -> list[dict]:
    files = []
    dtos = context["settings"]["serviceTypes"] == "dtos"
    readonly = context["settings"]["dtoKind"] != "class"

    def unit(ns: str, name: str, uses: PhpUses, body: list[str]) -> dict:
        return php_file(path_of(ns, name), ns, uses.write(), body)

    update = info["role"] == "entity"
    if dtos:
        ns = namespace_of(context, info, "dtos")
        if update:
            files.append(
                unit(
                    ns,
                    create_dto(info),
                    PhpUses(ns),
                    _data_class(
                        create_dto(info),
                        [
                            f"/** The values of a new {info['entity']}. Fields left null take the database's default; "
                            "the service says which ones are required. */"
                        ],
                        [
                            {"type": optional_type(column), "name": column["field"], "initial": "null"}
                            for column in create_columns(info)
                        ],
                        readonly,
                    ),
                )
            )
        files.append(
            unit(
                ns,
                read_dto(info),
                PhpUses(ns),
                _data_class(
                    read_dto(info),
                    [f"/** A {info['entity']} as services return it. */"],
                    [{"type": stored_type(column), "name": column["field"]} for column in read_columns(info)],
                    readonly,
                ),
            )
        )
    if update and info["service"] and not partial_updates(context):
        ns = update_namespace(context, info)
        uses = PhpUses(ns)
        patch = context["settings"]["updates"] == "patch"
        if patch:
            uses.add(common_class(context, "Patch"))
        params = [
            {"type": "Patch", "name": column["field"], "initial": "new Patch()"}
            if patch
            else {"type": stored_type(column), "name": column["field"]}
            for column in update_columns(info)
        ]
        doc = [f"/** The values of a {info['entity']} that change: {UPDATE_DOC[context['settings']['updates']]} */"]
        params_doc = (
            [f"@param Patch<{doc_type(column)}> ${column['field']}" for column in update_columns(info)] if patch else []
        )
        files.append(
            unit(
                ns,
                update_type(context, info),
                uses,
                _data_class(update_type(context, info), doc, params, readonly if dtos else True, params_doc),
            )
        )
    return files


def update_class(context: dict, info: dict) -> str:
    """The full name of the update type, for use."""
    return class_name(update_namespace(context, info), update_type(context, info))
