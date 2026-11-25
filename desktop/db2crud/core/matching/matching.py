"""Matching application models with the tables of the database (docs/design.md, section 2): each table gets the model
it corresponds to, and each column the field it comes from, every proposal with its confidence and its reasons. Where
a model and a column disagree (a longer text, an optional field for a required column, another type, enum values the
column refuses), the conflict is shown and never resolved on its own. Mirrors web/src/core/matching/matching.ts.

A suffix may give a model a direction: a `Request`, `Input` or `Command` only goes into the table, a `Response` or
`Output` only comes out of it, so a table may have one model of each, matched with its columns on its own.

A matching is {"tables": [{table, models: [{direction, model, columns, children, unused}]}]}; a column match {column,
source, conflicts}; a source {kind: field, field} | {kind: lookup, field, table, by} | {kind: database}."""

from ..analysis.constraints import read_constraints
from ..decisions.decision import decision, keep, reason
from ..js import js_string
from ..model.naming import name_words
from .mapper import mapper_ignored, mapper_relation, mapper_source
from .names import DIRECTIONS as _DIRECTIONS
from .names import field_for as _field_for
from .names import fields_of as _fields_of
from .names import key as _key
from .names import model_name as _model_name
from .names import names_table
from .names import singular_words as _singular_words

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


def compatible(type_ref: dict, column: dict, schema: dict, database: dict) -> bool:
    """Whether a column can keep the values of a field's type."""
    kind = column["type"]["kind"]
    # MongoDB numbers are often declared without a size (Mongoose's `Number`): a whole number is one of their values
    whole = type_ref["kind"] == "primitive" and type_ref["name"] == "integer"
    if whole and kind == "float" and database["dialect"] == "mongodb":
        return True
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


def _conflicts_of(field: dict, column: dict, table: dict, database: dict, schema: dict, direction: str) -> list[dict]:
    """Where the field and the column disagree."""
    conflicts: list[dict] = []
    declared = read_constraints(field, _language(schema))["constraints"]
    column_type = column["type"]
    sent = _field_values(field["type"], schema)
    accepted = _accepted_values(column, table, database)
    if direction == "output":
        # Reading: a null or a value the model cannot take fails, a longer text does not
        if column["nullable"] and not field.get("optional") and not field.get("nullable"):
            conflicts.append({"kind": "nullable"})
        if not compatible(field["type"], column, schema, database):
            conflicts.append({"kind": "type", "model": _type_name(field["type"]), "column": column_type["kind"]})
        elif sent is not None and accepted is not None:
            lower = [value.lower() for value in sent]
            values = [value for value in accepted if value.lower() not in lower]
            if values:
                conflicts.append({"kind": "unknownValues", "values": values})
        return conflicts
    max_length = declared.get("maxLength")
    if (
        column_type["kind"] == "text"
        and column_type.get("length") is not None
        and max_length is not None
        and max_length > column_type["length"]
    ):
        conflicts.append({"kind": "length", "model": max_length, "column": column_type["length"]})
    required = not column["nullable"] and not column.get("default") and not column.get("generated")
    # A field left out that has a value of its own still sends one
    missing_value = field.get("nullable") or (field.get("optional") and field.get("defaultValue") is None)
    if required and missing_value:
        conflicts.append({"kind": "nullable"})
    if not compatible(field["type"], column, schema, database):
        conflicts.append({"kind": "type", "model": _type_name(field["type"]), "column": column_type["kind"]})
    # Another type already says it all: its values are not compared
    elif sent is not None and accepted is not None:
        # A value that differs only in case is converted on the way: only one the column does not have is a conflict
        lower = [value.lower() for value in accepted]
        missing = [value for value in sent if value.lower() not in lower]
        if missing:
            conflicts.append({"kind": "values", "missing": missing})
    return conflicts


# Rules


def _match_model(table: dict, schema: dict) -> list[tuple[str, dict]]:
    """The models of a table: those whose name, without its suffixes and plural, is the table's or its entity's, one
    per direction (exact), or several of one direction for review."""
    found = []
    for model in schema["models"]:
        words, direction = _model_name(model["name"])
        if names_table(words, table):
            found.append((model["name"], direction))
    if not found:
        options = [*(model["name"] for model in schema["models"]), None]
        return [("both", decision(None, "none", [reason("noModel")], options))]
    result = []
    for direction in _DIRECTIONS:
        group = [name for name, item in found if item == direction]
        if not group:
            continue
        options = [*group, None]
        if len(group) == 1:
            result.append((direction, decision(group[0], "exact", [reason("modelName", {"model": group[0]})], options)))
        else:
            models = ", ".join(group)
            result.append(
                (direction, decision(group[0], "review", [reason("modelNames", {"models": models})], options))
            )
    return result


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


def _match_table(table: dict, database: dict, schema: dict, previous: dict | None, project: dict | None) -> dict:
    # A Mapper project that relates the table says its model, for both directions
    relation = mapper_relation(table, project) if project else None
    if relation is not None:
        name = relation["model"]
        options = [name, *(model["name"] for model in schema["models"] if model["name"] != name), None]
        mapping = relation["mapping"]["id"]
        proposed = [("both", decision(name, "exact", [reason("mapperModel", {"mapping": mapping})], options))]
    else:
        proposed = _match_model(table, schema)
    models = []
    for direction, model in proposed:
        before = next((item for item in (previous or {}).get("models", []) if item["direction"] == direction), None)
        chosen = keep(before["model"] if before else None, model)
        follows = relation if relation is not None and relation["model"] == chosen["value"] else None
        models.append(_match_columns(table, direction, chosen, database, schema, before, follows))
    return {"table": table["name"], "models": models}


