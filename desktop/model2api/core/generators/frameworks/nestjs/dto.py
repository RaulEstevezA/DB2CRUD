"""DTOs of the NestJS project, validated with class-validator: the enums and embedded objects shared by the
resources, and for each resource its creation and partial update bodies, the record the repositories keep and
the response the API returns. They follow the shapes of the OpenAPI contract field by field. Mirrors
web/src/core/generators/frameworks/nestjs/dto.ts.
"""

import re

from ....js import number_text
from ....model.naming import to_screaming_snake_case
from ....openapi.build import shape_fields
from ...common.text import file_text, lines
from ...languages.typescript.typescript import TsImports, ts_doc, ts_literal, ts_property, ts_string, ts_type
from .context import SHARED, NestContext, import_path, names, resource_path

_COMPOUND = re.compile(r"[ |]")


def ts_type_of(type_ref: dict) -> str:
    """The TypeScript type of an API type."""
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
    if kind == "object":
        return f"{ts_type(type_ref['name'])}Dto"
    return ts_type(type_ref["name"])


def enum_constant(name: str) -> str:
    """Name of the constant that lists an enum's values: ORDER_STATUS."""
    return to_screaming_snake_case(name) or "VALUES"


def _reference_scalar(context: NestContext, field: dict) -> str:
    """The type of a reference field: the key of the resource it points to."""
    target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
    scalar = target["key"]["type"]["scalar"]
    return "integer" if scalar == "integer" else "uuid" if scalar == "uuid" else "string"


