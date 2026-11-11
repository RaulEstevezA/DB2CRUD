"""Data classes of the Spring Boot project: the domain class of each resource (a JPA entity when JPA is chosen),
the enums and embedded objects, the request bodies (which remember which fields were sent, to tell a missing
field from an explicit null) and the response records. Mirrors
web/src/core/generators/frameworks/springBoot/model.ts.
"""

import re

from ....js import coalesce, is_number, js_string, number_text
from ....openapi.build import always_in_response, shape_fields
from ...common.text import file_text, lines
from ...languages.java.java import (
    JavaImports,
    getter,
    java_class,
    java_constant,
    java_doc,
    java_string,
    java_type,
    setter,
)
from .context import SpringContext, common_package, key_type, names, prop, shared_names, source_path

# URLs, UUIDs and dates written as text: checked with a pattern, as Bean Validation has no annotation for them
_FORMAT_PATTERNS = {
    "uri": r"^[a-zA-Z][a-zA-Z0-9+.-]*://\S+$",
    "uuid": r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    "date": r"^\d{4}-\d{2}-\d{2}$",
    "date-time": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$",
    "time": r"^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$",
}

_VOWEL_START = re.compile(r"^[aeiou]", re.IGNORECASE)


def field_type(context: SpringContext, field: dict, imports: JavaImports, resource: dict | None = None) -> str:
    """The Java type of a field: keys and references to keys use the key's type, whole numbers as Long."""
    if resource and field["name"] == resource["key"]["field"]:
        if resource["key"]["type"]["scalar"] == "uuid":
            imports.add("java.util.UUID")
        return key_type(resource)
    if field.get("reference"):
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        if target["key"]["type"]["scalar"] == "uuid":
            imports.add("java.util.UUID")
        if field["type"]["kind"] == "array":
            imports.add("java.util.List")
            return f"List<{key_type(target)}>"
        return key_type(target)
    return java_type(field["type"], imports, shared_names(context))


def validations(field: dict, imports: JavaImports, shape: str) -> list[str]:
    """Bean Validation annotations of a field's declared validations; shape is create, update or object."""
    c = field["constraints"]
    result: list[str] = []

    def v(name: str) -> None:
        imports.add(f"jakarta.validation.constraints.{name}")

    if shape != "update" and field["required"]:
        v("NotNull")
        result.append("@NotNull")
    type_ref = field["type"]
    text = type_ref["kind"] == "scalar" and type_ref["scalar"] == "string"
    is_list = type_ref["kind"] == "array"
    minimum = c.get("minItems") if is_list else c.get("minLength") if text else None
    maximum = c.get("maxItems") if is_list else c.get("maxLength") if text else None
    if minimum is not None or maximum is not None:
        v("Size")
        parts = [
            f"min = {number_text(minimum)}" if minimum is not None else None,
            f"max = {number_text(maximum)}" if maximum is not None else None,
        ]
        result.append(f"@Size({', '.join(part for part in parts if part)})")
    if type_ref["kind"] == "scalar" and type_ref["scalar"] in ("integer", "float", "decimal"):

        def decimal(value, inclusive: bool, name: str) -> None:
            v(name)
            literal = java_string(number_text(value))
            result.append(f"@{name}({literal})" if inclusive else f"@{name}(value = {literal}, inclusive = false)")

        if c.get("minimum") is not None:
            decimal(c["minimum"], True, "DecimalMin")
        if c.get("exclusiveMinimum") is not None:
            decimal(c["exclusiveMinimum"], False, "DecimalMin")
        if c.get("maximum") is not None:
            decimal(c["maximum"], True, "DecimalMax")
        if c.get("exclusiveMaximum") is not None:
            decimal(c["exclusiveMaximum"], False, "DecimalMax")
    if text and c.get("pattern"):
        v("Pattern")
        result.append(f"@Pattern(regexp = {java_string(c['pattern'])})")
    if text and c.get("format") == "email":
        v("Email")
        result.append("@Email")
    if text and c.get("format") and c["format"] != "email":
        v("Pattern")
        result.append(f"@Pattern(regexp = {java_string(_FORMAT_PATTERNS[c['format']])})")
    if type_ref["kind"] == "object" or (type_ref["kind"] == "array" and type_ref["items"]["kind"] == "object"):
        imports.add("jakarta.validation.Valid")
        result.append("@Valid")
    return result


