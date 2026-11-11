"""Modules every TypeScript project shares: the domain errors services throw (no HTTP codes: that is the job of the
layers above) and the pages lists are read in. Mirrors web/src/core/generators/typescript/common/support.ts."""

from ...types import lines

ERRORS = [
    "/** Errors of the data access layer. They carry no HTTP codes: whoever calls the services translates them. */",
    "",
    "/** Base of every error a service throws on purpose. */",
    "export class DomainError extends Error {}",
    "",
    "/** No row has this key. */",
    "export class NotFoundError extends DomainError {",
    "  constructor(",
    "    readonly entity: string,",
    "    readonly key: unknown,",
    "  ) {",
    "    super(`No ${entity} has the key ${JSON.stringify(key)}`)",
    "    this.name = 'NotFoundError'",
    "  }",
    "}",
    "",
    "/** The change clashes with what is stored: a unique value, a newer version, rows that depend on it. */",
    "export class ConflictError extends DomainError {",
    "  constructor(",
    "    readonly entity: string,",
    "    readonly reason: string,",
    "    readonly fields: readonly string[] = [],",
    "  ) {",
    "    super(`${entity}: ${reason}`)",
    "    this.name = 'ConflictError'",
    "  }",
    "}",
    "",
    "/** What is wrong with one field. */",
    "export interface FieldError {",
    "  field: string",
    "  message: string",
    "}",
    "",
    "/** The values break the rules of the table: missing, too long, out of range, pointing nowhere. */",
    "export class ValidationFailedError extends DomainError {",
    "  constructor(",
    "    readonly entity: string,",
    "    readonly errors: readonly FieldError[],",
    "  ) {",
    "    super(`${entity}: ${errors.map((error) => `${error.field}: ${error.message}`).join('; ')}`)",
    "    this.name = 'ValidationFailedError'",
    "  }",
    "}",
    "",
]

OFFSET_PAGE = [
    "/** A page of a list: the rows from an offset, and how many there are in all. */",
    "export interface Page<T> {",
    "  items: T[]",
    "  total: number",
    "  offset: number",
    "  limit: number",
    "}",
    "",
]

CURSOR_PAGE = [
    "/** A page of a list read with a cursor: the rows after a key, and the key to read the next page from. */",
    "export interface CursorPage<T> {",
    "  items: T[]",
    "  /** Key of the last row, to pass as `after` for the next page; null on the last page */",
    "  next: unknown[] | null",
    "}",
    "",
]


def errors_file() -> dict:
    return {"path": "src/errors.ts", "content": lines(*ERRORS)}


def paging_file(context: dict) -> dict | None:
    paging = context["settings"]["paging"]
    if paging == "none":
        return None
    return {"path": "src/paging.ts", "content": lines(*(OFFSET_PAGE if paging == "offset" else CURSOR_PAGE))}
