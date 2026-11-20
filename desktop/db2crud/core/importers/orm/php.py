"""The declarations of PHP files the readers of PHP ORMs need: classes (and enums, traits, interfaces) with their
attributes, base class, properties (type, attributes, initial value), constants, enum cases and what each method
returns. It never runs anything: it reads the tokens. Mirrors web/src/core/importers/orm/php.ts.

A property is {name, type, attributes, initializer?, line}; a class {name, kind, attributes, base, properties,
constants, cases, methods, line}; a method {name, returns}."""

import re

from ...js import is_number
from ..code.lexer import Cursor, LexError, tokenize
from ..code.php import PHP_LEXER
from .expressions import literal_of, name_of, read_expression, string_of

# PHP names its arguments with `name: value`
NAMED = ":"

# Reading the declarations


def _read_attribute_group(cursor: Cursor, source: str) -> list[dict]:
    """The attributes of a `#[…]` group, after its `#[`."""
    attributes: list[dict] = []
    while not cursor.done and not cursor.is_("]"):
        attributes.append(read_expression(cursor, source, NAMED))
        if not cursor.eat(","):
            break
    cursor.eat("]")
    return attributes


_MODIFIERS = {"public", "private", "protected", "static", "readonly", "var", "final", "abstract"}
_DECLARATIONS = {"class", "interface", "trait", "enum"}


def _is_variable(cursor: Cursor) -> bool:
    return cursor.is_ident() and cursor.value().startswith("$")


def _read_declaration(cursor: Cursor, source: str, kind: str, attributes: list, classes: list) -> None:
    token = cursor.peek()
    line = token.line if token is not None else 1
    declaration = {
        "name": cursor.next().value,
        "kind": kind,
        "attributes": attributes,
        "base": None,
        "properties": [],
        "constants": {},
        "cases": [],
        "methods": [],
        "line": line,
    }
    while not cursor.done and not cursor.is_("{"):
        if cursor.is_("extends") and cursor.is_ident(1):
            cursor.next()
            while cursor.is_("\\"):
                cursor.next()
            base = cursor.next().value
            while cursor.is_("\\") and cursor.is_ident(1):
                cursor.next()
                base = cursor.next().value
            declaration["base"] = base
        else:
            cursor.next()
    classes.append(declaration)
    cursor.next()
    pending: list = []
    while not cursor.done and not cursor.is_("}"):
        if cursor.is_("#["):
            cursor.next()
            pending.extend(_read_attribute_group(cursor, source))
            continue
        if cursor.value() in _MODIFIERS and cursor.is_ident():
            cursor.next()
            continue
        if cursor.is_("case") and cursor.is_ident(1):
            cursor.next()
            name = cursor.next().value
            value = literal_of(read_expression(cursor, source, NAMED)) if cursor.eat("=") else None
            kept = isinstance(value, str) or is_number(value)
            declaration["cases"].append({"name": name, **({"value": value} if kept else {})})
            cursor.skip_until([";"])
            cursor.eat(";")
            pending = []
            continue
        if cursor.is_("const"):
            cursor.next()
            # `const string NAME = …` (PHP 8.3 typed constants)
            if cursor.is_ident(1) and not cursor.is_("=", 1):
                cursor.next()
            name = cursor.next().value
            if cursor.eat("="):
                declaration["constants"][name] = read_expression(cursor, source, NAMED)
            cursor.skip_until([";"])
            cursor.eat(";")
            pending = []
            continue
        if cursor.is_("function"):
            # A method: its parameters, its return type and its body, with what it returns
            cursor.next()
            method = cursor.value() if cursor.is_ident() else ""
            while not cursor.done and not cursor.is_("("):
                cursor.next()
            cursor.skip_group()
            while not cursor.done and not cursor.is_("{") and not cursor.is_(";") and not cursor.is_("}"):
                cursor.next()
            returns: list = []
            if cursor.is_("{"):
                start = cursor.index
                cursor.skip_group()
                end = cursor.index
                for index in range(start, end):
                    token = cursor.tokens[index]
                    if token.kind == "ident" and token.value == "return":
                        cursor.index = index + 1
                        returns.append(read_expression(cursor, source, NAMED))
                cursor.index = end
            else:
                cursor.eat(";")
            declaration["methods"].append({"name": method, "returns": returns})
            pending = []
            continue
        if cursor.is_("use"):
            cursor.skip_until([";"])
            cursor.eat(";")
            continue
        # A property: an optional type, then `$name`
        type_start = cursor.index
        while not cursor.done and not _is_variable(cursor) and not cursor.is_(";") and not cursor.is_("}"):
            cursor.next()
        if not _is_variable(cursor):
            cursor.eat(";")
            pending = []
            continue
        written = re.sub(r"\s+", "", cursor.text_between(source, type_start, cursor.index))
        name = cursor.next()
        initializer = read_expression(cursor, source, NAMED) if cursor.eat("=") else None
        cursor.skip_until([";"])
        cursor.eat(";")
        declaration["properties"].append(
            {
                "name": name.value[1:],
                "type": written,
                "attributes": pending,
                **({"initializer": initializer} if initializer is not None else {}),
                "line": name.line,
            }
        )
        pending = []
    cursor.eat("}")


_OPEN_TAG = re.compile(r"^\s*<\?php")


def read_classes(files: list[dict]) -> list[dict]:
    """The classes, interfaces, traits and enums of every file, in order."""
    classes: list[dict] = []
    for file in files:
        try:
            tokens = tokenize(_OPEN_TAG.sub(lambda match: " " * len(match.group(0)), file["text"], count=1), PHP_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)
        attributes: list = []
        while not cursor.done:
            if cursor.is_("#["):
                cursor.next()
                attributes.extend(_read_attribute_group(cursor, file["text"]))
            elif cursor.value() in _DECLARATIONS and cursor.is_ident() and cursor.is_ident(1):
                kind = cursor.next().value
                _read_declaration(cursor, file["text"], kind, attributes, classes)
                attributes = []
            elif cursor.value() in _MODIFIERS and cursor.is_ident():
                cursor.next()
            else:
                cursor.next()
                attributes = []
    return classes


def class_of(expr: dict | None) -> str | None:
    """`Order::class` or `'App\\Entity\\Order'`: the class it names, without its namespace."""
    if expr is None:
        return None
    if expr["kind"] == "name" and expr["path"][-1] == "class":
        return expr["path"][-2] if len(expr["path"]) > 1 else None
    text = string_of(expr)
    return text.split("\\")[-1] if text is not None else None


def entries_of(expr: dict | None) -> dict:
    """The entries of a PHP array with keys: `['default' => 1]`."""
    entries: dict = {}
    if expr is not None and expr["kind"] == "dict":
        for entry in expr["entries"]:
            key = string_of(entry["key"])
            key = key if key is not None else name_of(entry["key"])
            if key:
                entries[key] = entry["value"]
    return entries
