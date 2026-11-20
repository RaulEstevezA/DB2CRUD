"""Matching application models with the tables of the database (docs/design.md, section 2): each table gets the model
it corresponds to, and each column the field it comes from, every proposal with its confidence and its reasons. Where
a model and a column disagree (a longer text, an optional field for a required column, another type, enum values the
column refuses), the conflict is shown and never resolved on its own. Mirrors web/src/core/matching/matching.ts.

A matching is {"tables": [{table, model, columns, children, unused}]}; a column match {column, source, conflicts}; a
source {kind: field, field} | {kind: lookup, field, table, by} | {kind: database}."""

from ..analysis.constraints import read_constraints
from ..decisions.decision import decision, reason
from ..js import js_string
from ..model.naming import name_words, singularize

# Names

_MODEL_SUFFIXES = {"entity", "model", "dto", "record", "request", "response"}


def _singular_words(words: list[str]) -> list[str]:
    return [*words[:-1], singularize(words[-1])] if words else words


def _model_words(name: str) -> list[str]:
    """The words a model name is compared by: without its suffixes, the last one singular."""
    words = name_words(name)
    while len(words) > 1 and words[-1] in _MODEL_SUFFIXES:
        words.pop()
    return _singular_words(words)


def _key(words: list[str]) -> str:
    return " ".join(words)


# Types

# The column kinds a model type can be kept in
_COMPATIBLE = {
    # Exact decimals often travel as text
    "string": ["text", "uuid", "enum", "date", "time", "datetime", "decimal", "json", "unknown"],
    "integer": ["integer", "decimal", "boolean", "unknown"],
    "float": ["float", "decimal", "unknown"],
    "decimal": ["decimal", "float", "text", "unknown"],
    "boolean": ["boolean", "integer", "unknown"],
    "date": ["date", "datetime", "text", "unknown"],
    "datetime": ["datetime", "text", "integer", "unknown"],
    "time": ["time", "text", "unknown"],
    "duration": ["integer", "text", "unknown"],
    "uuid": ["uuid", "text", "binary", "unknown"],
    "binary": ["binary", "unknown"],
    "any": ["json", "text", "unknown"],
}

# Languages with one type for every number (`number`): a whole number is one of its values
_ONE_NUMBER = {"typescript", "javascript"}


def _type_name(type_ref: dict) -> str:
    if type_ref["kind"] == "primitive":
        return type_ref["name"]
    if type_ref["kind"] == "array":
        return f"{_type_name(type_ref['items'])}[]"
    if type_ref["kind"] == "map":
        return "map"
    return type_ref["name"]


def _language(schema: dict) -> str | None:
    return (schema.get("origin") or {}).get("language")


def _compatible(type_ref: dict, column: dict, schema: dict) -> bool:
    """Whether a column can keep the values of a field's type."""
    kind = column["type"]["kind"]
    if (
        type_ref["kind"] == "primitive"
        and type_ref["name"] == "float"
        and kind == "integer"
        and (_language(schema) or "") in _ONE_NUMBER
    ):
        return True
    if type_ref["kind"] == "primitive":
        allowed = _COMPATIBLE.get(type_ref["name"])
        return kind in allowed if allowed is not None else True
    if type_ref["kind"] == "array":
        return kind in ("array", "json", "unknown")
    if type_ref["kind"] in ("map", "model"):
        return kind in ("json", "unknown")
    if type_ref["kind"] == "enum":
        found = next((item for item in schema["enums"] if item["name"] == type_ref["name"]), None)
        values = found["values"] if found else []
        numeric = bool(values) and all(
            isinstance(value.get("value"), (int, float)) and not isinstance(value.get("value"), bool)
            for value in values
        )
        return kind in ("integer", "unknown") if numeric else kind in ("enum", "text", "unknown")
    return True


def _accepted_values(column: dict, table: dict, database: dict) -> list[str] | None:
    """The values a column accepts: those of its enum type, or of a CHECK `IN` on it."""
    if column["type"]["kind"] == "enum":
        found = next((item for item in database["enums"] if item["name"] == column["type"]["name"]), None)
        if found:
            return found["values"]
    for check in table["checks"]:
        parsed = check.get("parsed")
        if parsed and parsed["kind"] == "in" and parsed["column"] == column["name"]:
            return [js_string(value) for value in parsed["values"]]
    return None


def _field_values(type_ref: dict, schema: dict) -> list[str] | None:
    """The values a field of an enum type sends."""
    if type_ref["kind"] != "enum":
        return None
    found = next((item for item in schema["enums"] if item["name"] == type_ref["name"]), None)
    if not found:
        return None
    return [js_string(value["value"] if value.get("value") is not None else value["name"]) for value in found["values"]]


