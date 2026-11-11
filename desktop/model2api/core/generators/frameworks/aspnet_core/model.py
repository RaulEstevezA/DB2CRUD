"""Data classes of the ASP.NET Core project: the domain class of each resource (an Entity Framework Core entity when
EF Core is chosen), the enums and embedded objects, the request bodies (which remember which fields were sent, to
tell a missing field from an explicit null) and the response records. Mirrors
web/src/core/generators/frameworks/aspnetCore/model.ts.
"""

from ....js import js_string, number_text
from ....openapi.build import always_in_response, shape_fields
from ...common.text import file_text, lines
from ...languages.csharp.csharp import CsUsings, cs_class, cs_doc, cs_header, cs_number, cs_pascal, cs_string, cs_type
from .context import (
    AspNetContext,
    article,
    capitalize,
    common_namespace,
    key_type,
    names,
    namespace_of,
    property_name,
    shared_names,
    source_path,
)

# Patterns of the text formats .NET has no attribute for, as in the other generators
PATTERNS = {
    "uri": r"^[a-zA-Z][a-zA-Z0-9+.-]*://\S+$",
    "uuid": r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    "date": r"^\d{4}-\d{2}-\d{2}$",
    "date-time": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$",
    "time": r"^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$",
    "duration": r"^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$",
}


def field_type(
    context: AspNetContext, field: dict, usings: CsUsings, resource: dict | None = None, nullable: bool = True
) -> str:
    """The C# type of a field: keys and references to keys use the key's type, whole numbers as long. nullable
    says whether the key itself may be null (in a request body it may be missing)."""
    if resource is not None and field["name"] == resource["key"]["field"]:
        return f"{key_type(resource)}{'?' if nullable else ''}"
    if field.get("reference"):
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        return f"List<{key_type(target)}>?" if field["type"]["kind"] == "array" else f"{key_type(target)}?"
    return cs_type(field["type"], usings, shared_names(context))


def _lower_bound(minimum, exclusive):
    if exclusive is not None and (minimum is None or exclusive >= minimum):
        return (exclusive, True)
    return (minimum, False) if minimum is not None else None


def _upper_bound(maximum, exclusive):
    if exclusive is not None and (maximum is None or exclusive <= maximum):
        return (exclusive, True)
    return (maximum, False) if maximum is not None else None


def validations(context: AspNetContext, field: dict, usings: CsUsings) -> list[str]:
    """Validation attributes of a field's declared validations (DataAnnotations, and Pattern from Common)."""
    c = field["constraints"]
    result: list[str] = []

    def annotations() -> None:
        usings.add("System.ComponentModel.DataAnnotations")

    def pattern(regex: str) -> None:
        usings.add(common_namespace(context))
        result.append(f"[Pattern({cs_string(regex)})]")

    type_ref = None if field.get("reference") else field["type"]
    scalar = type_ref["scalar"] if type_ref is not None and type_ref["kind"] == "scalar" else None
    text = scalar == "string"
    is_list = field["type"]["kind"] == "array"
    low_length = c.get("minItems") if is_list else c.get("minLength") if text else None
    high_length = c.get("maxItems") if is_list else c.get("maxLength") if text else None
    if low_length is not None:
        annotations()
        result.append(f"[MinLength({number_text(low_length)})]")
    if high_length is not None:
        annotations()
        result.append(f"[MaxLength({number_text(high_length)})]")
    if scalar in ("integer", "float", "decimal"):
        low = _lower_bound(c.get("minimum"), c.get("exclusiveMinimum"))
        high = _upper_bound(c.get("maximum"), c.get("exclusiveMaximum"))
        if low or high:
            annotations()
            options = [
                low and low[1] and "MinimumIsExclusive = true",
                high and high[1] and "MaximumIsExclusive = true",
            ]
            bounds = [
                cs_number(low[0], "double") if low else "double.MinValue",
                cs_number(high[0], "double") if high else "double.MaxValue",
            ]
            result.append(f"[Range({', '.join([*bounds, *(item for item in options if item)])})]")
    if text and c.get("pattern"):
        pattern(c["pattern"])
    if text and c.get("format") == "email":
        annotations()
        result.append("[EmailAddress]")
    elif text and c.get("format") and c["format"] in PATTERNS:
        pattern(PATTERNS[c["format"]])
    if scalar in ("time", "duration"):
        pattern(PATTERNS[scalar])
    return result


