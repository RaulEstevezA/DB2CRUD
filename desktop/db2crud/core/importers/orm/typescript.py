"""The declarations of TypeScript modules the readers of TypeScript ORMs need: classes with their decorators, their
base class and their members (name, type as written, decorators), and enums with the value of each member. It never
runs anything: it reads the tokens. Mirrors web/src/core/importers/orm/typescript.ts.

A decorator is {name, args}; a member {name, type, decorators, line}; a class {name, base, decorators, members,
line}; an enum the value of each of its members, by name."""

import re

from ...js import is_number
from ..code.lexer import Cursor, LexError, Token, tokenize
from ..code.typescript import TYPESCRIPT_LEXER
from .expressions import literal_of, read_arguments, read_expression

# TypeScript has no named arguments: `=` never separates one
NAMED = "="

# Reading the declarations


def read_decorator(cursor: Cursor, source: str) -> dict:
    parts = [cursor.next().value]
    while cursor.is_(".") and cursor.is_ident(1):
        cursor.next()
        parts.append(cursor.next().value)
    if not cursor.is_("("):
        return {"name": parts[-1], "args": []}
    cursor.next()
    return {"name": parts[-1], "args": read_arguments(cursor, source, NAMED, ")")[0]}


def _is_open(token: Token) -> bool:
    return token.kind == "punct" and token.value in ("(", "[", "{")


def _skip_statement(cursor: Cursor) -> None:
    """Moves past the rest of a statement: up to a `;`, a new line or the `}` that closes its block."""
    start = cursor.index
    while not cursor.done:
        token = cursor.peek()
        if cursor.index > start and token.line_start:
            return
        if token.kind == "punct" and token.value == "}":
            return
        if token.kind == "punct" and token.value == ";":
            cursor.next()
            return
        if _is_open(token):
            cursor.skip_group()
        else:
            cursor.next()


_MODIFIERS = {
    "public",
    "private",
    "protected",
    "readonly",
    "declare",
    "static",
    "abstract",
    "override",
    "accessor",
    "get",
    "set",
    "async",
}


def _is_string(cursor: Cursor, offset: int = 0) -> bool:
    token = cursor.peek(offset)
    return token is not None and token.kind == "string"


def _read_class_body(cursor: Cursor, source: str) -> list[dict]:
    members: list[dict] = []
    decorators: list[dict] = []
    cursor.next()
    while not cursor.done and not cursor.is_("}"):
        if cursor.is_("@") and cursor.is_ident(1):
            cursor.next()
            decorators.append(read_decorator(cursor, source))
            continue
        if cursor.is_(";") or cursor.is_(","):
            cursor.next()
            continue
        while cursor.value() in _MODIFIERS and cursor.is_ident() and (cursor.is_ident(1) or _is_string(cursor, 1)):
            cursor.next()
        if not cursor.is_ident() and not _is_string(cursor):
            if cursor.is_("(") or cursor.is_("[") or cursor.is_("{"):
                cursor.skip_group()
            else:
                cursor.next()
            decorators = []
            continue
        name = cursor.next()
        cursor.eat("!")
        cursor.eat("?")
        # `name?: Type` reads `?:` as one token
        typed = cursor.eat(":") or cursor.eat("?:")
        if not typed and (cursor.is_("(") or cursor.is_("<")):
            # A method: its parameters, its return type and its body
            while not cursor.done and not cursor.is_("("):
                cursor.next()
            cursor.skip_group()
            while not cursor.done and not cursor.is_("{") and not cursor.is_(";") and not cursor.is_("}"):
                cursor.next()
            if cursor.is_("{"):
                cursor.skip_group()
            decorators = []
            continue
        member_type = ""
        if typed:
            start = cursor.index
            while not cursor.done:
                token = cursor.peek()
                if cursor.index > start and token.line_start:
                    break
                if token.kind == "punct" and token.value in (";", "=", "}"):
                    break
                if _is_open(token):
                    cursor.skip_group()
                else:
                    cursor.next()
            member_type = cursor.text_between(source, start, cursor.index)
        if cursor.eat("="):
            _skip_statement(cursor)
        members.append({"name": name.value, "type": member_type, "decorators": decorators, "line": name.line})
        decorators = []
    cursor.eat("}")
    return members


def _read_enum(cursor: Cursor, source: str) -> dict:
    """The value of each member of a TypeScript enum: a text, or a number counted on from the last one."""
    members: dict = {}
    following = 0
    cursor.next()
    while not cursor.done and not cursor.is_("}"):
        if not cursor.is_ident() and not _is_string(cursor):
            cursor.next()
            continue
        name = cursor.next().value
        if cursor.eat("="):
            value = literal_of(read_expression(cursor, source, NAMED))
            if is_number(value):
                following = value
            members[name] = value if isinstance(value, str) else following
        else:
            members[name] = following
        following += 1
        cursor.eat(",")
    cursor.eat("}")
    return members


def read_typescript(files: list[dict]) -> tuple[dict, dict, list]:
    """The classes (by name, and in the order of the files) and the enums of every file."""
    classes: dict[str, dict] = {}
    enums: dict[str, dict] = {}
    order: list[dict] = []
    for file in files:
        try:
            tokens = tokenize(file["text"], TYPESCRIPT_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)
        pending: list[dict] = []
        while not cursor.done:
            if cursor.is_("@") and cursor.is_ident(1):
                cursor.next()
                pending.append(read_decorator(cursor, file["text"]))
            elif cursor.is_("enum") and cursor.is_ident(1) and cursor.is_("{", 2):
                cursor.next()
                name = cursor.next().value
                enums[name] = _read_enum(cursor, file["text"])
                pending = []
            elif cursor.is_("class") and cursor.is_ident(1):
                line = cursor.next().line
                definition = {
                    "name": cursor.next().value,
                    "base": None,
                    "decorators": pending,
                    "members": [],
                    "line": line,
                }
                while not cursor.done and not cursor.is_("{"):
                    if cursor.is_("extends") and cursor.is_ident(1):
                        cursor.next()
                        definition["base"] = cursor.next().value
                    else:
                        cursor.next()
                definition["members"] = _read_class_body(cursor, file["text"])
                classes[definition["name"]] = definition
                order.append(definition)
                pending = []
            elif cursor.value() in ("export", "default", "abstract", "declare", "const") and cursor.is_ident():
                cursor.next()
            else:
                pending = []
                if cursor.is_("(") or cursor.is_("[") or cursor.is_("{"):
                    cursor.skip_group()
                else:
                    cursor.next()
    return classes, enums, order


_NULLABLE = re.compile(r"\|\s*(null|undefined)\b")


def plain_type(member: dict) -> str:
    """The type of a member without `| null` or `| undefined`."""
    return _NULLABLE.sub("", member["type"]).strip()
