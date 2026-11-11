"""The fields that hold other models, lists or maps, as the design decided to store them: columns, foreign
keys, child tables and join tables. Mirrors web/src/core/physical/relational/relations.ts."""

import re

from ...design.analysis import singular_field
from ...design.types import find_model_design
from ...js import coalesce
from ...model.naming import name_words, to_snake_case
from ...model.schema import all_fields, find_model
from ..naming import column_name, free_name, join_names
from .build import Entity, RelationalBuild
from .names import DEFAULT_LENGTH, field_column, key_column_name, owned_table_name, stores_null


def add_relations(build: RelationalBuild) -> None:
    joins: set[str] = set()
    # Lists whose foreign key is the child's own reference, which may be built later
    inverses: list[dict] = []
    for entity in list(build.entities.values()):
        for field, decided in build.fields_of(entity):
            relation = decided.get("relation") if decided else None
            if not decided or not decided["include"] or not relation:
                continue
            if relation["status"] == "pending":
                build.todo(entity.table, "relationPending", {"field": field["name"]})
                continue
            type_ref = field["type"]
            items = (
                type_ref["items"]
                if type_ref["kind"] == "array"
                else type_ref["value"]
                if type_ref["kind"] == "map"
                else type_ref
            )
            target_name = items["name"] if items["kind"] == "model" else None
            target = build.entities.get(target_name) if target_name else None

            def missing(entity=entity, field=field, target_name=target_name):
                build.todo(entity.table, "targetNotStored", {"field": field["name"], "model": target_name or ""})

            value = relation["value"]
            if value == "json":
                _add_column(build, entity, field, decided, {"kind": "json"})
            elif value == "array":
                _add_array(build, entity, field, decided, items)
            elif value == "flatten":
                if target_name:
                    _flatten(
                        build,
                        entity.table,
                        entity.used,
                        [coalesce(decided.get("column"), field["name"])],
                        target_name,
                        stores_null(field),
                        f"{entity.model['name']}.{field['name']}",
                        {entity.model["name"]},
                    )
            elif value == "reference":
                if target:
                    _reference(build, entity, field, decided, target)
                else:
                    missing()
            elif value == "child":
                if target_name:
                    if target:
                        _child_models(build, entity, field, target, inverses)
                    else:
                        missing()
                else:
                    _child_values(build, entity, field, decided, items, type_ref["kind"] == "map")
            elif value == "join":
                if target:
                    _join(build, entity, field, target, joins)
                else:
                    missing()
            # `embed` is only for documents
    for item in inverses:
        fk = next(
            (candidate for candidate in item["table"]["foreignKeys"] if candidate.get("field") == item["field"]), None
        )
        if fk:
            fk["inverse"] = item["inverse"]


def _add_column(build: RelationalBuild, entity: Entity, field: dict, decided: dict, column_type: dict) -> None:
    entity.table["columns"].append(
        {
            "name": free_name(field_column(field, decided, build.options), entity.used),
            "type": column_type,
            "nullable": stores_null(field),
            "source": f"{entity.model['name']}.{field['name']}",
        }
    )


def _add_array(build: RelationalBuild, entity: Entity, field: dict, decided: dict, items: dict) -> None:
    """A native array column in PostgreSQL; JSON in the others, with a note."""
    path = f"{entity.model['name']}.{field['name']}"
    if build.options["dialect"] != "postgresql":
        build.notes.append({"code": "arrayAsJson", "params": {"field": path}})
        _add_column(build, entity, field, decided, {"kind": "json"})
    else:
        _add_column(build, entity, field, decided, {"kind": "array", "items": build.column_type(items, field, path)})


def _flatten(
    build: RelationalBuild,
    table: dict,
    used: set[str],
    prefix: list[str],
    target: str,
    nullable: bool,
    path: str,
    seen: set[str],
) -> None:
    """Columns of a value object, prefixed with the field that holds it: `address_city`."""
    model = find_model(build.schema, target)
    if not model or target in seen:
        return
    for field in all_fields(build.schema, model):
        field_path = f"{path}.{field['name']}"
        optional = nullable or stores_null(field)
        if field["type"]["kind"] == "model":
            _flatten(
                build,
                table,
                used,
                [*prefix, field["name"]],
                field["type"]["name"],
                optional,
                field_path,
                {*seen, target},
            )
            continue
        column = {
            "name": free_name(join_names([*prefix, field["name"]], build.options["naming"]), used),
            "type": build.column_type(field["type"], field, field_path),
            "nullable": optional,
        }
        if "defaultValue" in field:
            column["defaultValue"] = field["defaultValue"]
        column["source"] = field_path
        table["columns"].append(column)