def _json_attributes(field: dict, usings: CsUsings, optional: bool) -> list[str]:
    """The JSON name of a property; optional ones are left out of answers when they have no value."""
    usings.add("System.Text.Json.Serialization")
    return [
        f"[JsonPropertyName({cs_string(field['wire'])})]",
        *(["[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]"] if optional else []),
    ]


def _enum_members(name: str, values: list) -> list[str]:
    """The C# members of an enum: PascalCase names, unique, never the name of the enum."""
    used: set[str] = set()
    members = []
    for value in values:
        base = cs_pascal(js_string(value))
        if base.startswith("_"):
            base = f"Value{base[1:]}"
        if base == name:
            base = f"{base}Value"
        member = base
        n = 2
        while member in used:
            member = f"{base}{n}"
            n += 1
        used.add(member)
        members.append(member)
    return members


def enum_member(context: AspNetContext, enum_name: str, value) -> str:
    """The member of an enum value, as _enum_members names it."""
    item = next(entry for entry in context.spec["enums"] if entry["name"] == enum_name)
    return _enum_members(cs_class(item["name"]), item["values"])[item["values"].index(value)]


def _enum_file(context: AspNetContext, enum_name: str) -> dict:
    item = next(entry for entry in context.spec["enums"] if entry["name"] == enum_name)
    relative = context.layout.shared()
    namespace = namespace_of(context, relative)
    name = cs_class(item["name"])
    integer = item["valueType"] == "integer"
    usings = CsUsings(namespace).add("System.Text.Json.Serialization", common_namespace(context))
    members = []
    for index, member in enumerate(_enum_members(name, item["values"])):
        value = item["values"][index]
        if integer:
            members.append(f"    {member} = {number_text(value)},")
        else:
            members.append(f"    [JsonStringEnumMemberName({cs_string(js_string(value))})]\n    {member},")
    converter = "NumberEnumConverter" if integer else "TextEnumConverter"
    content = lines(
        *cs_header(namespace, usings),
        cs_doc(f"Values of {item['name']}, with the value each one has in JSON."),
        f"[JsonConverter(typeof({converter}<{name}>))]",
        f"public enum {name}",
        "{",
        members if integer else "\n\n".join(members),
        "}",
    )
    return {"path": source_path(context, relative, name), "content": file_text(content)}


def _presence_checks(fields: list[dict], owner: str, required) -> list[str]:
    """Presence checks of a request body: the fields it must carry, and the ones that cannot be null."""
    must_have = [cs_string(field["wire"]) for field in fields if required(field)]
    not_null = [
        f"({cs_string(field['wire'])}, {property_name(field, owner)})" for field in fields if not field["nullable"]
    ]
    result: list[str] = []
    if must_have:
        result.extend(["", f"    protected override string[] RequiredFields => [{', '.join(must_have)}];"])
    if not_null:
        result.extend(
            [
                "",
                f"    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [{', '.join(not_null)}];",
            ]
        )
    return result


def _tracked_property(
    context: AspNetContext, field: dict, owner: str, type_name: str, usings: CsUsings, optional: bool
) -> str:
    """A property of a request body that records that it was sent."""
    attributes = [*_json_attributes(field, usings, optional), *validations(context, field, usings)]
    wire = cs_string(field["wire"])
    return lines(
        field.get("todo") and f"    // TODO: {field['todo']}",
        [f"    {attribute}" for attribute in attributes],
        f"    public {type_name} {property_name(field, owner)} {{ get; set {{ field = value; Mark({wire}); }} }}",
    )


def _object_file(context: AspNetContext, spec_object: dict) -> dict:
    relative = context.layout.shared()
    namespace = namespace_of(context, relative)
    name = cs_class(spec_object["name"])
    usings = CsUsings(namespace).add(common_namespace(context))
    properties = [
        _tracked_property(
            context, field, name, field_type(context, field, usings), usings, not always_in_response(field)
        )
        for field in spec_object["fields"]
    ]
    content = lines(
        *cs_header(namespace, usings),
        cs_doc(
            spec_object["description"]
            if spec_object.get("description") is not None
            else f"{spec_object['name']}, embedded in the resources that hold it."
        ),
        f"public sealed class {name} : Payload",
        "{",
        "\n\n".join(properties),
        _presence_checks(spec_object["fields"], name, lambda field: field["required"]),
        "}",
    )
    return {"path": source_path(context, relative, name), "content": file_text(content)}


