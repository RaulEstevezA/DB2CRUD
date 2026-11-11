"""A small YAML writer for JSON-like data (objects, arrays, strings, numbers, booleans and None), used for the
OpenAPI contract. Mirrors web/src/core/openapi/yaml.ts rule by rule, so both versions write the same text byte
for byte. Regular expressions use \\Z where the web uses $, because Python's $ also matches before a final line
break.
"""

import json
import math
import re

from ..js import number_text, trim

# Values YAML 1.2 (core schema) would read as something other than text: they are quoted
_NOT_TEXT = (
    re.compile(r"^(?:~|[Nn]ull|NULL)?\Z"),
    re.compile(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)\Z"),
    re.compile(r"^0o[0-7]+\Z"),
    re.compile(r"^[-+]?[0-9]+\Z"),
    re.compile(r"^0x[0-9a-fA-F]+\Z"),
    re.compile(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)\Z"),
    re.compile(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+\Z"),
    re.compile(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)\Z"),
)

# Text that cannot be written plain: a leading indicator, "- " or "? ", ": " or " #" inside, or a trailing space
# or colon
_NOT_PLAIN = re.compile(r"^[\n\t ,\[\]{}#&*!|>'\"%@`]|^[?-]\Z|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]\Z")
_DOCUMENT_MARKER = re.compile(r"^(%|---|\.\.\.)", re.MULTILINE)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_SPACE_AROUND_BREAK = re.compile(r"^\n*[ \t]")


def _json(text: str) -> str:
    """JSON.stringify of a string."""
    return json.dumps(text, ensure_ascii=False)


def _quoted(text: str) -> str:
    """Text in quotes: single quotes when it holds double ones and no single ones, as JSON otherwise."""
    if '"' in text and "'" not in text:
        return f"'{text}'"
    return _json(text)


def _block(text: str, indent: str) -> str:
    """A literal block (|), for multi-line text that is not a key."""
    chomp = "-" if not text.endswith("\n") else "+" if text.endswith("\n\n") else ""
    body = text[:-1] if text.endswith("\n") else text
    # When the first line with text starts with a space, the indentation has to be stated
    header = f"|{'2' if _SPACE_AROUND_BREAK.match(text) else ''}{chomp}"
    lines = "\n".join("" if line == "" else indent + line for line in body.split("\n"))
    return f"{header}\n{lines}"


def _text(value: str, indent: str, key: bool) -> str:
    """A text scalar; indent is the indentation of a literal block's lines, and a key cannot be a block."""
    # A block cannot be a key, and a block of blank lines would read back as empty text
    if _CONTROL.search(value) or ("\n" in value and (key or trim(value) == "")):
        return _json(value)
    if "\n" in value:
        return _block(value, indent)
    if _NOT_PLAIN.search(value) or _DOCUMENT_MARKER.search(value) or any(p.search(value) for p in _NOT_TEXT):
        return _quoted(value)
    return value


def _scalar(value, indent: str) -> str:
    if value is None:
        return "null"
    if isinstance(value, str):
        return _text(value, indent, False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("YAML cannot hold a number that is not finite")
    if isinstance(value, float) and value == 0 and math.copysign(1, value) < 0:
        return "-0"
    return number_text(value)


def _is_collection(value) -> bool:
    return isinstance(value, (list, tuple, dict))


def _empty_text(value) -> str:
    return "{}" if isinstance(value, dict) else "[]"


def _collection(value, indent: str) -> list[str]:
    """The lines of a non-empty collection, each starting at indent."""
    inner = f"{indent}  "
    lines: list[str] = []
    if not isinstance(value, dict):
        for item in value:
            if not _is_collection(item) or not item:
                lines.append(f"{indent}- {_empty_text(item) if _is_collection(item) else _scalar(item, inner)}")
                continue
            # The first line of the item follows the dash; the rest keep the item's indentation
            nested = _collection(item, inner)
            lines.append(f"{indent}- {nested[0][len(inner) :]}")
            lines.extend(nested[1:])
        return lines
    for key, item in value.items():
        name = _text(key, inner, True)
        if not _is_collection(item):
            lines.append(f"{indent}{name}: {_scalar(item, inner)}")
        elif not item:
            lines.append(f"{indent}{name}: {_empty_text(item)}")
        else:
            lines.append(f"{indent}{name}:")
            lines.extend(_collection(item, inner))
    return lines


def to_yaml(value) -> str:
    """Writes JSON-like data as a YAML document, ending with a line break."""
    if not _is_collection(value):
        return f"{_scalar(value, '')}\n"
    if not value:
        return f"{_empty_text(value)}\n"
    return "\n".join(_collection(value, "")) + "\n"
