"""Request bodies of the Symfony project: for each resource, the constraints of each shape (create or replace, and
partial update) as a Symfony Validator Collection, which rejects fields the contract does not describe and tells a
missing field from one sent as null, and the defaults of the fields a body leaves out. Mirrors
web/src/core/generators/frameworks/symfony/input.ts.

Symfony's format and pattern constraints let an empty text through; where the contract does not accept one,
NotBlank(allowNull: true) rejects it.
"""

from ....js import number_text
from ....openapi.build import shape_fields
from ...common.samples import pattern_accepts
from ...common.text import file_text, lines
from ...languages.php.model import field_defaults
from ...languages.php.php import PhpImports, php_class, php_doc, php_header, php_regex, php_string
from ...languages.php.project import article
from .context import SymfonyContext, class_path, names

DATE_TIME = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$"
TIME = r"^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$"
DURATION = r"^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$"
BASE64 = r"^[A-Za-z0-9+\/]*={0,2}$"

_BLANK = "new Assert\\NotBlank(allowNull: true)"

# A constraint is one line (str), or several already indented relative to its first one (list[str])


def _list(open_text: str, nodes: list, close: str):
    """A list of constraints: on one line when they fit, one per line otherwise."""
    inline = f"{open_text}{', '.join(node for node in nodes if isinstance(node, str))}{close}"
    if all(isinstance(node, str) for node in nodes) and len(inline) <= 100:
        return inline
    inner = []
    for node in nodes:
        node_lines = [node] if isinstance(node, str) else node
        for index, line in enumerate(node_lines):
            inner.append(f"    {line}{',' if index == len(node_lines) - 1 else ''}")
    return [open_text.rstrip(), *inner, close.lstrip()]


def _regex(pattern: str) -> str:
    return f"new Assert\\Regex(pattern: {php_string(php_regex(pattern))})"


def _length_args(c: dict, low: str, high: str) -> str:
    args = [
        f"min: {number_text(c[low])}" if c.get(low) is not None else None,
        f"max: {number_text(c[high])}" if c.get(high) is not None else None,
    ]
    return ", ".join(arg for arg in args if arg)


