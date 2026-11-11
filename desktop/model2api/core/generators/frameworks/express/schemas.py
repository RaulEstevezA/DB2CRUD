"""Zod schemas and TypeScript types of the Express project: enums and embedded objects shared by the resources,
and for each resource its creation and partial update schemas, the record the repositories keep and the
response the API returns. They follow the shapes of the OpenAPI contract field by field. Mirrors
web/src/core/generators/frameworks/express/schemas.ts.
"""

import re

from ....js import js_string, number_text
from ....openapi.build import shape_fields
from ...common.text import file_text, lines
from ...languages.typescript.typescript import TsImports, ts_doc, ts_literal, ts_property, ts_string, ts_type
from .context import ExpressContext, import_path, names

_STRING_FORMATS = {
    "email": "z.email()",
    "uri": "z.url()",
    "uuid": "z.uuid()",
    "date": "z.iso.date()",
    "date-time": "z.iso.datetime({ offset: true })",
    "time": "z.iso.time()",
}
_SCALARS = {
    "integer": "z.number().int()",
    "float": "z.number()",
    "decimal": "z.number()",
    "boolean": "z.boolean()",
    "date": "z.iso.date()",
    "datetime": "z.iso.datetime({ offset: true })",
    "time": "z.iso.time()",
    "duration": "z.iso.duration()",
    "uuid": "z.uuid()",
    "binary": "z.base64()",
    "any": "z.unknown()",
}


def _zod_type(type_ref: dict, field: dict | None, used: dict, lazy: set[str]) -> str:
    """The Zod schema of a type, before its validations and nullability."""
    kind = type_ref["kind"]
    if kind == "scalar":
        text_format = field["constraints"].get("format") if field else None
        if type_ref["scalar"] == "string":
            return _STRING_FORMATS.get(text_format, "z.string()")
        return _SCALARS.get(type_ref["scalar"], "z.unknown()")
    if kind == "array":
        return f"z.array({_zod_type(type_ref['items'], None, used, lazy)})"
    if kind == "map":
        return f"z.record(z.string(), {_zod_type(type_ref['value'], None, used, lazy)})"
    name = ts_type(type_ref["name"])
    used[name] = None
    return f"z.lazy(() => {name})" if type_ref["name"] in lazy else name


def _checks(field: dict) -> str:
    """The validations a field declares, as chained Zod checks."""
    c = field["constraints"]
    parts: list[str] = []
    type_ref = field["type"]
    text = type_ref["kind"] == "scalar" and type_ref["scalar"] == "string"
    is_list = type_ref["kind"] == "array"
    is_number = type_ref["kind"] == "scalar" and type_ref["scalar"] in ("integer", "float", "decimal")
    if text or is_list:
        minimum = c.get("minItems") if is_list else c.get("minLength")
        maximum = c.get("maxItems") if is_list else c.get("maxLength")
        if minimum is not None:
            parts.append(f".min({number_text(minimum)})")
        if maximum is not None:
            parts.append(f".max({number_text(maximum)})")
    if text and c.get("pattern") is not None:
        parts.append(f".regex(new RegExp({ts_string(c['pattern'])}))")
    if is_number:
        for key, method in (
            ("minimum", "min"),
            ("maximum", "max"),
            ("exclusiveMinimum", "gt"),
            ("exclusiveMaximum", "lt"),
        ):
            if c.get(key) is not None:
                parts.append(f".{method}({number_text(c[key])})")
    return "".join(parts)


def _field_schema(field: dict, shape: str, used: dict, lazy: set[str]) -> str:
    """The Zod schema of a field in one shape: required, defaulted or optional, nullable or not."""
    schema = _zod_type(field["type"], field, used, lazy) + _checks(field)
    if field["nullable"]:
        schema += ".nullable()"
    if shape == "update":
        return f"{schema}.optional()"
    if field["required"]:
        return schema
    if "defaultValue" in field:
        return f"{schema}.default({ts_literal(field['defaultValue'])})"
    return f"{schema}.optional()"


_COMPOUND = re.compile(r"[ |]")