def _json_name(field: dict, imports: JavaImports) -> str | None:
    """@JsonProperty("postal_code") when the JSON name is not the Java property."""
    if prop(field) == field["wire"]:
        return None
    imports.add("com.fasterxml.jackson.annotation.JsonProperty")
    return f"@JsonProperty({java_string(field['wire'])})"


def _enum_file(context: SpringContext, values: list, name: str) -> dict:
    package = context.layout.shared()
    imports = JavaImports(package).add(
        "com.fasterxml.jackson.annotation.JsonValue", f"{common_package(context)}.ApiException"
    )
    integer = all(is_number(value) for value in values)
    used: set[str] = set()
    constants = []
    for value in values:
        constant = java_constant(value)
        n = 2
        while constant in used:
            constant = f"{java_constant(value)}_{n}"
            n += 1
        used.add(constant)
        constants.append(f"    {constant}({number_text(value) if integer else java_string(js_string(value))})")
    value_type = "int" if integer else "String"
    class_name = java_class(name)
    content = lines(
        f"package {package};",
        "",
        imports.render(),
        "",
        java_doc(f"Values of {name}, with the value each one has in JSON."),
        f"public enum {class_name} {{",
        ",\n".join(constants) + ";",
        "",
        f"    private final {value_type} value;",
        "",
        f"    {class_name}({value_type} value) {{",
        "        this.value = value;",
        "    }",
        "",
        "    @JsonValue",
        f"    public {value_type} getValue() {{",
        "        return value;",
        "    }",
        "",
        "    /** The constant with this JSON value; an unknown value is a 400. */",
        f"    public static {class_name} fromValue({'Integer' if integer else 'String'} value) {{",
        f"        for ({class_name} item : values()) {{",
        "            if (item.value == value) {" if integer else "            if (item.value.equals(value)) {",
        "                return item;",
        "            }",
        "        }",
        f'        throw ApiException.invalid({java_string(name)}, "Unknown value: " + value);',
        "    }",
        "}",
    )
    return {"path": source_path(package, class_name), "content": file_text(content)}


def _object_file(context: SpringContext, spec_object: dict) -> dict:
    package = context.layout.shared()
    imports = JavaImports(package)
    components = []
    for field in spec_object["fields"]:
        annotations = [item for item in [*validations(field, imports, "object"), _json_name(field, imports)] if item]
        components.append(f"        {' '.join([*annotations, f'{field_type(context, field, imports)} {prop(field)}'])}")
    content = lines(
        f"package {package};",
        "",
        imports.render(),
        "",
        java_doc(
            coalesce(spec_object.get("description"), f"{spec_object['name']}, embedded in the resources that hold it.")
        ),
        f"public record {java_class(spec_object['name'])}(",
        ",\n".join(components),
        ") {",
        "}",
    )
    return {"path": source_path(package, java_class(spec_object["name"])), "content": file_text(content)}


def shared_files(context: SpringContext) -> list[dict]:
    """Enums and embedded objects shared by the resources."""
    return [
        *(_enum_file(context, item["values"], item["name"]) for item in context.spec["enums"]),
        *(_object_file(context, spec_object) for spec_object in context.spec["objects"]),
    ]


def stored_as_json(field: dict) -> bool:
    """Whether a field is stored as JSON in a table: embedded objects, lists and maps."""
    type_ref = field["type"]
    return type_ref["kind"] in ("object", "array", "map") or (
        type_ref["kind"] == "scalar" and type_ref["scalar"] == "any"
    )