def _type_constraints(
    context: SymfonyContext, type_ref: dict, field: dict | None, imports: PhpImports, depth: int
) -> list:
    """The constraints of a value of a type, without presence and nullability."""
    c = field["constraints"] if field else {}
    kind = type_ref["kind"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "string":
            nodes = ["new Assert\\Type('string')"]
            text_format = c.get("format")
            if text_format == "email":
                nodes.append("new Assert\\Email()")
            if text_format == "uri":
                nodes.append("new Assert\\Url(requireTld: false)")
            if text_format == "uuid":
                nodes.append("new Assert\\Uuid()")
            if text_format == "date":
                nodes.append("new Assert\\Date()")
            if text_format == "date-time":
                nodes.append(_regex(DATE_TIME))
            if text_format == "time":
                nodes.append(_regex(TIME))
            if c.get("minLength") is not None or c.get("maxLength") is not None:
                nodes.append(f"new Assert\\Length({_length_args(c, 'minLength', 'maxLength')})")
            if c.get("pattern") is not None:
                nodes.append(_regex(c["pattern"]))
            if text_format or (c.get("pattern") is not None and not pattern_accepts(c["pattern"], "")):
                nodes.append(_BLANK)
            return nodes
        if scalar in ("integer", "float", "decimal"):
            nodes = ["new Assert\\Type('integer')" if scalar == "integer" else "new Assert\\Type(['integer', 'float'])"]
            if c.get("minimum") is not None:
                nodes.append(f"new Assert\\GreaterThanOrEqual({number_text(c['minimum'])})")
            if c.get("maximum") is not None:
                nodes.append(f"new Assert\\LessThanOrEqual({number_text(c['maximum'])})")
            if c.get("exclusiveMinimum") is not None:
                nodes.append(f"new Assert\\GreaterThan({number_text(c['exclusiveMinimum'])})")
            if c.get("exclusiveMaximum") is not None:
                nodes.append(f"new Assert\\LessThan({number_text(c['exclusiveMaximum'])})")
            return nodes
        if scalar == "boolean":
            return ["new Assert\\Type('bool')"]
        if scalar == "date":
            return ["new Assert\\Type('string')", "new Assert\\Date()", _BLANK]
        if scalar == "datetime":
            return ["new Assert\\Type('string')", _regex(DATE_TIME), _BLANK]
        if scalar == "time":
            return ["new Assert\\Type('string')", _regex(TIME), _BLANK]
        if scalar == "duration":
            return ["new Assert\\Type('string')", _regex(DURATION), _BLANK]
        if scalar == "uuid":
            return ["new Assert\\Type('string')", "new Assert\\Uuid()", _BLANK]
        if scalar == "binary":
            return ["new Assert\\Type('string')", _regex(BASE64)]
        return []
    if kind == "enum":
        enum_class = php_class(type_ref["name"])
        imports.add(f"{context.layout.enums()}\\{enum_class}")
        return [f"new Assert\\Choice(choices: array_column({enum_class}::cases(), 'value'))"]
    if kind == "array":
        nodes = ["new Assert\\Type('list')"]
        if c.get("minItems") is not None or c.get("maxItems") is not None:
            nodes.append(f"new Assert\\Count({_length_args(c, 'minItems', 'maxItems')})")
        items = _type_constraints(context, type_ref["items"], None, imports, depth + 1)
        nodes.append(_list("new Assert\\All([", ["new Assert\\NotNull()", *items], "])"))
        return nodes
    if kind == "map":
        values = _type_constraints(context, type_ref["value"], None, imports, depth + 1)
        return [
            "new Assert\\Type('array')",
            *([_list("new Assert\\All([", ["new Assert\\NotNull()", *values], "])")] if values else []),
        ]
    if kind == "object":
        spec_object = next((item for item in context.spec["objects"] if item["name"] == type_ref["name"]), None)
        if not spec_object or depth > 4:
            return ["new Assert\\Type('array')"]
        return [
            "new Assert\\Type('array')",
            _collection(context, spec_object["fields"], "object", imports, depth + 1),
        ]
    return []


def _reference_constraints(context: SymfonyContext, field: dict) -> list:
    """The constraints of the key a reference holds: the type of the target's key."""
    target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
    scalar = target["key"]["type"]["scalar"]
    if scalar == "integer":
        return ["new Assert\\Type('integer')"]
    if scalar == "uuid":
        return ["new Assert\\Type('string')", "new Assert\\Uuid()", _BLANK]
    return ["new Assert\\Type('string')"]


def _field_entry(context: SymfonyContext, field: dict, shape: str, imports: PhpImports, depth: int) -> list[str]:
    """A field of a Collection: required or optional, with its constraints."""
    required = shape != "update" and field["required"]
    nodes: list = [] if field["nullable"] else ["new Assert\\NotNull()"]
    if field.get("reference"):
        key = _reference_constraints(context, field)
        if field["type"]["kind"] == "array":
            nodes.extend(
                ["new Assert\\Type('list')", _list("new Assert\\All([", ["new Assert\\NotNull()", *key], "])")]
            )
        else:
            nodes.extend(key)
    else:
        nodes.extend(_type_constraints(context, field["type"], field, imports, depth))
    wrapped = _list("new Assert\\Required([" if required else "new Assert\\Optional([", nodes, "])")
    entry = [wrapped] if isinstance(wrapped, str) else wrapped
    todo = [f"// TODO: {field['todo']}"] if field.get("todo") else []
    return [*todo, f"{php_string(field['wire'])} => {entry[0]}", *entry[1:]]


def _collection(context: SymfonyContext, fields: list[dict], shape: str, imports: PhpImports, depth: int) -> list[str]:
    """A Collection of fields: every one described, none other allowed."""
    entries = []
    for field in fields:
        entry = _field_entry(context, field, shape, imports, depth)
        for index, line in enumerate(entry):
            entries.append(f"    {line}{',' if index == len(entry) - 1 else ''}")
    if entries:
        return ["new Assert\\Collection(fields: [", *entries, "])"]
    return ["new Assert\\Collection(fields: [])"]


def input_file(context: SymfonyContext, resource: dict) -> dict | None:
    """The input class of a resource: the constraints of each shape and the defaults of a creation."""
    if not any(endpoint["input"] != "none" for endpoint in resource["endpoints"]):
        return None
    namespace = context.layout.resource(resource, "input")
    name = names(resource)
    imports = PhpImports(namespace).add("Symfony\\Component\\Validator\\Constraints as Assert")

    def shape(kind: str) -> list[str]:
        body = _collection(context, shape_fields(resource["fields"], kind), kind, imports, 0)
        statement = [f"return {body[0]}", *body[1:]]
        statement[-1] += ";"
        return [f"        {line}" for line in statement]

    # The shapes go first: they add the imports of the enums the header lists
    create_shape = shape("create")
    update_shape = shape("update")
    create_defaults = field_defaults(context, shape_fields(resource["fields"], "create"), "$values", 0, True)
    update_defaults = field_defaults(context, shape_fields(resource["fields"], "update"), "$values", 0, False)
    one = article(resource["singular"])
    content = lines(
        *php_header(namespace, imports),
        php_doc(f"Bodies of the requests that create, replace or change part of {one}."),
        f"final class {name['input']}",
        "{",
        f"    /** The body of a request that creates or replaces {one}. */",
        "    public static function create(): Assert\\Collection",
        "    {",
        create_shape,
        "    }",
        "",
        f"    /** The body of a request that changes part of {one}: only the fields sent change. */",
        "    public static function update(): Assert\\Collection",
        "    {",
        update_shape,
        "    }",
        "",
        "    /**",
        "     * @param  array<string, mixed>  $values",
        "     * @return array<string, mixed> The values of a creation, with the defaults of the fields left out.",
        "     */",
        "    public static function createValues(array $values): array",
        "    {",
        [f"        {line}" for line in create_defaults],
        len(create_defaults) > 0 and "",
        "        return $values;",
        "    }",
        "",
        "    /**",
        "     * @param  array<string, mixed>  $values",
        "     * @return array<string, mixed> The values of a change, with the defaults inside the objects sent.",
        "     */",
        "    public static function updateValues(array $values): array",
        "    {",
        [f"        {line}" for line in update_defaults],
        len(update_defaults) > 0 and "",
        "        return $values;",
        "    }",
        "}",
    )
    return {"path": class_path(namespace, name["input"]), "content": file_text(content)}
