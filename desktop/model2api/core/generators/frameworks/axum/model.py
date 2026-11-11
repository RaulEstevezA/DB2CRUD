"""Data types of the Axum project: the domain struct of each resource, the enums and embedded objects, the request
bodies and the responses. Request bodies and embedded objects carry their rules, which the API checks on the JSON
before it reads it (common/body.rs): a missing field is told from one sent as null, and every problem is reported
with its field. Mirrors web/src/core/generators/frameworks/axum/model.ts.
"""

from ....js import js_string, number_text
from ....openapi.build import always_in_response, shape_fields
from ...common.text import file_text, lines
from ...languages.rust.rust import RsUses, rs_doc, rs_header, rs_pascal, rs_string, rs_type, rs_type_of
from .context import AxumContext, article, capitalize, field_name, key_type, module_path, names, type_names

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


def _target(context: AxumContext, name: str) -> dict:
    return next(item for item in context.spec["resources"] if item["name"] == name)


def field_type(context: AxumContext, field: dict, uses: RsUses, resource: dict | None = None) -> str:
    """The Rust type of a field, without Option: keys and references use the key's type."""

    def key(target: dict) -> str:
        type_name = key_type(target)
        if type_name == "Uuid":
            uses.add("uuid::Uuid")
        return type_name

    if resource is not None and field["name"] == resource["key"]["field"]:
        return key(resource)
    if field.get("reference"):
        target = _target(context, field["reference"])
        return f"Vec<{key(target)}>" if field["type"]["kind"] == "array" else key(target)
    return rs_type_of(field["type"], uses, type_names(context))