def domain_file(context: SpringContext, resource: dict) -> dict:
    """The domain class of a resource: every field, the ones clients never read included."""
    package = context.layout.resource(resource, "model")
    imports = JavaImports(package)
    name = names(resource)
    fields = []
    for field in resource["fields"]:
        java = field_type(context, field, imports, resource)
        annotations: list[str] = []
        if context.jpa:
            if field["name"] == resource["key"]["field"]:
                imports.add("jakarta.persistence.Id")
                annotations.append("@Id")
                if resource["key"].get("generated") == "increment":
                    imports.add("jakarta.persistence.GeneratedValue", "jakarta.persistence.GenerationType")
                    annotations.append("@GeneratedValue(strategy = GenerationType.IDENTITY)")
                if resource["key"].get("generated") == "uuid":
                    imports.add("jakarta.persistence.GeneratedValue", "jakarta.persistence.GenerationType")
                    annotations.append("@GeneratedValue(strategy = GenerationType.UUID)")
            if stored_as_json(field):
                imports.add("org.hibernate.annotations.JdbcTypeCode", "org.hibernate.type.SqlTypes")
                annotations.append("@JdbcTypeCode(SqlTypes.JSON)")
            if field["type"]["kind"] == "enum":
                imports.add("jakarta.persistence.Enumerated", "jakarta.persistence.EnumType")
                annotations.append("@Enumerated(EnumType.STRING)")
            type_ref = field["type"]
            if (
                type_ref["kind"] == "scalar"
                and type_ref["scalar"] == "string"
                and field["constraints"].get("maxLength") is not None
            ):
                imports.add("jakarta.persistence.Column")
                annotations.append(f"@Column(length = {number_text(field['constraints']['maxLength'])})")
            if type_ref["kind"] == "scalar" and type_ref["scalar"] == "decimal":
                imports.add("jakarta.persistence.Column")
                annotations.append("@Column(precision = 18, scale = 4)")
        todo = f"    // TODO: {field['todo']}\n" if field.get("todo") else ""
        declared = "".join(f"    {annotation}\n" for annotation in annotations)
        fields.append(
            {"declaration": f"{todo}{declared}    private {java} {prop(field)};", "type": java, "prop": prop(field)}
        )
    if context.jpa:
        imports.add("jakarta.persistence.Entity", "jakarta.persistence.Table")
    accessors: list[str] = []
    for item in fields:
        accessors.extend(
            [
                f"    public {item['type']} {getter(item['prop'])}() {{",
                f"        return {item['prop']};",
                "    }",
                "",
                f"    public void {setter(item['prop'])}({item['type']} {item['prop']}) {{",
                f"        this.{item['prop']} = {item['prop']};",
                "    }",
                "",
            ]
        )
    content = lines(
        f"package {package};",
        "",
        imports.render(),
        "",
        resource.get("todo") and f"// TODO: {resource['todo']}",
        java_doc(f"{capitalize(article(resource['singular']))} as the service and its storage handle it."),
        context.jpa and ["@Entity", f"@Table(name = {java_string(resource['plural'].replace(' ', '_'))})"],
        f"public class {name['type']} {{",
        "",
        "\n\n".join(item["declaration"] for item in fields),
        "",
        accessors[:-1],
        "}",
    )
    return {"path": source_path(package, name["type"]), "content": file_text(content)}


def payload_file(context: SpringContext) -> dict:
    """The base of request bodies: remembers which properties were sent, so null and missing differ."""
    package = common_package(context)
    content = lines(
        f"package {package};",
        "",
        "import com.fasterxml.jackson.annotation.JsonIgnore;",
        "import java.util.HashSet;",
        "import java.util.Set;",
        "",
        java_doc(
            "Base of request bodies. Jackson calls a setter only for properties present in the JSON, so the\n"
            "setters record them: a property sent as null is present, a missing one is not."
        ),
        "public abstract class Payload {",
        "",
        "    @JsonIgnore",
        "    private final Set<String> present = new HashSet<>();",
        "",
        "    /** Records that the property with this JSON name was sent. */",
        "    protected void mark(String property) {",
        "        present.add(property);",
        "    }",
        "",
        "    /** Whether the property with this JSON name was sent, even as null. */",
        "    public boolean has(String property) {",
        "        return present.contains(property);",
        "    }",
        "}",
    )
    return {"path": source_path(package, "Payload"), "content": file_text(content)}