def _type_decorators(
    context: NestContext, type_ref: dict, field: dict, imports: TsImports, here: str, each: bool
) -> list[str]:
    """class-validator decorators of a value of a type; each checks every item of a list."""

    def cv(*decorators: str) -> None:
        imports.add("class-validator", *decorators)

    def with_import(decorator: str, text: str) -> str:
        cv(decorator)
        return text

    opt = "{ each: true }" if each else ""
    each_after = ", { each: true }" if each else ""
    c = field["constraints"]
    kind = type_ref["kind"]
    if field.get("reference") and kind != "array":
        scalar = _reference_scalar(context, field)
        if scalar == "integer":
            cv("IsInt")
            return [f"@IsInt({opt})"]
        if scalar == "uuid":
            cv("IsUUID")
            return [f"@IsUUID({_ALL_EACH if each else ''})"]
        cv("IsString")
        return [f"@IsString({opt})"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "string":
            result: list[str] = []
            text_format = c.get("format")
            if text_format == "email":
                result.append(with_import("IsEmail", f"@IsEmail({'{}, { each: true }' if each else ''})"))
            elif text_format == "uri":
                result.append(with_import("IsUrl", f"@IsUrl({{ require_tld: false }}{each_after})"))
            elif text_format == "uuid":
                result.append(with_import("IsUUID", f"@IsUUID({_ALL_EACH if each else ''})"))
            elif text_format in ("date", "date-time"):
                result.append(with_import("IsISO8601", f"@IsISO8601({{ strict: true }}{each_after})"))
            else:
                result.append(with_import("IsString", f"@IsString({opt})"))
            if not each and c.get("minLength") is not None:
                result.append(with_import("MinLength", f"@MinLength({number_text(c['minLength'])})"))
            if not each and c.get("maxLength") is not None:
                result.append(with_import("MaxLength", f"@MaxLength({number_text(c['maxLength'])})"))
            if not each and c.get("pattern") is not None:
                result.append(with_import("Matches", f"@Matches(new RegExp({ts_string(c['pattern'])}))"))
            return result
        if scalar in ("integer", "float", "decimal"):
            if scalar == "integer":
                result = [with_import("IsInt", f"@IsInt({opt})")]
            else:
                result = [with_import("IsNumber", f"@IsNumber({'{}, { each: true }' if each else ''})")]
            if not each:
                if c.get("minimum") is not None:
                    result.append(with_import("Min", f"@Min({number_text(c['minimum'])})"))
                if c.get("maximum") is not None:
                    result.append(with_import("Max", f"@Max({number_text(c['maximum'])})"))
                if c.get("exclusiveMinimum") is not None:
                    imports.add(import_path(here, "src/common/validation.ts"), "GreaterThan")
                    result.append(f"@GreaterThan({number_text(c['exclusiveMinimum'])})")
                if c.get("exclusiveMaximum") is not None:
                    imports.add(import_path(here, "src/common/validation.ts"), "LessThan")
                    result.append(f"@LessThan({number_text(c['exclusiveMaximum'])})")
            return result
        if scalar == "boolean":
            cv("IsBoolean")
            return [f"@IsBoolean({opt})"]
        if scalar == "date":
            cv("Matches")
            return [f"@Matches(/^\\d{{4}}-\\d{{2}}-\\d{{2}}$/{each_after})"]
        if scalar == "datetime":
            cv("IsISO8601")
            return [f"@IsISO8601({{ strict: true }}{each_after})"]
        if scalar == "time":
            cv("Matches")
            return [f"@Matches(/^\\d{{2}}:\\d{{2}}(:\\d{{2}}(\\.\\d+)?)?$/{each_after})"]
        if scalar == "uuid":
            cv("IsUUID")
            return [f"@IsUUID({_ALL_EACH if each else ''})"]
        if scalar == "binary":
            cv("IsBase64")
            return [f"@IsBase64({'{}, { each: true }' if each else ''})"]
        if scalar == "any":
            cv("Allow")
            return ["@Allow()"]
        cv("IsString")
        return [f"@IsString({opt})"]
    if kind == "enum":
        cv("IsIn")
        if here != SHARED:
            imports.add(import_path(here, SHARED), enum_constant(type_ref["name"]))
        return [f"@IsIn({enum_constant(type_ref['name'])}{each_after})"]
    if kind == "object":
        cv("ValidateNested", "IsObject")
        imports.add("class-transformer", "Type")
        dto = f"{ts_type(type_ref['name'])}Dto"
        if here != SHARED:
            imports.add(import_path(here, SHARED), dto)
        return [*([] if each else ["@IsObject()"]), f"@ValidateNested({opt})", f"@Type(() => {dto})"]
    if kind == "array":
        cv("IsArray")
        result = ["@IsArray()"]
        if c.get("minItems") is not None:
            result.append(with_import("ArrayMinSize", f"@ArrayMinSize({number_text(c['minItems'])})"))
        if c.get("maxItems") is not None:
            result.append(with_import("ArrayMaxSize", f"@ArrayMaxSize({number_text(c['maxItems'])})"))
        if field.get("reference"):
            items = {**field, "type": type_ref["items"]}
        else:
            items = {**field, "type": type_ref["items"], "constraints": {}}
        return [*result, *_type_decorators(context, type_ref["items"], items, imports, here, True)]
    cv("IsObject")
    return ["@IsObject()"]


_ALL_EACH = "'all', { each: true }"


def _named(inner: dict) -> list[str]:
    """The names a property's type uses (enums, embedded objects), at any depth."""
    kind = inner["kind"]
    if kind in ("enum", "object"):
        return [ts_type_of(inner)]
    if kind == "array":
        return _named(inner["items"])
    if kind == "map":
        return _named(inner["value"])
    return []


def _property(context: NestContext, field: dict, shape: str, imports: TsImports, here: str) -> str:
    """One DTO property with its decorators: required, optional or nullable, and its validations."""
    decorators = _type_decorators(context, field["type"], field, imports, here, False)
    optional = shape == "update" or not field["required"]
    if field["nullable"] and optional:
        imports.add("class-validator", "IsOptional")
        decorators.insert(0, "@IsOptional()")
    elif field["nullable"]:
        imports.add("class-validator", "ValidateIf")
        decorators.insert(0, "@ValidateIf((_object, value) => value !== null)")
    elif optional:
        # It may be left out, but null is not a value it accepts
        imports.add("class-validator", "ValidateIf")
        decorators.insert(0, "@ValidateIf((_object, value) => value !== undefined)")
    if field.get("reference"):
        scalar = "number" if _reference_scalar(context, field) == "integer" else "string"
        type_text = f"{scalar}[]" if field["type"]["kind"] == "array" else scalar
    else:
        type_text = ts_type_of(field["type"])
    if here != SHARED and not field.get("reference"):
        for type_name in _named(field["type"]):
            imports.add_type(import_path(here, SHARED), type_name)
    nullable = " | null" if field["nullable"] else ""
    if shape == "create" and not field["required"] and "defaultValue" in field:
        declaration = f"{ts_property(field['wire'])}: {type_text}{nullable} = {ts_literal(field['defaultValue'])}"
    else:
        declaration = f"{ts_property(field['wire'])}{'?' if optional else '!'}: {type_text}{nullable}"
    todo = f"  // TODO: {field['todo']}\n" if field.get("todo") else ""
    decorated = "\n".join(f"  {decorator}" for decorator in decorators)
    return f"{todo}{decorated}\n  {declaration}"


def shared_file(context: NestContext) -> dict | None:
    """Enums and embedded objects shared by the resources."""
    spec = context.spec
    if not spec["enums"] and not spec["objects"]:
        return None
    imports = TsImports()
    blocks: list[str] = []
    for item in spec["enums"]:
        constant = enum_constant(item["name"])
        blocks.append(
            lines(
                f"/** Values of {item['name']}. */",
                f"export const {constant} = [{', '.join(ts_literal(value) for value in item['values'])}] as const",
                f"export type {ts_type(item['name'])} = (typeof {constant})[number]",
            )
        )
    # Classes must exist before a decorator refers to them: holders after what they hold
    ordered: list[dict] = []

    def visit(spec_object: dict, seen: frozenset[str]) -> None:
        if any(item is spec_object for item in ordered) or spec_object["name"] in seen:
            return
        for field in spec_object["fields"]:
            type_ref = field["type"]
            if type_ref["kind"] == "object":
                inner = type_ref["name"]
            elif type_ref["kind"] == "array" and type_ref["items"]["kind"] == "object":
                inner = type_ref["items"]["name"]
            else:
                inner = None
            target = next((item for item in spec["objects"] if item["name"] == inner), None) if inner else None
            if target:
                visit(target, seen | {spec_object["name"]})
        ordered.append(spec_object)

    for spec_object in spec["objects"]:
        visit(spec_object, frozenset())
    for spec_object in ordered:
        properties = [_property(context, field, "object", imports, SHARED) for field in spec_object["fields"]]
        description = spec_object.get("description")
        if description is None:
            description = f"{spec_object['name']}, embedded in the resources that hold it."
        blocks.append(
            lines(
                f"/** {description} */",
                f"export class {ts_type(spec_object['name'])}Dto {{",
                "\n\n".join(properties),
                "}",
            )
        )
    content = lines(
        ts_doc("Enums and embedded objects shared by the resources."), "", imports.render(), "", "\n\n".join(blocks)
    )
    return {"path": SHARED, "content": file_text(content)}


def dto_file(context: NestContext, resource: dict) -> dict:
    """Creation and update bodies, record and response of a resource."""
    path = resource_path(resource, "dto")
    name = names(resource)
    imports = TsImports()
    create = [
        _property(context, field, "create", imports, path) for field in shape_fields(resource["fields"], "create")
    ]
    update = [
        _property(context, field, "update", imports, path) for field in shape_fields(resource["fields"], "update")
    ]
    server = [field for field in resource["fields"] if field["access"] == "readOnly"]
    hidden = [field for field in resource["fields"] if field["access"] == "writeOnly"]
    for field in server:
        if field["type"]["kind"] in ("enum", "object"):
            imports.add_type(import_path(path, SHARED), ts_type_of(field["type"]))
    server_type = [
        f"  {ts_property(field['wire'])}: {ts_type_of(field['type'])}"
        f"{' | null' if field['nullable'] or field.get('server') == 'pending' else ''}"
        for field in server
    ]
    if not hidden:
        to_response = [
            f"export function {name['toResponse']}(record: {name['record']}): {name['type']} {{",
            "  return { ...record }",
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
    one = article(resource["singular"])
    content = lines(
        ts_doc(f"Request and response shapes of {resource['plural']}."),
        "",
        imports.render(),
        "",
        resource.get("todo") and [f"// TODO: {resource['todo']}", ""],
        f"/** Body of a request that creates or replaces {one}. */",
        f"export class {name['create']} {{",
        "\n\n".join(create),
        "}",
        "",
        f"/** Body of a request that changes part of {one}: only the fields sent change. */",
        f"export class {name['update']} {{",
        "\n\n".join(update),
        "}",
        "",
        f"/** {capitalize(one)} as the repositories keep it: what clients send and what the server fills. */",
        [f"export type {name['record']} = {name['create']} & {{", server_type, "}"]
        if server
        else f"export type {name['record']} = {name['create']}",
        "",
        f"/** {capitalize(one)} as the API returns it. */",
        f"export type {name['type']} = Omit<{name['record']}, {' | '.join(ts_string(field['wire']) for field in hidden)}>"
        if hidden
        else f"export type {name['type']} = {name['record']}",
        "",
        f"/** The response of a stored {resource['singular']}. */",
        to_response,
    )
    return {"path": path, "content": file_text(content)}


_VOWEL = re.compile(r"^[aeiou]", re.IGNORECASE)


def article(text: str) -> str:
    return f"an {text}" if _VOWEL.match(text) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