def shared_files(context: AspNetContext) -> list[dict]:
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


def domain_file(context: AspNetContext, resource: dict) -> dict:
    """The domain class of a resource: every field, the ones clients never read included."""
    relative = context.layout.resource(resource, "model")
    namespace = namespace_of(context, relative)
    usings = CsUsings(namespace)
    name = names(resource)
    properties = []
    for field in resource["fields"]:
        is_key = field["name"] == resource["key"]["field"]
        type_name = field_type(context, field, usings, resource, False)
        initial = ' = "";' if is_key and type_name == "string" else ""
        properties.append(
            lines(
                field.get("todo") and f"    // TODO: {field['todo']}",
                f"    public {type_name} {property_name(field, name['type'])} {{ get; set; }}{initial}",
            )
        )
    content = lines(
        *cs_header(namespace, usings),
        resource.get("todo") and f"// TODO: {resource['todo']}",
        cs_doc(f"{capitalize(article(resource['singular']))} as the service and its storage handle it."),
        f"public class {name['type']}",
        "{",
        "\n\n".join(properties),
        "}",
    )
    return {"path": source_path(context, relative, name["type"]), "content": file_text(content)}


def _payload_class(context: AspNetContext, resource: dict, shape: str) -> dict:
    relative = context.layout.resource(resource, "dto")
    namespace = namespace_of(context, relative)
    usings = CsUsings(namespace).add(common_namespace(context))
    name = names(resource)
    class_name = name["create"] if shape == "create" else name["update"]
    fields = shape_fields(resource["fields"], shape)
    properties = [
        _tracked_property(context, field, name["type"], field_type(context, field, usings, resource), usings, False)
        for field in fields
    ]
    if shape == "create":
        description = f"Body of a request that creates or replaces {article(resource['singular'])}."
    else:
        description = (
            f"Body of a request that changes part of {article(resource['singular'])}: only the fields sent change."
        )
    content = lines(
        *cs_header(namespace, usings),
        cs_doc(description),
        f"public sealed class {class_name} : Payload",
        "{",
        "\n\n".join(properties),
        _presence_checks(fields, name["type"], lambda field: shape == "create" and field["required"]),
        "}",
    )
    return {"path": source_path(context, relative, class_name), "content": file_text(content)}


def _response_file(context: AspNetContext, resource: dict) -> dict:
    """The response record of a resource and how it is built from the domain class."""
    relative = context.layout.resource(resource, "dto")
    namespace = namespace_of(context, relative)
    name = names(resource)
    usings = CsUsings(namespace).add(namespace_of(context, context.layout.resource(resource, "model")))
    fields = shape_fields(resource["fields"], "read")
    parameters = []
    for field in fields:
        # An optional field without a value is left out of the JSON, as the contract allows
        attributes = [attribute[1:-1] for attribute in _json_attributes(field, usings, not always_in_response(field))]
        type_name = field_type(context, field, usings, resource, False)
        parameters.append(f"    [property: {', '.join(attributes)}] {type_name} {property_name(field, name['type'])}")
    arguments = ", ".join(f"item.{property_name(field, name['type'])}" for field in fields)
    content = lines(
        *cs_header(namespace, usings),
        cs_doc(f"{capitalize(article(resource['singular']))} as the API returns it."),
        f"public sealed record {name['response']}(",
        ",\n".join(parameters),
        ")",
        "{",
        f"    /// <summary>The response of a stored {resource['singular']}: everything but what clients only send.</summary>",
        f"    public static {name['response']} From({name['type']} item) =>",
        f"        new({arguments});",
        "}",
    )
    return {"path": source_path(context, relative, name["response"]), "content": file_text(content)}


def dto_files(context: AspNetContext, resource: dict) -> list[dict]:
    """Request bodies and response of a resource."""
    files = [_response_file(context, resource)]
    if any(endpoint["input"] != "none" for endpoint in resource["endpoints"]):
        files.extend([_payload_class(context, resource, "create"), _payload_class(context, resource, "update")])
    return files