def ts_type_of(type_ref: dict) -> str:
    """The TypeScript type of an API type, for records and responses."""
    kind = type_ref["kind"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar in ("integer", "float", "decimal"):
            return "number"
        if scalar == "boolean":
            return "boolean"
        return "unknown" if scalar == "any" else "string"
    if kind == "array":
        items = ts_type_of(type_ref["items"])
        return f"({items})[]" if _COMPOUND.search(items) else f"{items}[]"
    if kind == "map":
        return f"Record<string, {ts_type_of(type_ref['value'])}>"
    return ts_type(type_ref["name"])


def _object_block(fields: list[dict], shape: str, used: dict, lazy: set[str]) -> str:
    entries = []
    for field in fields:
        todo = f"  // TODO: {field['todo']}\n" if field.get("todo") else ""
        entries.append(f"{todo}  {ts_property(field['wire'])}: {_field_schema(field, shape, used, lazy)},")
    joined = "\n".join(entries)
    return f"z.strictObject({{\n{joined}\n}})" if entries else "z.strictObject({})"


def _inner(type_ref: dict) -> list[str]:
    kind = type_ref["kind"]
    if kind == "object":
        return [type_ref["name"]]
    if kind == "array":
        return _inner(type_ref["items"])
    if kind == "map":
        return _inner(type_ref["value"])
    return []


def order_objects(objects: list[dict]) -> tuple[list[dict], set[str]]:
    """Objects ordered so each is declared after the objects it holds; the ones in a cycle are read lazily."""
    ordered: list[dict] = []
    lazy: set[str] = set()
    state: dict[str, str] = {}

    def visit(spec_object: dict) -> None:
        if state.get(spec_object["name"]) == "done":
            return
        state[spec_object["name"]] = "visiting"
        for field in spec_object["fields"]:
            for name in _inner(field["type"]):
                target = next((item for item in objects if item["name"] == name), None)
                if not target:
                    continue
                if state.get(name) == "visiting":
                    lazy.add(name)
                else:
                    visit(target)
        state[spec_object["name"]] = "done"
        ordered.append(spec_object)

    for spec_object in objects:
        visit(spec_object)
    return ordered, lazy


def shared_file(context: ExpressContext) -> dict | None:
    """The shared module: enums and embedded objects."""
    spec = context.spec
    if not spec["enums"] and not spec["objects"]:
        return None
    blocks: list[str] = []
    for item in spec["enums"]:
        name = ts_type(item["name"])
        if item["valueType"] == "string":
            schema = f"z.enum([{', '.join(ts_string(js_string(value)) for value in item['values'])}])"
        else:
            schema = f"z.union([{', '.join(f'z.literal({number_text(value)})' for value in item['values'])}])"
        blocks.append(
            lines(
                f"/** Values of {item['name']}. */",
                f"export const {name} = {schema}",
                f"export type {name} = z.infer<typeof {name}>",
            )
        )
    ordered, lazy = order_objects(spec["objects"])
    for spec_object in ordered:
        name = ts_type(spec_object["name"])
        used: dict = {}
        is_lazy = spec_object["name"] in lazy
        annotation = f": z.ZodType<{name}>" if is_lazy else ""
        description = spec_object.get("description")
        if description is None:
            description = f"{spec_object['name']}, embedded in the resources that hold it."
        if is_lazy:
            members = "\n".join(
                f"  {ts_property(field['wire'])}{'' if field['required'] else '?'}: {ts_type_of(field['type'])}"
                f"{' | null' if field['nullable'] else ''}"
                for field in spec_object["fields"]
            )
            declared = f"export interface {name} {{\n{members}\n}}"
        else:
            declared = f"export type {name} = z.infer<typeof {name}>"
        blocks.append(
            lines(
                f"/** {description} */",
                f"export const {name}{annotation} = {_object_block(spec_object['fields'], 'object', used, lazy)}",
                declared,
            )
        )
    content = lines(
        ts_doc("Enums and embedded objects shared by the resources."),
        "",
        "import { z } from 'zod'",
        "",
        "\n\n".join(blocks),
    )
    return {"path": context.layout.shared(), "content": file_text(content)}


def resource_schemas_file(context: ExpressContext, resource: dict) -> dict:
    """Creation and update schemas, record and response of a resource."""
    path = context.layout.resource(resource, "schemas")
    name = names(resource)
    used: dict = {}
    lazy: set[str] = set()
    create = _object_block(shape_fields(resource["fields"], "create"), "create", used, lazy)
    update = _object_block(shape_fields(resource["fields"], "update"), "update", used, lazy)
    server = [field for field in resource["fields"] if field["access"] == "readOnly"]
    server_type = [
        f"  {ts_property(field['wire'])}: {ts_type_of(field['type'])}"
        f"{' | null' if field['nullable'] or field.get('server') == 'pending' else ''}"
        for field in server
    ]
    hidden = [field for field in resource["fields"] if field["access"] == "writeOnly"]
    imports = TsImports().add("zod", "z")
    for shared in used:
        imports.add(import_path(path, context.layout.shared()), shared)
    # The response leaves out what clients only send
    if not hidden:
        to_response = [
            f"export function {name['toResponse']}(record: {name['record']}): {name['type']} {{",
            "  return record",
            "}",
        ]
    else:
        renamed = ", ".join(f"{ts_property(field['wire'])}: _hidden{index}" for index, field in enumerate(hidden))
        to_response = [
            f"export function {name['toResponse']}(record: {name['record']}): {name['type']} {{",
            f"  const {{ {renamed}, ...response }} = record",
            "  return response",
            "}",
        ]
    one = _article(resource["singular"])
    content = lines(
        ts_doc(f"Request and response shapes of {resource['plural']}."),
        "",
        imports.render(),
        "",
        resource.get("todo") and [f"// TODO: {resource['todo']}", ""],
        f"/** Body of a request that creates or replaces {one}. */",
        f"export const {name['create']} = {create}",
        f"export type {name['create']} = z.infer<typeof {name['create']}>",
        "",
        f"/** Body of a request that changes part of {one}: only the fields sent change. */",
        f"export const {name['update']} = {update}",
        f"export type {name['update']} = z.infer<typeof {name['update']}>",
        "",
        f"/** {_capitalize(one)} as the repositories keep it: what clients send and what the server fills. */",
        [f"export type {name['record']} = {name['create']} & {{", server_type, "}"]
        if server
        else f"export type {name['record']} = {name['create']}",
        "",
        f"/** {_capitalize(one)} as the API returns it. */",
        f"export type {name['type']} = Omit<{name['record']}, {' | '.join(ts_string(field['wire']) for field in hidden)}>"
        if hidden
        else f"export type {name['type']} = {name['record']}",
        "",
        f"/** The response of a stored {resource['singular']}. */",
        to_response,
    )
    return {"path": path, "content": file_text(content)}


_VOWEL = re.compile(r"^[aeiou]", re.IGNORECASE)


def _article(text: str) -> str:
    return f"an {text}" if _VOWEL.match(text) else f"a {text}"


def _capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