def _conflicts_of(field: dict, column: dict, table: dict, database: dict, schema: dict) -> list[dict]:
    """Where the field and the column disagree."""
    conflicts: list[dict] = []
    declared = read_constraints(field, _language(schema))["constraints"]
    column_type = column["type"]
    max_length = declared.get("maxLength")
    if (
        column_type["kind"] == "text"
        and column_type.get("length") is not None
        and max_length is not None
        and max_length > column_type["length"]
    ):
        conflicts.append({"kind": "length", "model": max_length, "column": column_type["length"]})
    required = not column["nullable"] and not column.get("default") and not column.get("generated")
    if required and (field.get("optional") or field.get("nullable")):
        conflicts.append({"kind": "nullable"})
    if not _compatible(field["type"], column, schema):
        conflicts.append({"kind": "type", "model": _type_name(field["type"]), "column": column_type["kind"]})
    sent = _field_values(field["type"], schema)
    accepted = _accepted_values(column, table, database)
    if sent is not None and accepted is not None:
        # A value that differs only in case is converted on the way: only one the column does not have is a conflict
        lower = [value.lower() for value in accepted]
        missing = [value for value in sent if value.lower() not in lower]
        if missing:
            conflicts.append({"kind": "values", "missing": missing})
    return conflicts


# Rules


def _fields_of(model: dict, schema: dict, seen: set | None = None) -> list[dict]:
    """All fields of a model, with those of the models it extends first."""
    seen = seen if seen is not None else set()
    seen.add(model["name"])
    inherited: list[dict] = []
    for name in model.get("extends") or []:
        parent = next((item for item in schema["models"] if item["name"] == name), None)
        if parent is not None and parent["name"] not in seen:
            inherited.extend(_fields_of(parent, schema, seen))
    return [*inherited, *model["fields"]]


def _match_model(table: dict, schema: dict) -> dict:
    """The model of a table: the one whose name, without its suffixes and plural, is the table's or its entity's."""
    names = [table["name"], *([table["entity"]] if table.get("entity") else [])]
    targets = [_key(_singular_words(name_words(name))) for name in names]
    found = [model for model in schema["models"] if _key(_model_words(model["name"])) in targets]
    options = [*(model["name"] for model in found), None]
    if len(found) == 1:
        return decision(found[0]["name"], "exact", [reason("modelName", {"model": found[0]["name"]})], options)
    if len(found) > 1:
        models = ", ".join(model["name"] for model in found)
        return decision(found[0]["name"], "review", [reason("modelNames", {"models": models})], options)
    return decision(None, "none", [reason("noModel")], [*(model["name"] for model in schema["models"]), None])


def _field_names(field: dict) -> list[str]:
    """The names a field answers to: its own, its name on the wire and its aliases."""
    return [
        field["name"],
        *([field["serializedName"]] if field.get("serializedName") else []),
        *(field.get("aliases") or []),
    ]


def _field_for(column: dict, fields: list[dict], taken: set[str]) -> tuple[dict, str] | None:
    """The field a column comes from: the same name (exact), or the same words in another convention (probable)."""
    names = [column["name"], *([column["attribute"]] if column.get("attribute") else [])]
    free = [field for field in fields if field["name"] not in taken]
    exact = next((field for field in free if any(name in names for name in _field_names(field))), None)
    if exact is not None:
        return exact, "exact"
    words = [_key(name_words(name)) for name in names]
    close = next(
        (field for field in free if any(_key(name_words(name)) in words for name in _field_names(field))), None
    )
    return (close, "probable") if close is not None else None


def _lookup_for(column: dict, table: dict, fields: list[dict], taken: set[str], database: dict) -> dict | None:
    """A lookup: a field `<x><Column>` (`categoryName`) for a foreign key `<x>_id` to a table with that column."""
    foreign = next(
        (item for item in table["foreignKeys"] if item["columns"] == [column["name"]]),
        None,
    )
    if foreign is None:
        return None
    target = next((item for item in database["tables"] if item["name"] == foreign["references"]["table"]), None)
    if target is None:
        return None
    # The words that name the parent: the column without its `id`, or the navigation name
    column_words = name_words(column["name"])
    prefixes = [
        column_words[:-1] if column_words and column_words[-1] == "id" else column_words,
        *([name_words(foreign["attribute"])] if foreign.get("attribute") else []),
        _singular_words(name_words(target["name"])),
    ]
    prefixes = [words for words in prefixes if words]
    for field in fields:
        if field["name"] in taken or field["type"]["kind"] == "array":
            continue
        words = name_words(field["name"])
        for prefix in prefixes:
            if words[: len(prefix)] != prefix or len(words) == len(prefix):
                continue
            rest = words[len(prefix) :]
            by = next((item for item in target["columns"] if name_words(item["name"]) == rest), None)
            if by is None or by["name"] in foreign["references"]["columns"]:
                continue
            key = target["primaryKey"] or []
            unique = any(item["columns"] == [by["name"]] for item in target["uniques"]) or key == [by["name"]]
            return {"field": field, "table": target, "by": by["name"], "unique": unique}
    return None


