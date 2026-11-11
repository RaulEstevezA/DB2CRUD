"""Data types of the Vapor project: the domain struct of each resource, the enums and embedded objects, the request
bodies and the responses. Request bodies and embedded objects carry their rules, which the API checks on the JSON
before it decodes it (Common/Body.swift): a missing field is told from one sent as null, unknown fields are rejected
and every problem is reported with its field. Mirrors web/src/core/generators/frameworks/vapor/model.ts.
"""

from ....js import js_string, number_text
from ....openapi.build import always_in_response, shape_fields
from ...common.text import file_text, lines
from ...languages.swift.swift import sw_doc, sw_header, sw_name, sw_string, sw_type, sw_type_of
from ..axum.model import PATTERNS
from .context import VaporContext, article, capitalize, key_type, names, property_name, source_path, type_names


def _target(context: VaporContext, name: str) -> dict:
    return next(item for item in context.spec["resources"] if item["name"] == name)


def field_type(context: VaporContext, field: dict, resource: dict | None = None) -> str:
    """The Swift type of a field, without ?: keys and references use the key's type."""
    if resource is not None and field["name"] == resource["key"]["field"]:
        return key_type(resource)
    if field.get("reference"):
        key = key_type(_target(context, field["reference"]))
        return f"[{key}]" if field["type"]["kind"] == "array" else key
    return sw_type_of(field["type"], type_names)


def encoded_value(context: VaporContext, field: dict, value: str, resource: dict | None = None) -> str:
    """The value of a field as JSON writes it: UUIDs in lower case."""
    type_name = field_type(context, field, resource)
    if resource is not None and field["name"] == resource["key"]["field"]:
        return f"{value}.uuidString.lowercased()" if type_name == "UUID" else value
    if type_name == "UUID":
        return f"jsonUUID({value})"
    if type_name == "[UUID]":
        return f"jsonUUIDs({value})"
    return value