def _payload_class(context: SpringContext, resource: dict, shape: str) -> dict:
    package = context.layout.resource(resource, "dto")
    imports = JavaImports(package).add(f"{common_package(context)}.Payload")
    name = names(resource)
    class_name = name["create"] if shape == "create" else name["update"]
    fields = [
        {"field": field, "type": field_type(context, field, imports, resource), "prop": prop(field)}
        for field in shape_fields(resource["fields"], shape)
    ]
    declarations = []
    for item in fields:
        annotations = [
            annotation
            for annotation in [*validations(item["field"], imports, shape), _json_name(item["field"], imports)]
            if annotation
        ]
        declared = "".join(f"    {annotation}\n" for annotation in annotations)
        declarations.append(f"{declared}    private {item['type']} {item['prop']};")
    accessors: list[str] = []
    for item in fields:
        accessors.extend(
            [
                f"    public {item['type']} {getter(item['prop'])}() {{",
                f"        return {item['prop']};",
                "    }",
                "",
                f"    public void {setter(item['prop'])}({item['type']} {item['prop']}) {{",
                f"        mark({java_string(item['field']['wire'])});",
                f"        this.{item['prop']} = {item['prop']};",
                "    }",
                "",
            ]
        )
    description = (
        f"Body of a request that creates or replaces {article(resource['singular'])}."
        if shape == "create"
        else f"Body of a request that changes part of {article(resource['singular'])}: only the fields sent change."
    )
    content = lines(
        f"package {package};",
        "",
        imports.render(),
        "",
        java_doc(description),
        f"public class {class_name} extends Payload {{",
        "",
        "\n\n".join(declarations),
        len(fields) > 0 and "",
        accessors[:-1],
        "}",
    )
    return {"path": source_path(package, class_name), "content": file_text(content)}


def _response_file(context: SpringContext, resource: dict) -> dict:
    """The response record of a resource and how it is built from the domain class."""
    package = context.layout.resource(resource, "dto")
    imports = JavaImports(package)
    name = names(resource)
    imports.add(f"{context.layout.resource(resource, 'model')}.{name['type']}")
    fields = shape_fields(resource["fields"], "read")
    components = []
    for field in fields:
        # An optional field without a value is left out of the JSON, as the contract allows
        optional = not always_in_response(field)
        if optional:
            imports.add("com.fasterxml.jackson.annotation.JsonInclude")
        annotations = [
            item
            for item in ["@JsonInclude(JsonInclude.Include.NON_NULL)" if optional else None, _json_name(field, imports)]
            if item
        ]
        declared = f"{field_type(context, field, imports, resource)} {prop(field)}"
        components.append(f"        {' '.join([*annotations, declared])}")
    content = lines(
        f"package {package};",
        "",
        imports.render(),
        "",
        java_doc(f"{capitalize(article(resource['singular']))} as the API returns it."),
        f"public record {name['response']}(",
        ",\n".join(components),
        ") {",
        "",
        f"    /** The response of a stored {resource['singular']}: everything but what clients only send. */",
        f"    public static {name['response']} from({name['type']} item) {{",
        f"        return new {name['response']}({', '.join(f'item.{getter(prop(field))}()' for field in fields)});",
        "    }",
        "}",
    )
    return {"path": source_path(package, name["response"]), "content": file_text(content)}


def dto_files(context: SpringContext, resource: dict) -> list[dict]:
    """Request bodies and response of a resource."""
    files = [_response_file(context, resource)]
    if any(endpoint["input"] != "none" for endpoint in resource["endpoints"]):
        files.extend([_payload_class(context, resource, "create"), _payload_class(context, resource, "update")])
    return files


def article(text: str) -> str:
    return f"an {text}" if _VOWEL_START.match(text) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
