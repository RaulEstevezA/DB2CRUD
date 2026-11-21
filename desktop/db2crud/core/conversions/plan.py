"""The conversions between the application models and the tables, as a plan every generator writes in its language
(docs/design.md, section 2). For each table with a model, the plan says where each value a write sends comes from in
the model (a field, a row looked up by a field, a Mapper transformation) and where each field of the model comes
from in a row it reads. What the matching leaves undecided, or what cannot be converted that way, is a `todo`: the
generated code says so instead of guessing. Mirrors web/src/core/conversions/plan.ts.

Conversions are written only when the models are in the language of the project, or in a format of no language
(JSON, JSON Schema, OpenAPI…): otherwise the services keep their DTOs and the interface says why.

Application models are {schema, project?}; a plan is {table, model, direction, write: [{column, value}] | None,
read: [{field, value}] | None}, each value a dict with its `kind` (see plan.ts)."""

from ..matching.names import field_for, fields_of

_WRITTEN = {"direct", "concat", "split", "constant", "boolean", "enum", "epoch", "arithmetic"}


def models_language(models: dict, model: str | None = None) -> str | None:
    """The language the models are written in, or None for a format of no language."""
    project = models.get("project")
    if project and model:
        in_source = any(item["name"] == model for item in project["source"]["schema"]["models"])
        side = project["source"] if in_source else project["target"]
        return (side["schema"].get("origin") or {}).get("language")
    return (models["schema"].get("origin") or {}).get("language")


def conversions_available(models: dict, language: str) -> dict:
    """Whether conversions can be written for a project: the models are in its language, or in none."""
    project = models.get("project")
    written = models_language(models, project["root"].split("->")[0] if project else None)
    if written is None or written == language:
        return {"ok": True}
    return {"ok": False, "reason": "language", "models": written, "project": language}


def _todo(reason: str, detail: str | None = None) -> dict:
    return {"kind": "todo", "reason": reason, **({"detail": detail} if detail else {})}


def _mapper_field(project: dict | None, mapping: str, target: str) -> dict | None:
    found = next((item for item in (project or {}).get("mappings", []) if item["id"] == mapping), None)
    return next((field for field in found["fields"] if field["target"] == target), None) if found else None


def _columns_of(paths: list[list[str]], table: dict, table_fields: list[dict]) -> list[str] | None:
    """The columns the fields of the table's side of a Mapper relation name."""
    columns = []
    for item in paths:
        field = next((candidate for candidate in table_fields if candidate["name"] == item[0]), None)
        column = (
            next((candidate for candidate in table["columns"] if field_for(candidate, [field], set())), None)
            if field is not None and len(item) == 1
            else None
        )
        if column is None:
            return None
        columns.append(column["name"])
    return columns


def _table_fields_of(project: dict, mapping: str, side: str) -> list[dict]:
    found = next((item for item in project["mappings"] if item["id"] == mapping), None)
    schema = project[side]["schema"]
    name = (found["source"] if side == "source" else found["target"]) if found else None
    model = next((item for item in schema["models"] if item["name"] == name), None)
    return fields_of(model, schema) if model is not None else []


def _waits(column: dict) -> bool:
    """Whether a decision waits for the user."""
    return column["source"]["status"] == "pending"


def _one_way(column: dict) -> bool:
    """Whether it waits only because Mapper's relation serves one direction: that direction can be written."""
    return all(item["code"] == "mapperOneWay" for item in column["source"]["reasons"])


def _describe(value: dict) -> str:
    if value["kind"] == "mapper":
        return ", ".join(value["fields"])
    return "" if value["kind"] == "database" else value["field"]


def _transform_detail(transform: dict) -> str:
    return transform["expression"] if transform["kind"] == "expression" else transform["kind"]


def _key_of(table: dict, column: str) -> str:
    key = next(
        (item for item in table["foreignKeys"] if len(item["columns"]) == 1 and item["columns"][0] == column), None
    )
    return key["references"]["columns"][0] if key else "id"


def _write_value(column: dict, table: dict, models: dict) -> dict | None:
    source = column["source"]
    value = source["value"]
    if value is None:
        return _todo("noField") if source["confidence"] == "conflict" else None
    # The table is Mapper's source: writing needs the inverse of the relation
    if value["kind"] == "mapper" and value["side"] == "source" and not value["inverse"]:
        return _todo("oneWay", ", ".join(value["fields"]))
    if _waits(column) and not (value["kind"] == "mapper" and value["side"] == "target" and _one_way(column)):
        return _todo("pending", _describe(value) if value["kind"] != "database" else None)
    if value["kind"] == "database":
        return None
    if value["kind"] == "field":
        return {"kind": "field", "path": value["field"].split(".")}
    if value["kind"] == "lookup":
        key = _key_of(table, column["column"])
        path = value["field"].split(".")
        return {"kind": "lookup", "path": path, "table": value["table"], "by": value["by"], "key": key}
    field = _mapper_field(models.get("project"), value["mapping"], value["target"])
    if field is None:
        return _todo("unsupported", ", ".join(value["fields"]))
    if value["side"] == "target":
        if field["transform"]["kind"] not in _WRITTEN:
            return _todo("unsupported", _transform_detail(field["transform"]))
        return {"kind": "mapper", "transform": field["transform"], "sources": field["sources"]}
    return {"kind": "inverse", "transform": field["transform"], "path": [value["target"]]}