def _reference(build: RelationalBuild, entity: Entity, field: dict, decided: dict, target: Entity) -> None:
    """A foreign key to another stored model (many-to-one)."""
    # `customer: Customer` next to `customerId` (or Prisma's `@relation(fields: [customerId])`): reuse it
    existing = _existing_key_column(build, entity, field)
    if existing:
        build.foreign_key(entity.table, existing, target, None, {"field": field["name"]})
        return
    if not target.key:
        build.todo(entity.table, "foreignKeyTargetNotStored", {"column": field["name"], "model": target.model["name"]})
        return
    name = free_name(
        key_column_name(coalesce(decided.get("column"), field["name"]), target.key["column"], build.options),
        entity.used,
    )
    entity.table["columns"].append(
        {
            "name": name,
            "type": target.key["type"],
            "nullable": stores_null(field),
            "source": f"{entity.model['name']}.{field['name']}",
        }
    )
    build.foreign_key(entity.table, name, target, None, {"field": field["name"]})


def _existing_key_column(build: RelationalBuild, entity: Entity, field: dict) -> str | None:
    """The scalar column that already holds the key of a referenced model: `customerId` next to `customer`,
    or the one Prisma names in `@relation(fields: [...])`."""
    relation = next((item for item in field.get("annotations") or [] if item["name"] == "relation"), None)
    named = None
    if relation and relation.get("args"):
        match = re.search(r"fields\s*:\s*\[\s*(\w+)", relation["args"], flags=re.ASCII)
        named = match.group(1) if match else None
    words = "".join([*name_words(field["name"]), "id"])
    for other, decided in build.fields_of(entity):
        if not decided or not decided["include"] or decided.get("relation") or other["name"] == field["name"]:
            continue
        if other["name"] == named or "".join(name_words(other["name"])) == words:
            return field_column(other, decided, build.options)
    return None


def _child_models(build: RelationalBuild, owner: Entity, field: dict, child: Entity, inverses: list[dict]) -> None:
    """A list of models stored in their own table, pointing back to the owner (one-to-many)."""
    if not owner.key:
        build.todo(owner.table, "keyPending", {"model": owner.model["name"]})
        return
    # A field of the child that already points to the owner
    if child.model["name"] != owner.model["name"]:
        owner_words = "".join(name_words(owner.model["name"]))
        for back, decided in build.fields_of(child):
            if not decided or not decided["include"]:
                continue
            if back["type"]["kind"] == "model" and back["type"]["name"] == owner.model["name"]:
                # The child's own reference creates the foreign key; this list is its other side
                relation = decided.get("relation")
                if relation and relation["status"] == "active" and relation["value"] == "reference":
                    inverses.append({"table": child.table, "field": back["name"], "inverse": field["name"]})
                    return
                continue
            words = name_words(back["name"])
            if (
                back["type"]["kind"] == "primitive"
                and len(words) > 1
                and words[-1] == "id"
                and "".join(words[:-1]) == owner_words
            ):
                build.foreign_key(
                    child.table, field_column(back, decided, build.options), owner, None, {"inverse": field["name"]}
                )
                return
    is_self = child.model["name"] == owner.model["name"]
    name = free_name(
        key_column_name("parent" if is_self else owner.model["name"], owner.key["column"], build.options), child.used
    )
    # Rows that only exist inside this list go with their owner; shared ones stay
    key = (find_model_design(build.design, child.model["name"]) or {}).get("key")
    named_key = bool(key) and any(reason["code"] in ("keyDeclared", "keyNamed") for reason in key["reasons"])
    owned = not is_self and not named_key
    child.table["columns"].append(
        {
            "name": name,
            "type": owner.key["type"],
            "nullable": is_self or not owned,
            "source": f"{owner.model['name']}.{field['name']}",
        }
    )
    build.foreign_key(
        child.table,
        name,
        owner,
        "cascade" if owned else None,
        {"field": "parent", "inverse": field["name"]} if is_self else {"inverse": field["name"]},
    )


