"""What the PHP generators need: identifiers (PascalCase classes, camelCase members and variables), PHP literals,
reaching a property whatever its name, and the use statements of a file, sorted, without the ones of its own
namespace. Mirrors web/src/core/generators/php/common/php.ts."""

import re

from ....js import number_text
from ....model.naming import to_camel_case, to_pascal_case

RESERVED_CLASSES = set(
    (
        "abstract and array as bool break callable case catch class clone const continue declare default do echo else "
        "elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends false final finally "
        "float fn for foreach function global goto if implements include instanceof insteadof int interface isset "
        "iterable list match mixed namespace never new null object or parent print private protected public readonly "
        "require return self static string switch throw trait true try unset use var void while xor yield"
    ).split(" ")
)


def pascal_name(name: str) -> str:
    """order line → OrderLine; a name PHP keeps for itself gets Entity after it."""
    base = to_pascal_case(name) or "Item"
    safe = f"_{base}" if base[:1].isdigit() else base
    return f"{safe}Entity" if safe.lower() in RESERVED_CLASSES else safe


def field_name(name: str) -> str:
    """A name for a variable, a parameter or a field: order_id → orderId ($this is taken)."""
    base = to_camel_case(name) or "value"
    safe = f"_{base}" if base[:1].isdigit() else base
    return "this_" if safe == "this" else safe


def php_string(text: str) -> str:
    """A PHP single-quoted string."""
    escaped = text.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def php_literal(value) -> str:
    """A PHP literal for a number, a string, a boolean or null."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    return php_string(value)


IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def access(target: str, prop: str) -> str:
    """$entity->email, or $entity->{'odd name'} for a name that is not an identifier."""
    return f"{target}->{prop}" if IDENTIFIER.fullmatch(prop) else f"{target}->{{{php_string(prop)}}}"


def nullable(php_type: str) -> str:
    """A type that can hold null: ?int; mixed already can."""
    return "mixed" if php_type == "mixed" else f"?{php_type}"


class PhpUses:
    """The use statements of one file, sorted, without the classes of its own namespace."""

    def __init__(self, ns: str):
        self._ns = ns
        self._names: list[str] = []

    def add(self, *names: str) -> "PhpUses":
        """Classes by their full name: App\\Errors\\NotFoundException."""
        for name in names:
            if name not in self._names:
                self._names.append(name)
        return self

    def write(self) -> str:
        def own(name: str) -> bool:
            return name[: name.rfind("\\")] == self._ns

        names = sorted((name for name in self._names if not own(name)), key=str.lower)
        return "\n".join(f"use {name};" for name in names)