def _children_for(field: dict, table: dict, database: dict) -> list[dict]:
    """The child table a list field stands for: a join table to the field's table, or a table that points here."""
    if field["type"]["kind"] != "array":
        return []
    words = name_words(field["name"])
    # `tagIds`, `tags`, `tagList` → tag
    while len(words) > 1 and words[-1] in ("ids", "id", "list", "set", "keys"):
        words.pop()
    wanted = _key(_singular_words(words))
    found: list[dict] = []
    for other in database["tables"]:
        points_here = [item for item in other["foreignKeys"] if item["references"]["table"] == table["name"]]
        if other is table or not points_here:
            continue
        # A join table: its other foreign key names what the field lists
        others = [item for item in other["foreignKeys"] if item["references"]["table"] != table["name"]]
        names = [other["name"], *(item["references"]["table"] for item in others)]
        keys = [_key(_singular_words(name_words(name))) for name in names]
        if any(item == wanted or item.endswith(f" {wanted}") for item in keys):
            found.append(other)
    return found


def _match_table(table: dict, database: dict, schema: dict) -> dict:
    model = _match_model(table, schema)
    definition = next((item for item in schema["models"] if item["name"] == model["value"]), None)
    fields = _fields_of(definition, schema) if definition is not None else []
    taken: set[str] = set()
    columns: list[dict] = []
    for column in table["columns"]:
        options = [*({"kind": "field", "field": field["name"]} for field in fields), None]
        if definition is None:
            columns.append({"column": column["name"], "source": decision(None, "none", [], []), "conflicts": []})
            continue
        found = _field_for(column, fields, taken)
        if found is not None:
            field, confidence = found
            taken.add(field["name"])
            conflicts = _conflicts_of(field, column, table, database, schema)
            code = "fieldName" if confidence == "exact" else "fieldWords"
            source = {"kind": "field", "field": field["name"]}
            columns.append(
                {
                    "column": column["name"],
                    "source": decision(
                        source,
                        "conflict" if conflicts else confidence,
                        [reason(code, {"field": field["name"]})],
                        options,
                    ),
                    "conflicts": conflicts,
                }
            )
            continue
        lookup = _lookup_for(column, table, fields, taken, database)
        if lookup is not None:
            taken.add(lookup["field"]["name"])
            source = {
                "kind": "lookup",
                "field": lookup["field"]["name"],
                "table": lookup["table"]["name"],
                "by": lookup["by"],
            }
            params = {"field": lookup["field"]["name"], "table": lookup["table"]["name"], "column": lookup["by"]}
            code = "lookupUnique" if lookup["unique"] else "lookupNotUnique"
            columns.append(
                {
                    "column": column["name"],
                    "source": decision(
                        source, "probable" if lookup["unique"] else "review", [reason(code, params)], [source, *options]
                    ),
                    "conflicts": [],
                }
            )
            continue
        if column.get("generated"):
            source = {"kind": "database"}
            columns.append(
                {
                    "column": column["name"],
                    "source": decision(source, "exact", [reason("generatedColumn")], [source, *options]),
                    "conflicts": [],
                }
            )
            continue
        # No field: the column keeps its default or null, unless it needs a value
        required = not column["nullable"] and "default" not in column
        source_decision = (
            decision(None, "conflict", [reason("noFieldRequired")], options)
            if required
            else decision(None, "none", [reason("noField")], options)
        )
        columns.append({"column": column["name"], "source": source_decision, "conflicts": []})
    children: list[dict] = []
    for field in fields:
        if field["name"] in taken:
            continue
        found_tables = _children_for(field, table, database)
        if not found_tables:
            continue
        taken.add(field["name"])
        options = [*(item["name"] for item in found_tables), None]
        if len(found_tables) == 1:
            params = {"field": field["name"], "table": found_tables[0]["name"]}
            choice = decision(found_tables[0]["name"], "probable", [reason("childRows", params)], options)
        else:
            params = {"field": field["name"], "tables": ", ".join(item["name"] for item in found_tables)}
            choice = decision(found_tables[0]["name"], "review", [reason("childTables", params)], options)
        children.append({"field": field["name"], "table": choice})
    unused = [field["name"] for field in fields if field["name"] not in taken and not field.get("generated")]
    return {"table": table["name"], "model": model, "columns": columns, "children": children, "unused": unused}


def match_models(database: dict, schema: dict) -> dict:
    """The matching of every table of the database with the application models."""
    return {"tables": [_match_table(table, database, schema) for table in database["tables"]]}
