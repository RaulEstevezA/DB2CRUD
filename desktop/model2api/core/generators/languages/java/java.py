"""What Java generators need: identifiers, literals, the Java type of each API type, and the imports of a source
file. Spring Boot uses it; another JVM framework would too. Mirrors
web/src/core/generators/languages/java/java.ts.
"""

import json
import re

from ....js import js_string, trim_end
from ....model.naming import to_camel_case, to_pascal_case, to_screaming_snake_case
from ...common.samples import json_text

_RESERVED = {
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "final",
    "finally",
    "float",
    "for",
    "goto",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "strictfp",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "try",
    "void",
    "volatile",
    "while",
    "var",
    "record",
    "yield",
    "true",
    "false",
    "null",
}

_DIGIT_START = re.compile(r"^[0-9]")


def java_name(name: str) -> str:
    """A camelCase identifier; a reserved word gets a trailing underscore."""
    camel = to_camel_case(name) or "value"
    safe = f"_{camel}" if _DIGIT_START.match(camel) else camel
    return f"{safe}_" if safe in _RESERVED else safe


def java_class(name: str) -> str:
    """A PascalCase class name."""
    pascal = to_pascal_case(name) or "Model"
    return f"_{pascal}" if _DIGIT_START.match(pascal) else pascal


def java_constant(value) -> str:
    """An enum constant: in progress → IN_PROGRESS."""
    name = to_screaming_snake_case(js_string(value)) or "VALUE"
    return f"VALUE_{name}" if _DIGIT_START.match(name) else name


def java_string(value: str) -> str:
    """A Java string literal."""
    return json.dumps(value, ensure_ascii=False)


def getter(prop: str) -> str:
    """The getter of a property: name → getName, active → getActive."""
    return f"get{prop[:1].upper()}{prop[1:]}"


def setter(prop: str) -> str:
    return f"set{prop[:1].upper()}{prop[1:]}"


def java_json(value) -> str:
    """A JSON value as a Java string for tests: the JSON exactly as written."""
    return java_string(json_text(value))


class JavaImports:
    """Imports of a Java source file, sorted, java.* first. Classes of the file's own package and of java.lang
    need no import."""

    def __init__(self, own_package: str) -> None:
        self._own_package = own_package
        self._items: dict[str, None] = {}

    def add(self, *names: str) -> "JavaImports":
        for name in names:
            package = name[: name.rfind(".")]
            if package != self._own_package and package != "java.lang":
                self._items[name] = None
        return self

    def render(self) -> str:
        every = sorted(self._items)
        statics = [item for item in every if item.startswith("static ")]
        plain = [item for item in every if not item.startswith("static ")]
        java = [item for item in plain if item.startswith("java.")]
        others = [item for item in plain if not item.startswith("java.")]
        groups = [group for group in (statics, java, others) if group]
        return "\n\n".join("\n".join(f"import {item};" for item in group) for group in groups)


_SCALARS = {
    "string": ("String", None),
    "duration": ("String", None),
    "float": ("Double", None),
    "decimal": ("BigDecimal", "java.math.BigDecimal"),
    "boolean": ("Boolean", None),
    "date": ("LocalDate", "java.time.LocalDate"),
    "datetime": ("OffsetDateTime", "java.time.OffsetDateTime"),
    "time": ("LocalTime", "java.time.LocalTime"),
    "uuid": ("UUID", "java.util.UUID"),
    "binary": ("byte[]", None),
    "any": ("Object", None),
}


def java_type(type_ref: dict, imports: JavaImports, names) -> str:
    """The Java type of an API type, always a reference type so it can be null. names has object(name) and
    enum(name): the qualified names of the embedded objects and enums."""
    kind = type_ref["kind"]
    if kind == "scalar":
        if type_ref["scalar"] == "integer":
            return "Long" if type_ref.get("bits") == 64 else "Integer"
        java, needed = _SCALARS.get(type_ref["scalar"], ("Object", None))
        if needed:
            imports.add(needed)
        return java
    if kind == "array":
        imports.add("java.util.List")
        return f"List<{java_type(type_ref['items'], imports, names)}>"
    if kind == "map":
        imports.add("java.util.Map")
        return f"Map<String, {java_type(type_ref['value'], imports, names)}>"
    qualified = names.object(type_ref["name"]) if kind == "object" else names.enum(type_ref["name"])
    imports.add(qualified)
    return qualified[qualified.rfind(".") + 1 :]


def java_doc(text: str, indent: str = "") -> str:
    """A Javadoc comment, indented."""
    body = text.split("\n")
    if len(body) == 1:
        return f"{indent}/** {text} */"
    return "\n".join([f"{indent}/**", *(trim_end(f"{indent} * {line}") for line in body), f"{indent} */"])
