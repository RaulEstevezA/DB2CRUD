"""Modules every SQLAlchemy project shares: the domain errors services raise and the pages lists are read in.
Mirrors web/src/core/generators/python/sqlalchemy/support.ts."""

from ...types import lines

ERRORS = [
    '"""Errors of the data access layer. They carry no HTTP codes: whoever calls the services translates them."""',
    "",
    "from dataclasses import dataclass, field",
    "",
    "",
    "class DomainError(Exception):",
    '    """Base of every error a service raises on purpose."""',
    "",
    "",
    "class NotFoundError(DomainError):",
    '    """No row has this key."""',
    "",
    "    def __init__(self, entity: str, key: object) -> None:",
    '        super().__init__(f"No {entity} has the key {key!r}")',
    "        self.entity = entity",
    "        self.key = key",
    "",
    "",
    "class ConflictError(DomainError):",
    '    """The change clashes with what is stored: a unique value, a newer version, rows that depend on it."""',
    "",
    "    def __init__(self, entity: str, reason: str, fields: tuple[str, ...] = ()) -> None:",
    '        super().__init__(f"{entity}: {reason}")',
    "        self.entity = entity",
    "        self.reason = reason",
    "        self.fields = fields",
    "",
    "",
    "@dataclass(frozen=True)",
    "class FieldError:",
    '    """What is wrong with one field."""',
    "",
    "    field: str",
    "    message: str",
    "",
    "",
    "@dataclass",
    "class ValidationFailedError(DomainError):",
    '    """The values break the rules of the table: missing, too long, out of range, pointing nowhere."""',
    "",
    "    entity: str",
    "    errors: list[FieldError] = field(default_factory=list)",
    "",
    "    def __post_init__(self) -> None:",
    '        super().__init__(f"{self.entity}: " + "; ".join(f"{error.field}: {error.message}" for error in self.errors))',
    "",
]

OFFSET_PAGE = [
    '"""A page of a list: the rows from an offset, and how many there are in all."""',
    "",
    "from dataclasses import dataclass",
    "",
    "",
    "@dataclass(frozen=True)",
    "class Page[T]:",
    "    items: list[T]",
    "    total: int",
    "    offset: int",
    "    limit: int",
    "",
]

CURSOR_PAGE = [
    '"""A page of a list read with a cursor: the rows after a key, and the key to read the next page from."""',
    "",
    "from dataclasses import dataclass",
    "from typing import Any",
    "",
    "",
    "@dataclass(frozen=True)",
    "class CursorPage[T]:",
    "    items: list[T]",
    "    # Key of the last row, to pass as `after` for the next page; None on the last page",
    "    next: tuple[Any, ...] | None",
    "",
]


def errors_file() -> dict:
    return {"path": "app/errors.py", "content": lines(*ERRORS)}


def paging_file(context: dict) -> dict | None:
    paging = context["settings"]["paging"]
    if paging == "none":
        return None
    content = lines(*OFFSET_PAGE) if paging == "offset" else lines(*CURSOR_PAGE)
    return {"path": "app/paging.py", "content": content}
