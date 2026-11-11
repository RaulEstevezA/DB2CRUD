"""What C# generators need: identifiers, literals, the C# type of each API type, the `using` directives of a source
file and documentation comments. ASP.NET Core uses it; another .NET framework would too. Mirrors
web/src/core/generators/languages/csharp/csharp.ts.
"""

import re

from ....js import number_text
from ....model.naming import to_camel_case, to_pascal_case

# C# keywords, which a camelCase name cannot be without @
_KEYWORDS = set(
    (
        "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double "
        "else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal "
        "is lock long namespace new null object operator out override params private protected public readonly ref return "
        "sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked "
        "unsafe ushort using virtual void volatile while"
    ).split(" ")
)

# Type names a generated class cannot take: the types every file sees through the implicit using directives of an
# ASP.NET Core project, its validation and JSON namespaces, and the classes the project writes itself. A model with
# one of these names gets Item after it (Task → TaskItem).
_TAKEN_TYPES = set(
    (
        "Action Activator Array Attribute Buffer Console Convert Delegate Directory Enum Environment Exception File Func "
        "Guid Index Lazy Math Monitor Nullable Object Path Program Random Range Stream String Task Thread Timeout Timer "
        "Tuple Type Uri Version Results Endpoint HttpContext Host Configuration Logger LogLevel "
        "Required Key Validator ValidationResult JsonElement JsonNode JsonObject JsonArray JsonSerializer "
        "ApiException ErrorResponse ListQuery ListResult PageResponse Payload Clock AppDbContext"
    ).split(" ")
)

_DIGIT_START = re.compile(r"^[0-9]")


def cs_pascal(name: str) -> str:
    """A PascalCase name for a class, an enum member or a property."""
    pascal = to_pascal_case(name) or "Value"
    return f"_{pascal}" if _DIGIT_START.match(pascal) else pascal


def cs_class(name: str) -> str:
    """A class name that does not clash with the types every file of the project sees."""
    pascal = cs_pascal(name)
    return f"{pascal}Item" if pascal in _TAKEN_TYPES else pascal


def cs_name(name: str) -> str:
    """A camelCase name for parameters and variables; a keyword gets @ before it."""
    camel = to_camel_case(name) or "value"
    safe = f"_{camel}" if _DIGIT_START.match(camel) else camel
    return f"@{safe}" if safe in _KEYWORDS else safe


def cs_property(name: str, owner: str) -> str:
    """A property of a class: PascalCase, and never the name of the class itself (C# forbids it)."""
    pascal = cs_pascal(name)
    return f"{pascal}Value" if pascal == owner else pascal


def cs_string(value: str) -> str:
    """A regular C# string literal."""
    text = []
    for char in value:
        code = ord(char)
        if char == "\\":
            text.append("\\\\")
        elif char == '"':
            text.append('\\"')
        elif char == "\n":
            text.append("\\n")
        elif char == "\r":
            text.append("\\r")
        elif char == "\t":
            text.append("\\t")
        elif code < 0x20:
            text.append(f"\\u{code:04x}")
        else:
            text.append(char)
    return '"' + "".join(text) + '"'


def cs_number(value, type_name: str) -> str:
    """A number as a C# literal of a type: 5L, 1.5, 2.25m."""
    text = number_text(value)
    if type_name == "long":
        return f"{text}L"
    if type_name == "decimal":
        return f"{text}m"
    if type_name == "double":
        return f"{text}.0" if float(value).is_integer() else text
    return text


def _xml_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def cs_doc(text: str, indent: str = "") -> str:
    """A documentation comment, indented: /// <summary>…</summary>."""
    body = _xml_text(text).split("\n")
    if len(body) == 1:
        return f"{indent}/// <summary>{body[0]}</summary>"
    return "\n".join(
        [f"{indent}/// <summary>", *(f"{indent}/// {line}".rstrip() for line in body), f"{indent}/// </summary>"]
    )


class CsUsings:
    """The using directives of a file: System namespaces first, then the others, each group sorted."""

    def __init__(self, own_namespace: str) -> None:
        self._namespace = own_namespace
        self._items: dict[str, None] = {}

    def add(self, *namespaces: str) -> "CsUsings":
        for namespace in namespaces:
            if namespace != self._namespace:
                self._items[namespace] = None
        return self

    def render(self) -> str:
        every = sorted(self._items)
        system = [item for item in every if item == "System" or item.startswith("System.")]
        others = [item for item in every if item != "System" and not item.startswith("System.")]
        return "\n".join(f"using {item};" for item in [*system, *others])


def cs_header(namespace: str, usings: CsUsings) -> list[str]:
    """The opening of a C# file: its using directives and its file-scoped namespace."""
    rendered = usings.render()
    return [*([rendered, ""] if rendered else []), f"namespace {namespace};", ""]


def cs_type(type_ref: dict, usings: CsUsings, names, nullable: bool = True) -> str:
    """The C# type of an API type. Values can always be null (?), so a body can leave them out. names.namespace()
    tells where embedded objects and enums live."""
    q = "?" if nullable else ""
    kind = type_ref["kind"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar in ("string", "time", "duration"):
            return f"string{q}"
        if scalar == "integer":
            return f"{'long' if type_ref.get('bits') == 64 else 'int'}{q}"
        if scalar == "float":
            return f"double{q}"
        if scalar == "decimal":
            return f"decimal{q}"
        if scalar == "boolean":
            return f"bool{q}"
        if scalar == "date":
            return f"DateOnly{q}"
        if scalar == "datetime":
            return f"DateTimeOffset{q}"
        if scalar == "uuid":
            return f"Guid{q}"
        if scalar == "binary":
            return f"byte[]{q}"
        if scalar == "any":
            usings.add("System.Text.Json")
            return f"JsonElement{q}"
        return f"object{q}"
    if kind == "array":
        return f"List<{cs_type(type_ref['items'], usings, names, False)}>{q}"
    if kind == "map":
        return f"Dictionary<string, {cs_type(type_ref['value'], usings, names, False)}>{q}"
    usings.add(names.namespace())
    return f"{cs_class(type_ref['name'])}{q}"
