"""The expressions ORM code declares tables with, read from tokens into a small tree: names (`sa.String`), calls
with positional and named arguments (`mapped_column(String(120), nullable=False)`), texts, numbers, lists and
dictionaries, and attributes of what a call returns (`BigInteger().with_variant(…)`). It never evaluates anything:
the readers of each ORM look at the tree. What it does not know is kept as its text. Mirrors
web/src/core/importers/orm/expressions.ts.

An expression is a dictionary with a "kind": name {path}, call {callee, args, named}, attribute {target, name},
string {value}, number {value}, list {items}, dict {entries: [{key, value}]} or other {text}."""

import re

from ...js import json_string, number_text, to_number
from ..code.lexer import Cursor

# The tokens that end an expression at its level
_STOP = {",", ")", "]", "}", ":", "=", ";"}


def _number(text: str):
    value = to_number(re.sub(r"[lLfFdDmM]$", "", text.replace("_", "")))
    return value


def _is_named_argument(cursor: Cursor, named: str) -> bool:
    return cursor.is_ident() and cursor.is_(named, 1) and not cursor.is_("==", 1)


def read_arguments(cursor: Cursor, source: str, named_by: str, close: str) -> tuple[list, dict]:
    """The arguments of a call, after its opening bracket and up to the closing one, which it reads too."""
    args: list = []
    named: dict = {}
    while not cursor.done and not cursor.is_(close):
        if _is_named_argument(cursor, named_by):
            name = cursor.next().value
            cursor.next()
            named[name] = read_expression(cursor, source, named_by)
        elif cursor.is_("*") or cursor.is_("**"):
            # Spread arguments are not followed
            cursor.next()
            read_expression(cursor, source, named_by)
        else:
            args.append(read_expression(cursor, source, named_by))
        if not cursor.eat(","):
            break
    cursor.eat(close)
    return args, named


def _is_arrow(cursor: Cursor) -> bool:
    """Whether the group at the cursor is the parameters of an arrow function: `=>` follows it, maybe after a
    type."""
    start = cursor.index
    cursor.skip_group()
    arrow = cursor.is_("=>")
    if cursor.is_(":"):
        cursor.skip_until(["=>", ",", ";"])
        arrow = cursor.is_("=>")
    cursor.index = start
    return arrow


def _read_primary(cursor: Cursor, source: str, named_by: str) -> dict:
    token = cursor.peek()
    if token is None:
        return {"kind": "other", "text": ""}
    if token.kind == "string":
        # Adjacent texts are one text: "a" "b"
        value = ""
        while cursor.peek() is not None and cursor.peek().kind == "string":
            value += cursor.next().value
        return {"kind": "string", "value": value}
    if token.kind == "number":
        cursor.next()
        return {"kind": "number", "value": _number(token.value)}
    if cursor.is_("-") and cursor.peek(1) is not None and cursor.peek(1).kind == "number":
        cursor.next()
        value = to_number(cursor.next().value.replace("_", ""))
        return {"kind": "number", "value": -value if value is not None else None}
    if cursor.is_("(") and _is_arrow(cursor):
        # An arrow function (`() => Order`, `(): AnyPgColumn => orders.id`) is kept as text
        start = cursor.index
        cursor.skip_until([",", ";"])
        return {"kind": "other", "text": cursor.text_between(source, start, cursor.index)}
    if cursor.is_("[") or cursor.is_("("):
        close = "]" if cursor.is_("[") else ")"
        cursor.next()
        items: list = []
        while not cursor.done and not cursor.is_(close):
            items.append(read_expression(cursor, source, named_by))
            if not cursor.eat(","):
                break
        cursor.eat(close)
        # A group of one is the expression itself: (x)
        return items[0] if close == ")" and len(items) == 1 else {"kind": "list", "items": items}
    if cursor.is_("{"):
        cursor.next()
        entries: list = []
        bare: list = []
        while not cursor.done and not cursor.is_("}"):
            key = read_expression(cursor, source, named_by)
            if cursor.eat(":") or cursor.eat("=>"):
                entries.append({"key": key, "value": read_expression(cursor, source, named_by)})
            else:
                bare.append(key)
            if not cursor.eat(","):
                break
        cursor.eat("}")
        # Braces with no keys are a list: a Java array (`{ "a", "b" }`) or a Python set
        return {"kind": "list", "items": bare} if not entries and bare else {"kind": "dict", "entries": entries}
    if cursor.is_("@") and cursor.is_ident(1):
        # An annotation inside another (`indexes = { @Index(columnList = "a") }`) reads as a call
        cursor.next()
        return _read_primary(cursor, source, named_by)
    if token.kind == "ident":
        path = [cursor.next().value]
        while cursor.is_(".") and cursor.is_ident(1):
            cursor.next()
            path.append(cursor.next().value)
        return {"kind": "name", "path": path}
    return {"kind": "other", "text": ""}


