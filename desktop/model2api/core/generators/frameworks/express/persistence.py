"""Storage of each resource in the Express project: the repository interface the service depends on, and the
implementation of the chosen persistence. Mirrors web/src/core/generators/frameworks/express/persistence.ts.

- memory: a Map, to run the API without a database
- none: every method throws "not implemented" (501), with a TODO where the storage goes
"""

import re

from ...common.text import file_text, lines
from ...languages.typescript.typescript import MEMORY_LIST_BODY, TsImports, ts_doc, ts_string
from .context import ExpressContext, import_path, key_field, key_type, names

_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def _key_property(wire: str) -> str:
    return wire if _IDENTIFIER.match(wire) else ts_string(wire)


def _key_access(wire: str) -> str:
    return f"record.{wire}" if _IDENTIFIER.match(wire) else f"record[{ts_string(wire)}]"


def repository_file(context: ExpressContext, resource: dict) -> dict:
    path = context.layout.resource(resource, "repository")
    name = names(resource)
    record = name["record"]
    key = key_type(resource)
    key_wire = key_field(resource)["wire"]
    generated = resource["key"]["generated"]
    plural = resource["plural"]
    imports = TsImports()
    imports.add_type(import_path(path, "src/listing.ts"), "ListQuery", "ListResult")
    imports.add_type(import_path(path, context.layout.resource(resource, "schemas")), record)
    # What add receives: the record without the key when the server generates it
    new_type = f"Omit<{record}, {ts_string(key_wire)}>" if generated else record
    contract = lines(
        f"/** Where {plural} are kept. The service depends only on this interface. */",
        f"export interface {name['repository']} {{",
        "  /** Items equal to every filter, in order, within the window; and how many match. */",
        f"  list(query: ListQuery): Promise<ListResult<{record}>>",
        "  /** The item with this key, or undefined. */",
        f"  get(key: {key}): Promise<{record} | undefined>",
        f"  /** Stores a new item{' and assigns its key' if generated else ''}; returns it as stored. */",
        f"  add(values: {new_type}): Promise<{record}>",
        "  /** Changes the given fields of an existing item and returns it. */",
        f"  update(key: {key}, values: Partial<{record}>): Promise<{record}>",
        "  /** Removes an existing item. */",
        f"  delete(key: {key}): Promise<void>",
        "}",
    )
    if context.pending:
        imports.add(import_path(path, "src/errors.ts"), "NotImplementedError")
        message = ts_string(f"The storage of {plural} is not written yet")

        def pending(signature: str) -> list[str]:
            return [
                f"  async {signature} {{",
                f"    // TODO: store {plural} in your database",
                f"    throw new NotImplementedError({message})",
                "  }",
            ]

        implementation = lines(
            f"/** Storage of {plural} to write: every method answers 501 until it is implemented. */",
            f"export class {name['pendingRepository']} implements {name['repository']} {{",
            pending(f"list(_query: ListQuery): Promise<ListResult<{record}>>"),
            "",
            pending(f"get(_key: {key}): Promise<{record} | undefined>"),
            "",
            pending(f"add(_values: {new_type}): Promise<{record}>"),
            "",
            pending(f"update(_key: {key}, _values: Partial<{record}>): Promise<{record}>"),
            "",
            pending(f"delete(_key: {key}): Promise<void>"),
            "}",
        )
    else:
        if generated == "uuid":
            imports.add("node:crypto", "randomUUID")
        if generated == "increment":
            assign = [
                f"    const record = {{ ...structuredClone(values), {_key_property(key_wire)}: this.nextKey++ }} as {record}"
            ]
        elif generated == "uuid":
            assign = [
                f"    const record = {{ ...structuredClone(values), {_key_property(key_wire)}: randomUUID() }} as {record}"
            ]
        else:
            assign = ["    const record = structuredClone(values)"]
        implementation = lines(
            f"/** Keeps {plural} in memory: they are lost when the application stops. Use it to try the API. */",
            f"export class {name['memory']} implements {name['repository']} {{",
            f"  private readonly items = new Map<{key}, {record}>()",
            generated == "increment" and "  private nextKey = 1",
            "",
            f"  async list(query: ListQuery): Promise<ListResult<{record}>> {{",
            MEMORY_LIST_BODY,
            "  }",
            "",
            f"  async get(key: {key}): Promise<{record} | undefined> {{",
            "    const item = this.items.get(key)",
            "    return item === undefined ? undefined : structuredClone(item)",
            "  }",
            "",
            f"  async add(values: {new_type}): Promise<{record}> {{",
            assign,
            f"    this.items.set({_key_access(key_wire)}, record)",
            "    return structuredClone(record)",
            "  }",
            "",
            f"  async update(key: {key}, values: Partial<{record}>): Promise<{record}> {{",
            "    const record = { ...this.items.get(key)!, ...structuredClone(values) }",
            "    this.items.set(key, record)",
            "    return structuredClone(record)",
            "  }",
            "",
            f"  async delete(key: {key}): Promise<void> {{",
            "    this.items.delete(key)",
            "  }",
            "}",
        )
    content = lines(ts_doc(f"Storage of {plural}."), "", imports.render(), "", contract, "", implementation)
    return {"path": path, "content": file_text(content)}
