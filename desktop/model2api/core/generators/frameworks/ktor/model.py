"""Data classes of the Ktor project: the domain class of each resource, the enums and embedded objects, the request
bodies and the responses. Request bodies and embedded objects carry their rules, which the API checks on the JSON
before it reads it (common/Bodies.kt). Mirrors web/src/core/generators/frameworks/ktor/model.ts.
"""

from ....js import js_string, number_text
from ....openapi.build import always_in_response, shape_fields
from ...common.text import file_text, lines
from ...languages.kotlin.kotlin import KtImports, kt_class, kt_constant, kt_doc, kt_header, kt_string, kt_type
from .context import (
    KtorContext,
    article,
    capitalize,
    common_package,
    key_type,
    names,
    property_name,
    source_path,
    type_names,
)

# Patterns of the text formats JSON has no type for, as in the other generators
PATTERNS = {
    "uri": r"^[a-zA-Z][a-zA-Z0-9+.-]*://\S+$",
    "uuid": r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    "date": r"^\d{4}-\d{2}-\d{2}$",
    "date-time": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$",
    "time": r"^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$",
    "duration": r"^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$",
    "binary": r"^[A-Za-z0-9+/]*={0,2}$",
}

_FORMATS = {
    "time": "time",
    "duration": "duration",
    "binary": "binary",
    "uuid": "uuid",
    "date": "date",
    "datetime": "date-time",
}


def _target(context: KtorContext, name: str) -> dict:
    return next(item for item in context.spec["resources"] if item["name"] == name)


def field_type(context: KtorContext, field: dict, imports: KtImports, resource: dict | None = None) -> str:
    """The Kotlin type of a field, not null: keys and references use the key's type."""

    def key(target: dict) -> str:
        type_name = key_type(target)
        if type_name == "JsonUuid":
            imports.add(f"{common_package(context)}.JsonUuid")
        return type_name

    if resource is not None and field["name"] == resource["key"]["field"]:
        return key(resource)
    if field.get("reference"):
        target = _target(context, field["reference"])
        return f"List<{key(target)}>" if field["type"]["kind"] == "array" else key(target)
    return kt_type(field["type"], imports, type_names(context))


