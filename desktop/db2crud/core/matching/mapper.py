"""The matching of a table with a Mapper project (Mapper's `mapper-project`): one side of a model mapping is the
table (its model's fields are the columns, by name), the other the application model. When the table is the target,
the mapping says how the model is written into it; when it is the source, how a row is read into the model. The same
relation serves the other direction only when its transformation can be undone without loss (`invertible`);
otherwise that direction is left for review and the generated code leaves a `TODO`. Mirrors
web/src/core/matching/mapper.ts.

A relation is {mapping, side: source | target (the table's), model (the application model), tableFields}; a source
{kind: mapper, mapping, fields, transform, inverse}."""

from ..decisions.decision import reason
from ..interop.mapper.read import invertible
from .names import field_for, fields_of, model_name, names_table


def _fields_of_model(schema: dict, name: str) -> list[dict] | None:
    model = next((item for item in schema["models"] if item["name"] == name), None)
    return fields_of(model, schema) if model is not None else None


def _columns_named(fields: list[dict], table: dict) -> int:
    """How many columns the fields of a model name."""
    return sum(1 for column in table["columns"] if field_for(column, fields, set()) is not None)


def mapper_relation(table: dict, project: dict) -> dict | None:
    """The model mapping of a project that relates a table, with the side the table is: the side whose model is named
    like the table; when both are (`UserDto` and `User`), the one whose fields name more columns, the target on a
    tie."""
    ordered = sorted(project["mappings"], key=lambda mapping: mapping["id"] != project["root"])
    for mapping in ordered:
        target_fields = _fields_of_model(project["target"]["schema"], mapping["target"])
        source_fields = _fields_of_model(project["source"]["schema"], mapping["source"])
        target = target_fields is not None and names_table(model_name(mapping["target"])[0], table)
        source = source_fields is not None and names_table(model_name(mapping["source"])[0], table)
        if not target and not source:
            continue
        if target and source:
            side = "source" if _columns_named(source_fields, table) > _columns_named(target_fields, table) else "target"
        else:
            side = "target" if target else "source"
        if side == "target":
            return {"mapping": mapping, "side": side, "model": mapping["source"], "tableFields": target_fields}
        return {"mapping": mapping, "side": side, "model": mapping["target"], "tableFields": source_fields}
    return None


def mapper_source(relation: dict, column: dict, taken: set[str]) -> tuple[dict, str, list[dict]] | None:
    """Where a column comes from in a relation, with its confidence and reasons; None when the mapping says nothing
    of it."""
    found = field_for(column, relation["tableFields"], taken)
    if found is None:
        return None
    name = found[0]["name"]
    taken.add(name)
    relevant = [item for item in relation["mapping"]["fields"] if item["status"] in ("active", "pending")]
    if relation["side"] == "target":
        field = next((item for item in relevant if item["target"] == name), None)
    else:
        field = next(
            (item for item in relevant if any(len(path) == 1 and path[0] == name for path in item["sources"])), None
        )
    if field is None:
        return None
    fields = [".".join(path) for path in field["sources"]] if relation["side"] == "target" else [field["target"]]
    inverse = invertible(field["transform"])
    kind = field["transform"]["kind"]
    source = {
        "kind": "mapper",
        "mapping": relation["mapping"]["id"],
        "fields": fields,
        "transform": kind,
        "inverse": inverse,
    }
    params = {"fields": ", ".join(fields), "transform": kind}
    if field["status"] == "pending":
        return source, "review", [reason("mapperPending", params)]
    if inverse:
        return source, "exact", [reason("mapperField", params)]
    return source, "review", [reason("mapperOneWay", params)]


def mapper_ignored(relation: dict) -> list[str]:
    """The fields of the application model left out on purpose in Mapper: they are not reported as unused."""
    return relation["mapping"]["ignoredSources"] if relation["side"] == "target" else []