def _json_kind(context: VaporContext, field: dict) -> str | None:
    """The kind of JSON value a field holds, as Checks names it, or None when any value goes."""
    if field.get("reference"):
        if field["type"]["kind"] == "array":
            return "list"
        return "whole" if _target(context, field["reference"])["key"]["type"].get("scalar") == "integer" else "text"
    type_ref = field["type"]
    kind = type_ref["kind"]
    if kind == "array":
        return "list"
    if kind in ("map", "object"):
        return "object"
    if kind == "enum":
        item = next((entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"]), None)
        return "whole" if item is not None and item["valueType"] == "integer" else "text"
    scalar = type_ref["scalar"]
    if scalar == "integer":
        return "whole"
    if scalar in ("float", "decimal"):
        return "number"
    if scalar == "boolean":
        return "boolean"
    if scalar == "any":
        return None
    return "text"


def _option(value) -> str:
    return "nil" if value is None else number_text(value)


def _field_rules(context: VaporContext, field: dict, required: bool) -> list[str]:
    """The Swift statements that check a field of a body or an embedded object on its JSON."""
    wire = sw_string(field["wire"])
    c = field["constraints"]
    rules: list[str] = []
    if required:
        rules.append(f"checks.required(json, {wire})")
    if not field["nullable"]:
        rules.append(f"checks.notNull(json, {wire})")
    kind = _json_kind(context, field)
    if kind:
        rules.append(f"checks.kind(json, {wire}, .{kind})")
    if field.get("reference"):
        return rules
    type_ref = field["type"]
    scalar = type_ref.get("scalar") if type_ref["kind"] == "scalar" else None
    text = scalar == "string"
    if text and (c.get("minLength") is not None or c.get("maxLength") is not None):
        rules.append(
            f"checks.length(json, {wire}, min: {_option(c.get('minLength'))}, max: {_option(c.get('maxLength'))})"
        )
    if type_ref["kind"] == "array" and (c.get("minItems") is not None or c.get("maxItems") is not None):
        rules.append(
            f"checks.count(json, {wire}, min: {_option(c.get('minItems'))}, max: {_option(c.get('maxItems'))})"
        )
    if scalar in ("integer", "float", "decimal"):

        def bound(inclusive, exclusive, lower: bool):
            if exclusive is not None and (
                inclusive is None or (exclusive >= inclusive if lower else exclusive <= inclusive)
            ):
                return (number_text(exclusive), True)
            return (number_text(inclusive), False) if inclusive is not None else None

        low = bound(c.get("minimum"), c.get("exclusiveMinimum"), True)
        high = bound(c.get("maximum"), c.get("exclusiveMaximum"), False)
        if low or high:
            rules.append(
                f"checks.range(json, {wire}, min: {low[0] if low else 'nil'}, max: {high[0] if high else 'nil'}, "
                f"minExclusive: {'true' if low and low[1] else 'false'}, maxExclusive: {'true' if high and high[1] else 'false'})"
            )

    def pattern(regex: str) -> None:
        rules.append(f"checks.pattern(json, {wire}, {sw_string(regex)})")

    if text and c.get("pattern"):
        pattern(c["pattern"])
    if text and c.get("format") == "email":
        rules.append(f"checks.email(json, {wire})")
    elif text and c.get("format") and c["format"] in PATTERNS:
        pattern(PATTERNS[c["format"]])
    formats = {
        "time": "time",
        "duration": "duration",
        "binary": "binary",
        "uuid": "uuid",
        "date": "date",
        "datetime": "date-time",
    }
    if scalar in formats:
        pattern(PATTERNS[formats[scalar]])

    def inner(item: dict) -> str | None:
        if item["kind"] == "object" and any(entry["name"] == item["name"] for entry in context.spec["objects"]):
            return sw_type(item["name"])
        return None

    if type_ref["kind"] == "object" and inner(type_ref):
        rules.append(f"checks.nested(json, {wire}, {inner(type_ref)}.rules)")
    if type_ref["kind"] == "array" and inner(type_ref["items"]):
        rules.append(f"checks.each(json, {wire}, {inner(type_ref['items'])}.rules)")
    return rules


def _rules_function(context: VaporContext, fields: list[dict], required) -> list[str]:
    """The rules function of a body or an embedded object: its fields, and nothing else."""
    wires = ", ".join(sw_string(field["wire"]) for field in fields)
    return [
        "    /// What the body must meet, checked on its JSON before it is decoded.",
        "    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {",
        f"        checks.only(json, [{wires}])",
        *(f"        {rule}" for field in fields for rule in _field_rules(context, field, required(field))),
        "    }",
    ]


def _coding_keys(fields: list[dict]) -> list[str]:
    """The coding keys of a type: each property with its JSON name."""
    cases = []
    for field in fields:
        name = property_name(field)
        if name.replace("`", "") == field["wire"]:
            cases.append(f"        case {name}")
        else:
            cases.append(f"        case {name} = {sw_string(field['wire'])}")
    return ["    enum CodingKeys: String, CodingKey {", *cases, "    }"]


def _encode_function(context: VaporContext, fields: list[dict], source: str, resource: dict | None = None) -> list[str]:
    """The encode(to:) of a type: optional fields without a value are left out, unless the contract always has them."""
    statements = []
    for field in fields:
        value = encoded_value(context, field, f"{source}{property_name(field)}", resource)
        always = (resource is not None and field["name"] == resource["key"]["field"]) or always_in_response(field)
        method = "encode" if always else "encodeIfPresent"
        statements.append(f"        try container.{method}({value}, forKey: .{property_name(field)})")
    return [
        "    func encode(to encoder: any Encoder) throws {",
        "        var container = encoder.container(keyedBy: CodingKeys.self)"
        if fields
        else "        _ = encoder.container(keyedBy: CodingKeys.self)",
        *statements,
        "    }",
    ]


def enum_cases(values: list) -> list[str]:
    """The case of each value of an enum, unique within it."""
    used: set[str] = set()
    cases = []
    for value in values:
        base = sw_name(js_string(value))
        name = base
        n = 2
        while name in used:
            name = f"`{base[1:-1]}{n}`" if base.startswith("`") else f"{base}{n}"
            n += 1
        used.add(name)
        cases.append(name)
    return cases


def _enum_file(context: VaporContext, enum_name: str) -> dict:
    item = next(entry for entry in context.spec["enums"] if entry["name"] == enum_name)
    name = sw_type(item["name"])
    integer = item["valueType"] == "integer"
    cases = enum_cases(item["values"])
    content = lines(
        *sw_header(f"Values of {item['name']}.", []),
        sw_doc(f"Values of {item['name']}, with the value each one has in JSON."),
        f"enum {name}: {'Int64' if integer else 'String'}, Codable, Sendable, CaseIterable, Comparable {{",
        [
            f"    case {cases[index]} = {number_text(value) if integer else sw_string(js_string(value))}"
            for index, value in enumerate(item["values"])
        ],
        "",
        f"    static func < (lhs: {name}, rhs: {name}) -> Bool {{",
        "        lhs.rawValue < rhs.rawValue",
        "    }",
        "}",
    )
    return {"path": source_path(context.layout.shared, name), "content": file_text(content)}


def _object_file(context: VaporContext, spec_object: dict) -> dict:
    name = sw_type(spec_object["name"])
    fields = [
        lines(
            field.get("todo") and f"    // TODO: {field['todo']}",
            f"    var {property_name(field)}: {field_type(context, field)}?",
        )
        for field in spec_object["fields"]
    ]
    content = lines(
        *sw_header(f"{spec_object['name']}, embedded in the resources that hold it.", ["Foundation"]),
        sw_doc(spec_object.get("description") or f"{spec_object['name']}, embedded in the resources that hold it."),
        f"struct {name}: Codable, Sendable, Equatable {{",
        fields,
        "",
        _coding_keys(spec_object["fields"]),
        "",
        _encode_function(context, spec_object["fields"], ""),
        "",
        _rules_function(context, spec_object["fields"], lambda field: field["required"]),
        "}",
    )
    return {"path": source_path(context.layout.shared, name), "content": file_text(content)}


def shared_files(context: VaporContext) -> list[dict]:
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


def empty_key(resource: dict) -> str:
    """The value a new item has in its key before it is stored."""
    type_name = key_type(resource)
    return "0" if type_name == "Int64" else "UUID()" if type_name == "UUID" else '""'


def domain_file(context: VaporContext, resource: dict) -> dict:
    """The domain struct of a resource: every field, the ones clients never read included."""
    name = names(resource)
    fields = []
    for field in resource["fields"]:
        type_name = field_type(context, field, resource)
        key = field["name"] == resource["key"]["field"]
        declared = f"{type_name} = {empty_key(resource)}" if key else f"{type_name}?"
        fields.append(
            lines(field.get("todo") and f"    // TODO: {field['todo']}", f"    var {property_name(field)}: {declared}")
        )
    description = f"{capitalize(article(resource['singular']))} as the service and its storage handle it."
    content = lines(
        *sw_header(description, ["Foundation"]),
        resource.get("todo") and f"// TODO: {resource['todo']}",
        sw_doc(description),
        f"struct {name['type']}: Sendable, Equatable {{",
        fields,
        "}",
    )
    return {
        "path": source_path(context.layout.resource(resource, "model"), name["type"]),
        "content": file_text(content),
    }


def dto_file(context: VaporContext, resource: dict) -> dict:
    """Request bodies and response of a resource, in one file."""
    name = names(resource)
    writes = any(endpoint["input"] != "none" for endpoint in resource["endpoints"])

    def body(shape: str) -> list:
        fields = shape_fields(resource["fields"], shape)
        if shape == "create":
            doc = f"Body of a request that creates or replaces {article(resource['singular'])}."
        else:
            doc = (
                f"Body of a request that changes part of {article(resource['singular'])}: only the fields sent change."
            )
        return [
            sw_doc(doc),
            f"struct {name['create'] if shape == 'create' else name['update']}: Decodable, Sendable {{",
            [f"    var {property_name(field)}: {field_type(context, field, resource)}?" for field in fields],
            "",
            _coding_keys(fields),
            "",
            _rules_function(context, fields, lambda field: shape == "create" and field["required"]),
            "}",
            "",
        ]

    read = shape_fields(resource["fields"], "read")
    content = lines(
        *sw_header(f"Request bodies and responses of {resource['plural']}.", ["Foundation"]),
        writes and [body("create"), body("update")],
        sw_doc(
            f"{capitalize(article(resource['singular']))} as the API returns it: everything but what clients only send."
        ),
        f"struct {name['response']}: Encodable, Sendable {{",
        f"    let item: {name['type']}",
        "",
        f"    init(_ item: {name['type']}) {{",
        "        self.item = item",
        "    }",
        "",
        _coding_keys(read),
        "",
        _encode_function(context, read, "item.", resource),
        "}",
    )
    return {
        "path": source_path(context.layout.resource(resource, "dto"), f"{name['type']}DTOs"),
        "content": file_text(content),
    }