def _match_columns(
    table: dict,
    direction: str,
    model: dict,
    database: dict,
    schema: dict,
    previous: dict | None,
    relation: dict | None,
) -> dict:
    """Where each column of a table comes from (or goes to) in one of its models."""
    # The choices made on the columns of another model do not apply to this one
    before = previous if previous is not None and previous["model"]["value"] == model["value"] else None
    definition = next((item for item in schema["models"] if item["name"] == model["value"]), None)
    fields = _fields_of(definition, schema) if definition is not None else []
    taken: set[str] = set()
    mapper_taken: set[str] = set()
    columns: list[dict] = []
    for column in table["columns"]:
        options = [*({"kind": "field", "field": field["name"]} for field in fields), None]
        if definition is None:
            columns.append({"column": column["name"], "source": decision(None, "none", [], []), "conflicts": []})
            continue
        # With a Mapper relation, the mapping says where each column comes from; a column it leaves out has no field
        mapped = mapper_source(relation, column, mapper_taken) if relation is not None else None
        if mapped is not None:
            source, confidence, reasons = mapped
            columns.append(
                {
                    "column": column["name"],
                    "source": decision(source, confidence, reasons, [source, *options]),
                    "conflicts": [],
                }
            )
            continue
        found = _field_for(column, fields, taken) if relation is None else None
        if found is not None:
            field, confidence = found
            taken.add(field["name"])
            conflicts = _conflicts_of(field, column, table, database, schema, direction)
            code = "fieldName" if confidence == "exact" else "fieldWords"
            source = {"kind": "field", "field": field["name"]}
            columns.append(
                {
                    "column": column["name"],
                    "source": decision(
                        source,
                        "conflict" if conflicts else "exact",
                        [reason(code, {"field": field["name"]})],
                        options,
                    ),
                    "conflicts": conflicts,
                }
            )
            continue
        lookup = _lookup_for(column, table, fields, taken, database) if relation is None else None
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
        if column.get("generated") and direction != "output":
            source = {"kind": "database"}
            columns.append(
                {
                    "column": column["name"],
                    "source": decision(source, "exact", [reason("generatedColumn")], [source, *options]),
                    "conflicts": [],
                }
            )
            continue
        # No field: the column keeps its default or null, unless it needs a value; a model that only reads skips it
        required = (
            direction != "output" and not column["nullable"] and "default" not in column and not column.get("generated")
        )
        source_decision = (
            decision(None, "conflict", [reason("noFieldRequired")], options)
            if required
            else decision(None, "none", [reason("noField")], options)
        )
        columns.append({"column": column["name"], "source": source_decision, "conflicts": []})
    children: list[dict] = []
    for field in fields if relation is None else []:
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
        chosen = (
            next((item["table"] for item in before["children"] if item["field"] == field["name"]), None)
            if before
            else None
        )
        children.append({"field": field["name"], "table": keep(chosen, choice)})
    _keep_sources(columns, before, fields, table, database, schema, direction)
    # Unused: what no column or child table takes once the user's choices are applied
    used = set(mapper_ignored(relation)) if relation is not None else set()
    for item in columns:
        value = item["source"]["value"]
        if value and value["kind"] == "mapper":
            used.update(path.split(".")[0] for path in value["fields"])
        elif value and value["kind"] != "database":
            used.add(value["field"])
    used.update(item["field"] for item in children if item["table"]["value"] is not None)
    unused = [field["name"] for field in fields if field["name"] not in used and not field.get("generated")]
    return {"direction": direction, "model": model, "columns": columns, "children": children, "unused": unused}


def _keep_sources(
    columns: list[dict],
    before: dict | None,
    fields: list[dict],
    table: dict,
    database: dict,
    schema: dict,
    direction: str,
) -> None:
    """Keeps the sources the user chose, with the conflicts of the field chosen."""
    if before is None:
        return
    fields_by_name = {field["name"]: field for field in fields}
    columns_by_name = {column["name"]: column for column in table["columns"]}
    for index, item in enumerate(columns):
        previous = next((other["source"] for other in before["columns"] if other["column"] == item["column"]), None)
        source = keep(previous, item["source"])
        if source is item["source"]:
            continue
        value = source["value"]
        chosen = fields_by_name.get(value["field"]) if value and value["kind"] == "field" else None
        column = columns_by_name[item["column"]]
        conflicts = _conflicts_of(chosen, column, table, database, schema, direction) if chosen else []
        columns[index] = {**item, "source": source, "conflicts": conflicts}


def match_models(database: dict, schema: dict, previous: dict | None = None, project: dict | None = None) -> dict:
    """The matching of every table of the database with the application models, keeping the choices of `previous`.
    With a Mapper project, `schema` holds the models of both its sides (`mapper_models`), and its relations come
    first."""
    tables = []
    for table in database["tables"]:
        before = next((item for item in (previous or {}).get("tables", []) if item["table"] == table["name"]), None)
        tables.append(_match_table(table, database, schema, before, project))
    return {"tables": tables}