def read_expression(cursor: Cursor, source: str, named_by: str = "=") -> dict:
    """Reads one expression at the cursor, up to a comma or a closing bracket of its level. `named_by` separates a
    named argument from its value: `=` (Python, Java annotations) or `:` (PHP, C# attributes)."""
    start = cursor.index
    expr = _read_primary(cursor, source, named_by)
    while True:
        if cursor.is_("("):
            cursor.next()
            args, named = read_arguments(cursor, source, named_by, ")")
            expr = {"kind": "call", "callee": expr, "args": args, "named": named}
        elif cursor.is_(".") and cursor.is_ident(1):
            cursor.next()
            expr = {"kind": "attribute", "target": expr, "name": cursor.next().value}
        elif (
            cursor.peek() is not None
            and cursor.peek().kind == "string"
            and source[cursor.peek().start : cursor.peek().start + 1] == "`"
            and expr["kind"] in ("name", "attribute")
        ):
            # A tagged template (sql`now()`) is a call with its text
            expr = {
                "kind": "call",
                "callee": expr,
                "args": [{"kind": "string", "value": cursor.next().value}],
                "named": {},
            }
        elif cursor.is_("["):
            # Subscripts (Mapped[int]) are kept as text
            cursor.skip_group()
            expr = {"kind": "other", "text": cursor.text_between(source, start, cursor.index)}
        else:
            break
    # Anything else up to the end of the expression (operators, lambdas) makes it text
    token = cursor.peek()
    if not cursor.done and cursor.value() not in _STOP and token.kind == "punct" and not token.line_start:
        cursor.skip_until([",", ";"])
        return {"kind": "other", "text": cursor.text_between(source, start, cursor.index)}
    return expr


# Reading the tree


def name_of(expr: dict | None) -> str | None:
    """The name a name or a call goes by: `String` for `sa.String(120)`, `with_variant` for `x().with_variant()`."""
    if expr is None:
        return None
    if expr["kind"] == "name":
        return expr["path"][-1]
    if expr["kind"] == "call":
        return name_of(expr["callee"])
    if expr["kind"] == "attribute":
        return expr["name"]
    return None


def chain_of(expr: dict) -> list[dict]:
    """The calls of a chain, innermost first: `BigInteger().with_variant(Integer(), "sqlite")` → BigInteger,
    with_variant."""
    if expr["kind"] == "call" and expr["callee"]["kind"] == "attribute":
        return [*chain_of(expr["callee"]["target"]), expr]
    if expr["kind"] == "attribute":
        return [*chain_of(expr["target"]), expr]
    return [expr]


def string_of(expr: dict | None) -> str | None:
    return expr["value"] if expr is not None and expr["kind"] == "string" else None


def number_of(expr: dict | None):
    return expr["value"] if expr is not None and expr["kind"] == "number" else None


def boolean_of(expr: dict | None) -> bool | None:
    """`True`/`true` and `False`/`false`, or None for anything else."""
    if expr is None or expr["kind"] != "name" or len(expr["path"]) != 1:
        return None
    name = expr["path"][0].lower()
    return True if name == "true" else False if name == "false" else None


def literal_of(expr: dict | None):
    """A literal default: a text, a number or a boolean."""
    for value in (string_of(expr), number_of(expr), boolean_of(expr)):
        if value is not None:
            return value
    return None


def text_of(expr: dict) -> str:
    """The expression as code, for the `sql` of a type and for notes."""
    kind = expr["kind"]
    if kind == "name":
        return ".".join(expr["path"])
    if kind == "string":
        return json_string(expr["value"])
    if kind == "number":
        return "NaN" if expr["value"] is None else number_text(expr["value"])
    if kind == "call":
        args = [
            *(text_of(arg) for arg in expr["args"]),
            *(f"{name}={text_of(value)}" for name, value in expr["named"].items()),
        ]
        return f"{text_of(expr['callee'])}({', '.join(args)})"
    if kind == "attribute":
        return f"{text_of(expr['target'])}.{expr['name']}"
    if kind == "list":
        return f"[{', '.join(text_of(item) for item in expr['items'])}]"
    if kind == "dict":
        return "{" + ", ".join(f"{text_of(entry['key'])}: {text_of(entry['value'])}" for entry in expr["entries"]) + "}"
    return expr["text"]