def _child_values(build: RelationalBuild, owner: Entity, field: dict, decided: dict, items: dict, is_map: bool) -> None:
    """A list of plain values (one row per value, in order) or a map (one row per key)."""
    if not owner.key:
        build.todo(owner.table, "keyPending", {"model": owner.model["name"]})
        return
    options = build.options
    table = build.new_table(
        owned_table_name(owner.model["name"], coalesce(decided.get("column"), field["name"]), options),
        "map" if is_map else "list",
        owner.model["name"],
        field["name"],
    )
    used: set[str] = set()
    owner_column = free_name(key_column_name(owner.model["name"], owner.key["column"], options), used)
    if is_map:
        second = {
            "name": free_name(column_name("key", options["naming"]), used),
            "type": {"kind": "primitive", "name": "string", "length": DEFAULT_LENGTH},
        }
    else:
        second = {
            "name": free_name(column_name("position", options["naming"]), used),
            "type": {"kind": "primitive", "name": "integer", "bits": 32},
        }
    path = f"{owner.model['name']}.{field['name']}"
    value = {
        "name": free_name(column_name("value", options["naming"]), used),
        "type": build.column_type(items, field, path),
        "nullable": is_map or (field["type"]["kind"] == "array" and field["type"].get("itemsNullable") is True),
    }
    if not is_map:
        value["source"] = path
    table["columns"].extend(
        [{"name": owner_column, "type": owner.key["type"], "nullable": False}, {**second, "nullable": False}, value]
    )
    table["primaryKey"] = [owner_column, second["name"]]
    build.foreign_key(table, owner_column, owner, "cascade", {"inverse": field["name"]})
    build.extra_tables.append(table)


def _join(build: RelationalBuild, owner: Entity, field: dict, other: Entity, joins: set[str]) -> None:
    """A many-to-many list: a table with the keys of both sides. Both lists of a pair share it."""
    if not owner.key or not other.key:
        build.todo(owner.table, "keyPending", {"model": (other if owner.key else owner).model["name"]})
        return
    is_self = owner.model["name"] == other.model["name"]
    mirror = None
    if not is_self:
        for item, decided in build.fields_of(other):
            relation = (decided or {}).get("relation")
            if (
                item["type"]["kind"] == "array"
                and item["type"]["items"]["kind"] == "model"
                and item["type"]["items"]["name"] == owner.model["name"]
                and decided
                and decided["include"]
                and relation
                and relation["status"] == "active"
                and relation["value"] == "join"
            ):
                mirror = item
                break
    pair = "|".join(
        sorted([f"{owner.model['name']}.{field['name']}", f"{other.model['name']}.{mirror['name']}" if mirror else ""])
    )
    if pair in joins:
        return
    joins.add(pair)
    names = (
        [owner.table["name"], to_snake_case(field["name"])]
        if is_self
        else sorted([owner.table["name"], other.table["name"]])
    )
    table = build.new_table("_".join(names), "join", owner.model["name"], field["name"])
    if mirror:
        table["mirror"] = mirror["name"]
    used: set[str] = set()
    first = free_name(key_column_name(owner.model["name"], owner.key["column"], build.options), used)
    second = free_name(
        key_column_name(
            singular_field(field["name"]) if is_self else other.model["name"], other.key["column"], build.options
        ),
        used,
    )
    table["columns"].extend(
        [
            {"name": first, "type": owner.key["type"], "nullable": False},
            {"name": second, "type": other.key["type"], "nullable": False},
        ]
    )
    table["primaryKey"] = [first, second]
    build.foreign_key(table, first, owner, "cascade")
    build.foreign_key(table, second, other, "cascade")
    # The primary key already indexes the first column
    table["indexes"] = [index for index in table["indexes"] if index["columns"][0] != first]
    build.extra_tables.append(table)
