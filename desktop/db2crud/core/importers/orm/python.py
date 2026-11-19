"""What every reader of Python ORM code needs: the statements of a module (by indentation), its classes with their
bases and keywords, assignments with their annotations, enum classes, and the attributes a class inherits. Mirrors
web/src/core/importers/orm/python.ts."""

import re

from ...js import is_number
from ..code.lexer import Cursor, tokenize
from ..code.python import PYTHON_LEXER
from .expressions import literal_of, name_of, read_expression, text_of


def statements_of(tokens: list, source: str) -> list[dict]:
    """The statements of a block: a new one starts on a line at the block's indentation, outside any bracket."""
    if not tokens:
        return []
    indent = tokens[0].column
    statements: list[dict] = []
    current: list = []
    depth = 0
    for token in tokens:
        if token.line_start and depth == 0 and token.column <= indent and current:
            statements.append({"tokens": current, "source": source})
            current = []
        current.append(token)
        if token.kind == "punct":
            if token.value in ("(", "[", "{"):
                depth += 1
            elif token.value in (")", "]", "}"):
                depth = max(0, depth - 1)
    if current:
        statements.append({"tokens": current, "source": source})
    return statements


def class_of(statement: dict, file: str = "") -> dict | None:
    """`class Name(Base, Mixin):` and the statements of its body."""
    cursor = Cursor(statement["tokens"])
    if not cursor.is_("class") or not cursor.is_ident(1):
        return None
    cursor.next()
    name = cursor.next().value
    bases: list[str] = []
    # `table=True` in `class Book(SQLModel, table=True)`
    keywords: dict = {}
    if cursor.eat("("):
        while not cursor.done and not cursor.is_(")"):
            if cursor.is_ident() and cursor.is_("=", 1):
                keyword = cursor.next().value
                cursor.next()
                keywords[keyword] = read_expression(cursor, statement["source"])
            else:
                text = text_of(read_expression(cursor, statement["source"]))
                if text:
                    bases.append(text)
            if not cursor.eat(","):
                break
        cursor.eat(")")
    cursor.eat(":")
    return {
        "name": name,
        "bases": bases,
        "keywords": keywords,
        "body": statements_of(statement["tokens"][cursor.index :], statement["source"]),
        "line": statement["tokens"][0].line,
        # The file it is declared in
        "file": file,
    }


def assignment_of(statement: dict) -> dict | None:
    """`name: Annotation = value` or `name = value`: the parts of an assignment."""
    cursor = Cursor(statement["tokens"])
    if not cursor.is_ident():
        return None
    name = cursor.next().value
    annotation = ""
    if cursor.eat(":"):
        start = cursor.index
        cursor.skip_until(["="])
        annotation = cursor.text_between(statement["source"], start, cursor.index)
    if not cursor.eat("="):
        return {"name": name, "annotation": annotation, "value": None} if annotation else None
    return {"name": name, "annotation": annotation, "value": read_expression(cursor, statement["source"])}


def _enum_class_of(definition: dict) -> dict | None:
    """`class OrderStatus(enum.Enum):` or Django's `class OrderStatus(models.TextChoices):`, and its members, {name,
    value} in order; a member `PAID = "paid", "Paid"` has its label after the value."""
    if not any(
        re.search(r"(^|\.)(Enum|IntEnum|StrEnum|TextChoices|IntegerChoices|Choices)\Z", base)
        for base in definition["bases"]
    ):
        return None
    members = []
    for statement in definition["body"]:
        item = assignment_of(statement)
        value = literal_of(item["value"]) if item else None
        if item and not item["name"].startswith("_") and (isinstance(value, str) or is_number(value)):
            members.append({"name": item["name"], "value": value})
    return {"name": definition["name"], "members": members}


def attributes_of(definition: dict, classes: dict, inherits, seen: set | None = None) -> list[dict]:
    """The attributes of a class and of the classes it inherits from in the files when `inherits` says so (mixins,
    abstract models, SQLModel's base models; not a base that is a table of its own), those of the bases first; an
    attribute declared again keeps its place and takes the new value."""
    seen = set() if seen is None else seen
    seen.add(definition["name"])
    inherited: list[dict] = []
    for base_name in definition["bases"]:
        base = classes.get(base_name.split(".")[-1])
        if base is not None and base["name"] not in seen and inherits(base):
            inherited += attributes_of(base, classes, inherits, seen)
    result: list[dict] = []
    for item in [*inherited, *map(assignment_of, definition["body"])]:
        if not item:
            continue
        index = next((position for position, other in enumerate(result) if other["name"] == item["name"]), -1)
        if index >= 0:
            result[index] = item
        else:
            result.append(item)
    return result


def empty_table(name: str, line: int) -> dict:
    return {
        "name": name,
        "columns": [],
        "primaryKey": None,
        "foreignKeys": [],
        "uniques": [],
        "indexes": [],
        "checks": [],
        "origin": {"line": line, "column": 1},
    }


def read_modules(files: list[dict]) -> tuple[list[list[dict]], list[dict], dict]:
    """The statements of each file, its classes and its enums by name (enums first: a column may name one declared
    further down)."""
    modules = [statements_of(tokenize(file["text"], PYTHON_LEXER), file["text"]) for file in files]
    classes: list[dict] = []
    enums: dict = {}
    for file, statements in zip(files, modules, strict=True):
        for statement in statements:
            definition = class_of(statement, file["name"])
            if not definition:
                continue
            enum_class = _enum_class_of(definition)
            if enum_class:
                enums[enum_class["name"]] = enum_class
            else:
                classes.append(definition)
    return modules, classes, enums


_NOW = ("now", "current_timestamp", "utcnow", "localtimestamp", "current_date", "today")


def is_now(expr: dict | None) -> bool:
    """A call that gives the current time: `func.now()`, `datetime.now`, `timezone.now`."""
    return expr is not None and (name_of(expr) or "").lower() in _NOW


def is_uuid(expr: dict | None) -> bool:
    """A call that gives a new UUID: `uuid.uuid4`, `gen_random_uuid()`."""
    return (
        expr is not None
        and re.fullmatch(r"uuid[147]|uuid_generate_v4|gen_random_uuid", name_of(expr) or "") is not None
    )