def _json_kind(context: KtorContext, field: dict) -> str | None:
    """The kind of JSON value a field holds, as Checks names it, or None when any value goes."""
    if field.get("reference"):
        if field["type"]["kind"] == "array":
            return "LIST"
        return "WHOLE" if _target(context, field["reference"])["key"]["type"]["scalar"] == "integer" else "TEXT"
    type_ref = field["type"]
    kind = type_ref["kind"]
    if kind == "array":
        return "LIST"
    if kind in ("map", "object"):
        return "OBJECT"
    if kind == "enum":
        item = next((entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"]), None)
        return "WHOLE" if item is not None and item["valueType"] == "integer" else "TEXT"
    scalar = type_ref["scalar"]
    if scalar == "integer":
        return "WHOLE"
    if scalar in ("float", "decimal"):
        return "NUMBER"
    if scalar == "boolean":
        return "BOOLEAN"
    if scalar == "any":
        return None
    return "TEXT"


def _optional_number(value) -> str:
    return number_text(value) if value is not None else "null"


def _field_rules(context: KtorContext, field: dict, required: bool) -> list[str]:
    """The Kotlin statements that check a field of a body or an embedded object on its JSON."""
    wire = kt_string(field["wire"])
    c = field["constraints"]
    rules: list[str] = []
    if required:
        rules.append(f"checks.required(json, {wire})")
    if not field["nullable"]:
        rules.append(f"checks.notNull(json, {wire})")
    kind = _json_kind(context, field)
    if kind:
        rules.append(f"checks.kind(json, {wire}, JsonKind.{kind})")
    if field.get("reference"):
        return rules
    type_ref = field["type"]
    scalar = type_ref["scalar"] if type_ref["kind"] == "scalar" else None
    text = scalar == "string"
    if text and (c.get("minLength") is not None or c.get("maxLength") is not None):
        rules.append(
            f"checks.length(json, {wire}, {_optional_number(c.get('minLength'))}, {_optional_number(c.get('maxLength'))})"
        )
    if type_ref["kind"] == "array" and (c.get("minItems") is not None or c.get("maxItems") is not None):
        rules.append(
            f"checks.count(json, {wire}, {_optional_number(c.get('minItems'))}, {_optional_number(c.get('maxItems'))})"
        )
    if scalar in ("integer", "float", "decimal"):

        def bound(inclusive, exclusive, lower: bool):
            if exclusive is not None and (
                inclusive is None or (exclusive >= inclusive if lower else exclusive <= inclusive)
            ):
                return (kt_string(number_text(exclusive)), True)
            return (kt_string(number_text(inclusive)), False) if inclusive is not None else None

        low = bound(c.get("minimum"), c.get("exclusiveMinimum"), True)
        high = bound(c.get("maximum"), c.get("exclusiveMaximum"), False)
        if low or high:
            rules.append(
                f"checks.range(json, {wire}, {low[0] if low else 'null'}, {high[0] if high else 'null'}, "
                f"{'true' if low and low[1] else 'false'}, {'true' if high and high[1] else 'false'})"
            )

    def pattern(regex: str) -> None:
        rules.append(f"checks.pattern(json, {wire}, Regex({kt_string(regex)}))")

    if text and c.get("pattern"):
        pattern(c["pattern"])
    if text and c.get("format") == "email":
        rules.append(f"checks.email(json, {wire})")
    elif text and c.get("format") and c["format"] in PATTERNS:
        pattern(PATTERNS[c["format"]])
    if scalar in _FORMATS:
        pattern(PATTERNS[_FORMATS[scalar]])

    def inner(item: dict) -> str | None:
        if item["kind"] == "object" and any(
            spec_object["name"] == item["name"] for spec_object in context.spec["objects"]
        ):
            return kt_class(item["name"])
        return None

    if type_ref["kind"] == "object" and inner(type_ref):
        rules.append(f"checks.nested(json, {wire}, {inner(type_ref)}::rules)")
    if type_ref["kind"] == "array" and inner(type_ref["items"]):
        rules.append(f"checks.each(json, {wire}, {inner(type_ref['items'])}::rules)")
    return rules


def _rules_function(context: KtorContext, fields: list[dict], required) -> list[str]:
    """The rules function of a body or an embedded object, in its companion object."""
    rules = [rule for field in fields for rule in _field_rules(context, field, required(field))]
    return [
        "    companion object {",
        "        /** What the body must meet, checked on its JSON before it is read. */",
        "        fun rules(checks: Checks, json: JsonObject) {",
        *(f"            {rule}" for rule in rules),
        "        }",
        "    }",
    ]


def _serial_name(field: dict, imports: KtImports) -> str | None:
    """@SerialName("postal_code") when the JSON name is not the Kotlin property."""
    if property_name(field) == field["wire"]:
        return None
    imports.add("kotlinx.serialization.SerialName")
    return f"@SerialName({kt_string(field['wire'])})"


def _serializable_property(field: dict, type_name: str, imports: KtImports, default_null: bool) -> str:
    """A property of a serializable class: @SerialName("x") val x: T? = null."""
    serial = _serial_name(field, imports)
    return f"    {serial + ' ' if serial else ''}val {property_name(field)}: {type_name}?{' = null' if default_null else ''},"


def _enum_file(context: KtorContext, enum_name: str) -> dict:
    item = next(entry for entry in context.spec["enums"] if entry["name"] == enum_name)
    package = context.layout.shared()
    name = kt_class(item["name"])
    integer = item["valueType"] == "integer"
    imports = KtImports(package).add("kotlinx.serialization.Serializable")
    used: set[str] = set()
    entries = []
    for value in item["values"]:
        constant = kt_constant(value)
        n = 2
        while constant in used:
            constant = f"{kt_constant(value)}_{n}"
            n += 1
        used.add(constant)
        entries.append((constant, value))
    if integer:
        imports.add(f"{common_package(context)}.NumberEnumSerializer")
    else:
        imports.add("kotlinx.serialization.SerialName")
    last = len(entries) - 1
    if integer:
        body = [
            f"    {constant}({number_text(value)}L){';' if index == last else ','}"
            for index, (constant, value) in enumerate(entries)
        ]
    else:
        body = [
            f"    @SerialName({kt_string(js_string(value))})\n    {constant}({kt_string(js_string(value))}){';' if index == last else ','}"
            for index, (constant, value) in enumerate(entries)
        ]
    value_type = "Long" if integer else "String"
    content = lines(
        *kt_header(package, imports),
        kt_doc(f"Values of {item['name']}, with the value each one has in JSON."),
        f"@Serializable(with = {name}.Serializer::class)" if integer else "@Serializable",
        f"enum class {name}(val value: {value_type}) {{",
        body if integer else "\n\n".join(body),
        "",
        integer
        and [f"    object Serializer : NumberEnumSerializer<{name}>({kt_string(name)}, entries, {name}::value)", ""],
        "    companion object {",
        "        /** The entry with this value in JSON, or null when none has it. */",
        f"        fun fromValue(value: {value_type}): {name}? = entries.firstOrNull {{ it.value == value }}",
        "    }",
        "}",
    )
    return {"path": source_path(package, name), "content": file_text(content)}


def _body_imports(context: KtorContext, package: str) -> KtImports:
    return KtImports(package).add(
        "kotlinx.serialization.Serializable",
        "kotlinx.serialization.json.JsonObject",
        f"{common_package(context)}.Checks",
        f"{common_package(context)}.JsonKind",
    )


def _object_file(context: KtorContext, spec_object: dict) -> dict:
    package = context.layout.shared()
    name = kt_class(spec_object["name"])
    imports = _body_imports(context, package)
    properties = [
        _serializable_property(field, field_type(context, field, imports), imports, True)
        for field in spec_object["fields"]
    ]
    description = spec_object.get("description")
    content = lines(
        *kt_header(package, imports),
        kt_doc(
            description
            if description is not None
            else f"{spec_object['name']}, embedded in the resources that hold it."
        ),
        "@Serializable",
        f"data class {name}(",
        properties,
        ") {",
        _rules_function(context, spec_object["fields"], lambda field: field["required"]),
        "}",
    )
    return {"path": source_path(package, name), "content": file_text(content)}


def shared_files(context: KtorContext) -> list[dict]:
    """Enums and embedded objects shared by the resources."""
    return [
        *(_enum_file(context, item["name"]) for item in context.spec["enums"]),
        *(_object_file(context, spec_object) for spec_object in context.spec["objects"]),
    ]


def stored_as_json(field: dict) -> bool:
    """Whether a field is stored as JSON in a table: embedded objects, lists, maps and values of any shape."""
    type_ref = field["type"]
    return type_ref["kind"] in ("object", "array", "map") or (
        type_ref["kind"] == "scalar" and type_ref["scalar"] == "any"
    )


def domain_file(context: KtorContext, resource: dict) -> dict:
    """The domain class of a resource: every field, the ones clients never read included."""
    package = context.layout.resource(resource, "model")
    imports = KtImports(package)
    name = names(resource)
    properties = []
    for field in resource["fields"]:
        type_name = field_type(context, field, imports, resource)
        todo = f"    // TODO: {field['todo']}\n" if field.get("todo") else ""
        if field["name"] != resource["key"]["field"]:
            properties.append(f"{todo}    var {property_name(field)}: {type_name}? = null,")
            continue
        # The key always has a value: the storage assigns it, or the client sends it
        initial = "0L" if type_name == "Long" else '""' if type_name == "String" else "JsonUuid(0L, 0L)"
        properties.append(f"{todo}    var {property_name(field)}: {type_name} = {initial},")
    content = lines(
        *kt_header(package, imports),
        resource.get("todo") and f"// TODO: {resource['todo']}",
        kt_doc(f"{capitalize(article(resource['singular']))} as the service and its storage handle it."),
        f"data class {name['type']}(",
        properties,
        ")",
    )
    return {"path": source_path(package, name["type"]), "content": file_text(content)}


def _body_file(context: KtorContext, resource: dict, shape: str) -> dict:
    package = context.layout.resource(resource, "dto")
    imports = _body_imports(context, package)
    name = names(resource)
    class_name = name["create"] if shape == "create" else name["update"]
    fields = shape_fields(resource["fields"], shape)
    properties = [
        _serializable_property(field, field_type(context, field, imports, resource), imports, True) for field in fields
    ]
    if shape == "create":
        description = f"Body of a request that creates or replaces {article(resource['singular'])}."
    else:
        description = (
            f"Body of a request that changes part of {article(resource['singular'])}: only the fields sent change."
        )
    content = lines(
        *kt_header(package, imports),
        kt_doc(description),
        "@Serializable",
        f"data class {class_name}(",
        properties,
        ") {",
        _rules_function(context, fields, lambda field: shape == "create" and field["required"]),
        "}",
    )
    return {"path": source_path(package, class_name), "content": file_text(content)}


def _response_file(context: KtorContext, resource: dict) -> dict:
    """The response of a resource: a required field is always written, an optional one only when it has a value."""
    package = context.layout.resource(resource, "dto")
    imports = KtImports(package).add("kotlinx.serialization.Serializable")
    name = names(resource)
    imports.add(f"{context.layout.resource(resource, 'model')}.{name['type']}")
    fields = shape_fields(resource["fields"], "read")
    properties = []
    for field in fields:
        type_name = field_type(context, field, imports, resource)
        if field["name"] == resource["key"]["field"]:
            serial = _serial_name(field, imports)
            properties.append(f"    {serial + ' ' if serial else ''}val {property_name(field)}: {type_name},")
        else:
            properties.append(_serializable_property(field, type_name, imports, not always_in_response(field)))
    content = lines(
        *kt_header(package, imports),
        kt_doc(f"{capitalize(article(resource['singular']))} as the API returns it."),
        "@Serializable",
        f"data class {name['response']}(",
        properties,
        ") {",
        "    companion object {",
        f"        /** The response of a stored {resource['singular']}: everything but what clients only send. */",
        f"        fun from(item: {name['type']}) = {name['response']}(",
        [f"            {property_name(field)} = item.{property_name(field)}," for field in fields],
        "        )",
        "    }",
        "}",
    )
    return {"path": source_path(package, name["response"]), "content": file_text(content)}


def dto_files(context: KtorContext, resource: dict) -> list[dict]:
    """Request bodies and response of a resource."""
    files = [_response_file(context, resource)]
    if any(endpoint["input"] != "none" for endpoint in resource["endpoints"]):
        files.extend([_body_file(context, resource, "create"), _body_file(context, resource, "update")])
    return files


def serializer_of(context: KtorContext, field: dict, imports: KtImports) -> str:
    """A serializer expression for a field's type, for JSON columns: ListSerializer(OrderLine.serializer())."""

    def builtin(name: str) -> str:
        imports.add("kotlinx.serialization.builtins.serializer")
        return f"{name}.serializer()"

    def helper(name: str) -> str:
        imports.add(f"{common_package(context)}.{name}")
        return name

    def of(type_ref: dict) -> str:
        kind = type_ref["kind"]
        if kind == "array":
            imports.add("kotlinx.serialization.builtins.ListSerializer")
            return f"ListSerializer({of(type_ref['items'])})"
        if kind == "map":
            imports.add("kotlinx.serialization.builtins.MapSerializer", "kotlinx.serialization.builtins.serializer")
            return f"MapSerializer(String.serializer(), {of(type_ref['value'])})"
        if kind in ("object", "enum"):
            imports.add(type_names(context).shared(type_ref["name"]))
            return f"{kt_class(type_ref['name'])}.serializer()"
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return builtin("Long" if type_ref.get("bits") == 64 else "Int")
        if scalar == "float":
            return builtin("Double")
        if scalar == "boolean":
            return builtin("Boolean")
        if scalar == "decimal":
            return helper("DecimalSerializer")
        if scalar == "date":
            return helper("DateSerializer")
        if scalar == "datetime":
            return helper("DateTimeSerializer")
        if scalar == "uuid":
            return helper("UuidSerializer")
        if scalar == "any":
            imports.add("kotlinx.serialization.json.JsonElement")
            return "JsonElement.serializer()"
        return builtin("String")

    if field.get("reference"):
        key = key_type(_target(context, field["reference"]))
        imports.add("kotlinx.serialization.builtins.ListSerializer")
        if key == "JsonUuid":
            imports.add(f"{common_package(context)}.UuidSerializer")
            return "ListSerializer(UuidSerializer)"
        imports.add("kotlinx.serialization.builtins.serializer")
        return f"ListSerializer({key}.serializer())"
    return of(field["type"])