def _read_value(field: dict, columns: list[dict], table: dict, models: dict) -> dict | None:
    name = field["name"]
    for column in columns:
        value = column["source"]["value"]
        if not value or value["kind"] == "database":
            continue
        # A one-way Mapper relation waits only for the direction it does not serve
        pending = _waits(column) and not (value["kind"] == "mapper" and value["side"] == "source" and _one_way(column))
        if value["kind"] == "field" and value["field"] == name:
            return _todo("pending", name) if pending else {"kind": "column", "column": column["column"]}
        if value["kind"] == "lookup" and value["field"] == name:
            if pending:
                return _todo("pending", name)
            key = _key_of(table, column["column"])
            return {
                "kind": "lookup",
                "column": column["column"],
                "table": value["table"],
                "by": value["by"],
                "key": key,
            }
        if value["kind"] != "mapper":
            continue
        mapped = _mapper_field(models.get("project"), value["mapping"], value["target"])
        if value["side"] == "source" and value["target"] == name:
            if pending:
                return _todo("pending", name)
            if mapped is None or mapped["transform"]["kind"] not in _WRITTEN:
                return _todo("unsupported", _transform_detail(mapped["transform"]) if mapped else name)
            fields = _table_fields_of(models["project"], value["mapping"], "source")
            named = _columns_of(mapped["sources"], table, fields)
            if named is None:
                return _todo("unsupported", name)
            return {"kind": "mapper", "transform": mapped["transform"], "columns": named}
        if value["side"] == "target" and name in value["fields"]:
            # Reading needs the inverse of the relation, which only a lossless one of a single field has
            if not value["inverse"] or len(value["fields"]) > 1 or mapped is None:
                return _todo("oneWay", ", ".join(value["fields"]))
            if pending:
                return _todo("pending", name)
            return {"kind": "inverse", "transform": mapped["transform"], "column": column["column"]}
    return None if field.get("optional") or field.get("nullable") else _todo("noField", name)


def _fills(table: dict, name: str) -> bool:
    """Whether the database fills a column on insert: a write never sends it."""
    column = next((item for item in table["columns"] if item["name"] == name), None)
    generated = column.get("generated") if column else None
    return generated is not None and generated != "onUpdateNow"


def _children_value(child: dict, table: dict, schema: dict) -> dict | None:
    """A list field read from a join table: the keys of the other table its rows link this row with."""
    name = child["table"]["value"]
    if name is None:
        return None
    if child["table"]["status"] == "pending":
        return _todo("pending", child["field"])
    other = next((item for item in schema["tables"] if item["name"] == name), None)
    keys = other["foreignKeys"] if other else []
    here = next(
        (item for item in keys if item["references"]["table"] == table["name"] and len(item["columns"]) == 1), None
    )
    there = next((item for item in keys if item is not here and len(item["columns"]) == 1), None)
    if other is None or here is None or there is None:
        return _todo("unsupported", child["field"])
    return {
        "kind": "children",
        "table": other["name"],
        "by": here["columns"][0],
        "key": here["references"]["columns"][0],
        "value": there["columns"][0],
    }


def _read_columns(value: dict) -> list[str]:
    """The columns a value read from a row uses."""
    kind = value["kind"]
    if kind in ("column", "lookup", "inverse"):
        return [value["column"]]
    if kind == "mapper":
        return value["columns"]
    if kind == "children":
        return [value["key"]]
    return []


def without_hidden(plan: dict, hidden: list[str]) -> dict:
    """A plan read from what the service returns, which leaves out the hidden columns: the fields that need one of
    them are left to the user."""
    if plan["read"] is None or not hidden:
        return plan
    read = []
    for item in plan["read"]:
        used = [column for column in _read_columns(item["value"]) if column in hidden]
        read.append({**item, "value": _todo("hidden", ", ".join(used))} if used else item)
    return {**plan, "read": read}


def plan_conversions(schema: dict, design: dict, models: dict) -> list[dict]:
    """The conversions of every table whose model the matching settled."""
    plans = []
    for table_match in (design.get("matching") or {}).get("tables", []):
        table = next((item for item in schema["tables"] if item["name"] == table_match["table"]), None)
        if table is None:
            continue
        for match in table_match["models"]:
            name = match["model"]["value"]
            model = next((item for item in models["schema"]["models"] if item["name"] == name), None)
            if model is None or match["model"]["status"] == "pending":
                continue
            write = None
            if match["direction"] != "output":
                write = []
                for column in match["columns"]:
                    # What the database fills is never written (a key it numbers, a computed column, a creation time)
                    if _fills(table, column["column"]):
                        continue
                    value = _write_value(column, table, models)
                    if value is not None:
                        write.append({"column": column["column"], "value": value})
            read = None
            if match["direction"] != "input":
                read = []
                for field in fields_of(model, models["schema"]):
                    child = next((item for item in match["children"] if item["field"] == field["name"]), None)
                    if child is not None:
                        value = _children_value(child, table, schema)
                    else:
                        value = _read_value(field, match["columns"], table, models)
                    if value is not None:
                        read.append({"field": field["name"], "value": value})
            plans.append(
                {
                    "table": table["name"],
                    "model": model["name"],
                    "direction": match["direction"],
                    "write": write,
                    "read": read,
                }
            )
    return plans