def _json_kind(context: AxumContext, field: dict) -> str | None:
    """The kind of JSON value a field holds, as Checks names it, or None when any value goes."""
    if field.get("reference"):
        if field["type"]["kind"] == "array":
            return "List"
        target = _target(context, field["reference"])
        return "Whole" if target["key"]["type"].get("scalar") == "integer" else "Text"
    type_ref = field["type"]
    kind = type_ref["kind"]
    if kind == "array":
        return "List"
    if kind in ("map", "object"):
        return "Object"
    if kind == "enum":
        item = next((entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"]), None)
        return "Whole" if item is not None and item["valueType"] == "integer" else "Text"
    scalar = type_ref["scalar"]
    if scalar == "integer":
        return "Whole"
    if scalar in ("float", "decimal"):
        return "Number"
    if scalar == "boolean":
        return "Boolean"
    if scalar == "any":
        return None
    return "Text"


def _option(value) -> str:
    return "None" if value is None else f"Some({number_text(value)})"


def _field_rules(context: AxumContext, field: dict, required: bool) -> list[str]:
    """The Rust statements that check a field of a body or an embedded object on its JSON."""
    wire = rs_string(field["wire"])
    c = field["constraints"]
    rules: list[str] = []
    if required:
        rules.append(f"checks.required(json, {wire});")
    if not field["nullable"]:
        rules.append(f"checks.not_null(json, {wire});")
    kind = _json_kind(context, field)
    if kind:
        rules.append(f"checks.kind(json, {wire}, JsonKind::{kind});")
    if field.get("reference"):
        return rules
    type_ref = field["type"]
    scalar = type_ref.get("scalar") if type_ref["kind"] == "scalar" else None
    text = scalar == "string"
    if text and (c.get("minLength") is not None or c.get("maxLength") is not None):
        rules.append(f"checks.length(json, {wire}, {_option(c.get('minLength'))}, {_option(c.get('maxLength'))});")
    if type_ref["kind"] == "array" and (c.get("minItems") is not None or c.get("maxItems") is not None):
        rules.append(f"checks.count(json, {wire}, {_option(c.get('minItems'))}, {_option(c.get('maxItems'))});")
    if scalar in ("integer", "float", "decimal"):

        def bound(inclusive, exclusive, lower: bool):
            if exclusive is not None and (
                inclusive is None or (exclusive >= inclusive if lower else exclusive <= inclusive)
            ):
                return (f"Some({rs_string(number_text(exclusive))})", True)
            return (f"Some({rs_string(number_text(inclusive))})", False) if inclusive is not None else None

        low = bound(c.get("minimum"), c.get("exclusiveMinimum"), True)
        high = bound(c.get("maximum"), c.get("exclusiveMaximum"), False)
        if low or high:
            rules.append(
                f"checks.range(json, {wire}, {low[0] if low else 'None'}, {high[0] if high else 'None'}, "
                f"{'true' if low and low[1] else 'false'}, {'true' if high and high[1] else 'false'});"
            )

    def pattern(regex: str) -> None:
        rules.append(f"checks.pattern(json, {wire}, {rs_string(regex)});")

    if text and c.get("pattern"):
        pattern(c["pattern"])
    if text and c.get("format") == "email":
        rules.append(f"checks.email(json, {wire});")
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
            return rs_type(item["name"])
        return None

    if type_ref["kind"] == "object" and inner(type_ref):
        rules.append(f"checks.nested(json, {wire}, {inner(type_ref)}::rules);")
    if type_ref["kind"] == "array" and inner(type_ref["items"]):
        rules.append(f"checks.each(json, {wire}, {inner(type_ref['items'])}::rules);")
    return rules


def _rules_function(context: AxumContext, type_name: str, fields: list[dict], required) -> list[str]:
    """The rules function of a body or an embedded object."""
    rules = [rule for field in fields for rule in _field_rules(context, field, required(field))]
    prefix = "" if rules else "_"
    return [
        f"impl {type_name} {{",
        "    /// What the body must meet, checked on its JSON before it is read.",
        f"    pub fn rules({prefix}checks: &mut Checks, {prefix}json: &Map<String, Value>) {{",
        *(f"        {rule}" for rule in rules),
        "    }",
        "}",
    ]


def _serde_attributes(field: dict, options: list[str]) -> str | None:
    """The serde attributes of a field: its JSON name, and whether it may be missing or left out."""
    name = field_name(field).removeprefix("r#")
    every = [
        item for item in [None if name == field["wire"] else f"rename = {rs_string(field['wire'])}", *options] if item
    ]
    return f"    #[serde({', '.join(every)})]" if every else None


def enum_variants(item: dict) -> list[str]:
    """The variant of each value of an enum, unique within it."""
    used: set[str] = set()
    variants = []
    for value in item["values"]:
        base = rs_pascal(js_string(value))
        if base.startswith("_"):
            base = f"Value{base[1:]}"
        variant = base
        n = 2
        while variant in used:
            variant = f"{base}{n}"
            n += 1
        used.add(variant)
        variants.append(variant)
    return variants


def _enum_file(context: AxumContext, enum_name: str) -> dict:
    item = next(entry for entry in context.spec["enums"] if entry["name"] == enum_name)
    name = rs_type(item["name"])
    integer = item["valueType"] == "integer"
    uses = RsUses()
    if integer:
        uses.add("serde_repr::{Deserialize_repr, Serialize_repr}")
    else:
        uses.add("serde::{Deserialize, Serialize}")
    variants = list(zip(enum_variants(item), item["values"], strict=True))

    def literal(value) -> str:
        return number_text(value) if integer else rs_string(js_string(value))

    value_type = "i64" if integer else "&'static str"
    content = lines(
        *rs_header(f"Values of {item['name']}.", uses),
        rs_doc(f"Values of {item['name']}, with the value each one has in JSON."),
        [
            "#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize_repr, Deserialize_repr)]",
            "#[repr(i64)]",
        ]
        if integer
        else "#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]",
        f"pub enum {name} {{",
        [f"    {variant} = {number_text(value)}," for variant, value in variants]
        if integer
        else "\n\n".join(
            f"    #[serde(rename = {rs_string(js_string(value))})]\n    {variant}," for variant, value in variants
        ),
        "}",
        "",
        f"impl {name} {{",
        "    /// The value in JSON.",
        f"    pub fn value(self) -> {value_type} {{",
        "        self as i64"
        if integer
        else [
            "        match self {",
            [f"            Self::{variant} => {literal(value)}," for variant, value in variants],
            "        }",
        ],
        "    }",
        "",
        "    /// The variant with this value in JSON, or None when none has it.",
        f"    pub fn from_value(value: {'i64' if integer else '&str'}) -> Option<Self> {{",
        "        match value {",
        [f"            {literal(value)} => Some(Self::{variant})," for variant, value in variants],
        "            _ => None,",
        "        }",
        "    }",
        "}",
    )
    return {"path": module_path(context.layout.shared(item["name"])), "content": file_text(content)}


def _body_field(context: AxumContext, field: dict, uses: RsUses, resource: dict | None, omit_empty: bool) -> str:
    """A field of a type read from JSON: Option, possibly missing."""
    type_name = field_type(context, field, uses, resource)
    return lines(
        field.get("todo") and f"    // TODO: {field['todo']}",
        _serde_attributes(field, ["default", *(['skip_serializing_if = "Option::is_none"'] if omit_empty else [])]),
        f"    pub {field_name(field)}: Option<{type_name}>,",
    )


def _body_uses() -> RsUses:
    return RsUses().add(
        "serde::{Deserialize, Serialize}", "serde_json::{Map, Value}", "crate::common::body::{Checks, JsonKind}"
    )


def _object_file(context: AxumContext, spec_object: dict) -> dict:
    name = rs_type(spec_object["name"])
    uses = _body_uses()
    fields = [_body_field(context, field, uses, None, not always_in_response(field)) for field in spec_object["fields"]]
    content = lines(
        *rs_header(f"{spec_object['name']}, embedded in the resources that hold it.", uses),
        rs_doc(spec_object.get("description") or f"{spec_object['name']}, embedded in the resources that hold it."),
        "#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]",
        "#[serde(deny_unknown_fields)]",
        f"pub struct {name} {{",
        "\n".join(fields),
        "}",
        "",
        _rules_function(context, name, spec_object["fields"], lambda field: field["required"]),
    )
    return {"path": module_path(context.layout.shared(spec_object["name"])), "content": file_text(content)}


def shared_files(context: AxumContext) -> list[dict]:
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


def domain_file(context: AxumContext, resource: dict) -> dict:
    """The domain struct of a resource: every field, the ones clients never read included."""
    uses = RsUses()
    name = names(resource)
    fields = []
    for field in resource["fields"]:
        type_name = field_type(context, field, uses, resource)
        is_key = field["name"] == resource["key"]["field"]
        fields.append(
            lines(
                field.get("todo") and f"    // TODO: {field['todo']}",
                f"    pub {field_name(field)}: {type_name if is_key else f'Option<{type_name}>'},",
            )
        )
    description = f"{capitalize(article(resource['singular']))} as the service and its storage handle it."
    content = lines(
        *rs_header(description, uses),
        resource.get("todo") and f"// TODO: {resource['todo']}",
        rs_doc(description),
        "#[derive(Clone, Debug, Default, PartialEq)]",
        f"pub struct {name['type']} {{",
        fields,
        "}",
    )
    return {"path": module_path(context.layout.resource(resource, "model")), "content": file_text(content)}


def dto_file(context: AxumContext, resource: dict) -> dict:
    """Request bodies and response of a resource, in one module."""
    name = names(resource)
    writes = any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    uses = _body_uses() if writes else RsUses().add("serde::Serialize")
    uses.add(f"crate::{context.layout.resource(resource, 'model')}::{name['type']}")

    def body(shape: str) -> list:
        fields = shape_fields(resource["fields"], shape)
        class_name = name["create"] if shape == "create" else name["update"]
        return [
            rs_doc(
                f"Body of a request that creates or replaces {article(resource['singular'])}."
                if shape == "create"
                else f"Body of a request that changes part of {article(resource['singular'])}: only the fields sent change."
            ),
            "#[derive(Clone, Debug, Deserialize)]",
            "#[serde(deny_unknown_fields)]",
            f"pub struct {class_name} {{",
            "\n".join(_body_field(context, field, uses, resource, False) for field in fields),
            "}",
            "",
            _rules_function(context, class_name, fields, lambda field: shape == "create" and field["required"]),
            "",
        ]

    read = shape_fields(resource["fields"], "read")
    response_fields = []
    for field in read:
        type_name = field_type(context, field, uses, resource)
        if field["name"] == resource["key"]["field"]:
            response_fields.append(lines(_serde_attributes(field, []), f"    pub {field_name(field)}: {type_name},"))
            continue
        # An optional field without a value is left out of the JSON, as the contract allows
        response_fields.append(
            lines(
                _serde_attributes(
                    field, [] if always_in_response(field) else ['skip_serializing_if = "Option::is_none"']
                ),
                f"    pub {field_name(field)}: Option<{type_name}>,",
            )
        )
    # The bodies are written first: their fields add to the use declarations
    bodies = [body("create"), body("update")] if writes else None
    content = lines(
        *rs_header(f"Request bodies and responses of {resource['plural']}.", uses),
        bodies,
        rs_doc(
            f"{capitalize(article(resource['singular']))} as the API returns it: everything but what clients only send."
        ),
        "#[derive(Clone, Debug, Serialize)]",
        f"pub struct {name['response']} {{",
        response_fields,
        "}",
        "",
        f"impl From<{name['type']}> for {name['response']} {{",
        f"    fn from(item: {name['type']}) -> Self {{",
        "        Self {",
        [f"            {field_name(field)}: item.{field_name(field)}," for field in read],
        "        }",
        "    }",
        "}",
    )
    return {"path": module_path(context.layout.resource(resource, "dto")), "content": file_text(content)}
