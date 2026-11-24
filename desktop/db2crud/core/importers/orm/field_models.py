"""Reads ORMs that declare a table as a class of field objects (Django, Tortoise): classes of a `Model` (and of abstract
models, whose fields they inherit), their fields with the options that reach the database, `Meta` (the table,
constraints, indexes, `unique_together`), foreign keys and one-to-one fields (a column `<name>_id`), many-to-many
fields and enums. What changes from one ORM to another (names of fields and options, the table and key they give a
model, the table of a many-to-many field) is its flavour. `on_delete` lives in the application; the reader takes it as
what the database should do, as Model2DB writes it. A model with `managed = False` is a table the ORM never creates: it
has only the indexes its `Meta` names, and a note says its key may exist only in the ORM. Mirrors
web/src/core/importers/orm/fieldModels.ts."""

import re
from collections.abc import Callable
from dataclasses import dataclass

from ...js import coalesce, js_string
from ...model.naming import to_snake_case
from ...schema.checks import check_of
from .expressions import boolean_of, literal_of, name_of, string_of, text_of
from .python import assignment_of, attributes_of, class_of, empty_table, is_now, is_uuid, read_modules

# Reading a model


@dataclass(frozen=True)
class FieldFlavour:
    """How an ORM of field classes names and reads what the engine reads."""

    format: str
    # The type of a field (`IntegerField`, `fields.IntField`): {type, enum?}, or None when it is not one the rules know
    type_of: Callable[[dict, dict], dict | None]
    # Whether the database numbers a field: (kind, named, type, primary key)
    identity: Callable[[str, dict, dict | None, bool], bool]
    # Whether a field keeps numbers from 0 up, with a CHECK
    positive: Callable[[str], bool]
    foreign_key: str
    one_to_one: str
    many_to_many: str
    # The names of the options: the column (`db_column`), its comment, the table and the table's comment
    options: dict
    # The table of a model whose `Meta` does not name one
    default_table: Callable[[dict], str]
    # The key the ORM gives a model that declares none
    implicit_key: Callable[[], dict]
    # What a foreign key does on delete when it does not say
    on_delete: str | None
    # The ORM indexes every foreign key on its own
    indexes_keys: bool
    # The table of a many-to-many field, or None when a model of its own maps it: (model, target, relation, models)
    join_table: Callable[[dict, dict, dict, list], dict | None]


_ON_DELETE = {
    "CASCADE": "cascade",
    "SET_NULL": "set null",
    "SET_DEFAULT": "set default",
    "RESTRICT": "restrict",
    "NO_ACTION": "no action",
}


def _target_of(expr: dict | None, self_name: str) -> str:
    """The class a relation names: `"Product"`, `"shop.Product"`, `Product` or `"self"`."""
    text = string_of(expr)
    if text is None:
        text = ".".join(expr["path"]) if expr is not None and expr["kind"] == "name" else ""
    name = text.split(".")[-1]
    return self_name if name == "self" else name


def _meta_of(definition: dict) -> dict:
    """`Meta`'s settings, by name."""
    meta: dict = {}
    for statement in definition["body"]:
        inner = class_of(statement)
        if not inner or inner["name"] != "Meta":
            continue
        for item in map(assignment_of, inner["body"]):
            if item and item["value"] is not None:
                meta[item["name"]] = item["value"]
    return meta


def _default_value(expr: dict, enums: dict) -> dict | None:
    """The value stored for a default: `OrderStatus.PAID` is `"paid"`."""
    literal = literal_of(expr)
    if literal is not None:
        return {"kind": "literal", "value": literal}
    if expr["kind"] == "name" and len(expr["path"]) >= 2:
        enum_class = enums.get(expr["path"][-2])
        member = (
            next((item for item in enum_class["members"] if item["name"] == expr["path"][-1]), None)
            if enum_class
            else None
        )
        if member:
            return {"kind": "literal", "value": member["value"]}
    return None


def _database_default(expr: dict, column: dict) -> None:
    """`db_default=Now()`, `db_default=Value(0)` or `db_default=0`: what the database fills in."""
    if is_now(expr):
        column["generated"] = "now"
    elif is_uuid(expr):
        column["generated"] = "uuid"
    else:
        is_value = name_of(expr) == "Value" and expr["kind"] == "call"
        value = literal_of(expr["args"][0] if expr["args"] else None) if is_value else literal_of(expr)
        column["default"] = (
            {"kind": "literal", "value": value} if value is not None else {"kind": "expression", "sql": text_of(expr)}
        )


def _choices_of(expr: dict | None, enums: dict, fallback: str) -> dict | None:
    """The enum a field's `choices` name: `OrderStatus.choices`, or a list of `(value, label)` pairs."""
    if expr is None:
        return None
    if expr["kind"] in ("attribute", "name"):
        path = expr["path"] if expr["kind"] == "name" else [name_of(expr["target"]) or "", expr["name"]]
        enum_class = enums.get(path[-2] if len(path) >= 2 else "") if path[-1] == "choices" else None
        if enum_class:
            return {
                "name": to_snake_case(enum_class["name"]),
                "values": [js_string(member["value"]) for member in enum_class["members"]],
                "storage": "check",
            }
    if expr["kind"] == "list":
        values = [literal_of(item["items"][0] if item["kind"] == "list" else item) for item in expr["items"]]
        if all(isinstance(value, (str, int, float)) and not isinstance(value, bool) for value in values):
            return {"name": fallback, "values": [js_string(value) for value in values], "storage": "check"}
    return None


def _add_field(flavour: FieldFlavour, model: dict, item: dict, enums: dict, enums_used: list, notes: list) -> None:
    """Adds a field to its model: a column, a key, or a many-to-many table."""
    field = item["value"]
    if field is None or field["kind"] != "call":
        return
    kind = name_of(field) or ""
    named = field["named"]
    table = model["table"]
    if kind == "CompositePrimaryKey":
        model["compositeKey"] = [name for name in map(string_of, field["args"]) if name]
        return
    target_expr = field["args"][0] if field["args"] else named.get("to")
    if kind == flavour.many_to_many:
        inverse = string_of(named.get("related_name"))
        model["manyToMany"].append(
            {
                "attribute": item["name"],
                "target": _target_of(target_expr, model["def"]["name"]),
                **({"inverse": inverse} if inverse and not inverse.endswith("+") else {}),
                "named": named,
            }
        )
        return
    relation = kind in (flavour.foreign_key, flavour.one_to_one)
    if not relation and not kind.endswith("Field"):
        return
    primary_key = boolean_of(named.get("primary_key")) is True or boolean_of(named.get("pk")) is True
    declared = string_of(named.get(flavour.options["column"]))
    own = f"{item['name']}_id" if relation else item["name"]
    name = declared if declared is not None else own
    if relation:
        read = None
    elif kind == "GeneratedField":
        output = named.get("output_field")
        read = flavour.type_of(output, enums) if output is not None and output["kind"] == "call" else None
    else:
        read = flavour.type_of(field, enums)
    column_type = read["type"] if read else None
    if not relation and not column_type:
        notes.append(
            {"code": "orm.unknownType", "params": {"table": table["name"], "column": name, "type": text_of(field)}}
        )
    column: dict = {
        "name": name,
        "type": column_type or {"sql": "" if relation else text_of(field), "kind": "unknown"},
        "nullable": not primary_key and (boolean_of(named.get("null")) is True or kind == "NullBooleanField"),
    }
    if flavour.identity(kind, named, column_type, primary_key):
        column["generated"] = "identity"
    if kind == "GeneratedField" and "expression" in named:
        column["generated"] = {"computed": _computed_of(named["expression"])}
    if "auto_now" in named:
        column["generated"] = "onUpdateNow"
    elif "auto_now_add" in named:
        column["generated"] = "now"
    if "db_default" in named:
        _database_default(named["db_default"], column)
    value = named.get("default")
    if value is not None and not column.get("generated") and not relation:
        if is_uuid(value):
            column["generated"] = "uuid"
        elif is_now(value):
            column["generated"] = "now"
        else:
            fixed = _default_value(value, enums)
            if fixed and fixed["kind"] == "literal" and fixed["value"] is not None:
                column["default"] = fixed
    comment = string_of(named.get(flavour.options["comment"]))
    if comment:
        column["comment"] = comment
    if declared and declared != own:
        column["attribute"] = own
    table["columns"].append(column)
    model["columns"][item["name"]] = name
    if relation:
        model["columns"][f"{item['name']}_id"] = name
    if primary_key:
        table["primaryKey"] = [name]
    unique = boolean_of(named.get("unique")) is True or kind == flavour.one_to_one
    if unique and not primary_key:
        table["uniques"].append({"columns": [name]})
    # Django indexes every foreign key unless told not to; Tortoise only when `index=True` or `db_index=True`
    indexed = coalesce(boolean_of(named.get("db_index")), boolean_of(named.get("index")))
    if not unique and not primary_key:
        if indexed is True:
            table["indexes"].append({"columns": [name]})
        elif indexed is None and relation and flavour.indexes_keys:
            model["keyIndexes"].append(name)
    if flavour.positive(kind):
        table["checks"].append(check_of(f"{name} >= 0"))
    enum = read.get("enum") if read else None
    choices = enum or _choices_of(named.get("choices"), enums, f"{table['name']}_{name}")
    if choices and not any(used["name"] == choices["name"] for used in enums_used):
        enums_used.append(choices)
    # An enum field keeps its values in the application: the rules read them as a CHECK
    if enum:
        numeric = column_type is not None and column_type["kind"] == "integer"
        values = [value if numeric else "'" + value.replace("'", "''") + "'" for value in enum["values"]]
        table["checks"].append(check_of(f"{name} IN ({', '.join(values)})"))
    if relation:
        on_delete = _ON_DELETE.get(name_of(named["on_delete"]) or "") if "on_delete" in named else flavour.on_delete
        inverse = string_of(named.get("related_name"))
        to_field = string_of(named.get("to_field"))
        model["keys"].append(
            {
                "key": {
                    "columns": [name],
                    "references": {"table": "", "columns": []},
                    **({"onDelete": on_delete} if on_delete else {}),
                    "attribute": item["name"],
                    **({"inverse": inverse} if inverse and not inverse.endswith("+") else {}),
                },
                "target": _target_of(target_expr, model["def"]["name"]),
                **({"toField": to_field} if to_field else {}),
                "column": column,
            }
        )


def _field_columns(expr: dict | None, model: dict) -> list[str]:
    """The columns of a list of fields as `Meta` names them (`"-created_at"` is descending: the order does not
    count)."""
    items = expr["items"] if expr is not None and expr["kind"] == "list" else []
    names = [re.sub(r"^-", "", text) for text in map(string_of, items) if text is not None]
    return [model["columns"].get(name, name) for name in names if name]


_LOOKUPS = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<=", "exact": "="}


def _sql_value(item: dict) -> str | None:
    literal = literal_of(item)
    if isinstance(literal, str):
        return "'" + literal.replace("'", "''") + "'"
    return None if literal is None else js_string(literal)


def _condition_sql(expr: dict | None, model: dict) -> str | None:
    """`Q(status__in=["paid", "shipped"])` or `Q(price__gte=0)` as SQL, with the columns of the fields."""
    if expr is None or expr["kind"] != "call" or name_of(expr) != "Q":
        return None
    parts: list[str] = []
    for key, value in expr["named"].items():
        pieces = key.split("__")
        field = pieces[0]
        lookup = pieces[1] if len(pieces) > 1 else "exact"
        column = model["columns"].get(field, field)
        if lookup == "in" and value["kind"] == "list":
            values = [_sql_value(item) for item in value["items"]]
            if any(item is None for item in values):
                return None
            parts.append(f"{column} IN ({', '.join(values)})")
        elif lookup in _LOOKUPS and _sql_value(value) is not None:
            parts.append(f"{column} {_LOOKUPS[lookup]} {_sql_value(value)}")
        else:
            return None
    return " AND ".join(parts) if parts else None


def _computed_of(expr: dict) -> str:
    """The expression of a computed column: the SQL of a RawSQL, or the Python code."""
    sql = string_of(expr["args"][0]) if expr["kind"] == "call" and name_of(expr) == "RawSQL" and expr["args"] else None
    return sql if sql is not None else text_of(expr)


def _groups_of(expr: dict | None) -> list[dict]:
    """`unique_together = ("a", "b")` or `(("a", "b"), ("c", "d"))`: the groups of fields."""
    if expr is None or expr["kind"] != "list":
        return []
    if all(item["kind"] == "string" for item in expr["items"]):
        return [expr]
    return [item for item in expr["items"] if item["kind"] == "list"]


def _apply_meta(flavour: FieldFlavour, model: dict, notes: list) -> None:
    """What `Meta` says about the table: its name is read before, the rest once every column is known."""
    table, meta = model["table"], model["meta"]
    comment = string_of(meta.get(flavour.options["tableComment"]))
    if comment:
        table["comment"] = comment
    for group in _groups_of(meta.get("unique_together")):
        table["uniques"].append({"columns": _field_columns(group, model)})
    for group in _groups_of(meta.get("index_together")):
        table["indexes"].append({"columns": _field_columns(group, model)})
    constraints = meta.get("constraints")
    for item in constraints["items"] if constraints is not None and constraints["kind"] == "list" else []:
        if item["kind"] != "call":
            continue
        name = string_of(item["named"].get("name"))
        if name_of(item) == "UniqueConstraint":
            fields = item["named"].get("fields") or {"kind": "list", "items": item["args"]}
            table["uniques"].append({**({"name": name} if name else {}), "columns": _field_columns(fields, model)})
        elif name_of(item) == "CheckConstraint":
            condition = item["named"].get("condition") or item["named"].get("check")
            sql = _condition_sql(condition, model)
            if sql:
                table["checks"].append(check_of(sql, name))
            elif condition is not None:
                table["checks"].append({**({"name": name} if name else {}), "sql": text_of(condition)})
                notes.append(
                    {"code": "orm.unreadCheck", "params": {"table": table["name"], "check": text_of(condition)}}
                )
    indexes = meta.get("indexes")
    for item in indexes["items"] if indexes is not None and indexes["kind"] == "list" else []:
        if item["kind"] != "call" or name_of(item) != "Index":
            continue
        name = string_of(item["named"].get("name"))
        index = {**({"name": name} if name else {}), "columns": _field_columns(item["named"].get("fields"), model)}
        if index["columns"]:
            table["indexes"].append(index)
    if boolean_of(meta.get("managed")) is False:
        notes.append({"code": "orm.unmanagedTable", "params": {"table": table["name"]}})
        return
    # The index of a foreign key, unless the key or another index already starts with its column
    groups = [
        table["primaryKey"] or [],
        *(item["columns"] for item in table["uniques"]),
        *(item["columns"] for item in table["indexes"]),
    ]
    leading = [columns[0] if columns else None for columns in groups]
    for column in model["keyIndexes"]:
        if column not in leading:
            table["indexes"].append({"columns": [column]})


def _is_model(definition: dict, classes: dict, seen: set | None = None) -> bool:
    seen = set() if seen is None else seen
    seen.add(definition["name"])
    for base in definition["bases"]:
        if re.search(r"(^|\.)Model\Z", base):
            return True
        parent = classes.get(base.split(".")[-1])
        if parent is not None and parent["name"] not in seen and _is_model(parent, classes, seen):
            return True
    return False


def _is_abstract(definition: dict) -> bool:
    return boolean_of(_meta_of(definition).get("abstract")) is True


def _model_of(
    flavour: FieldFlavour, definition: dict, classes: dict, enums: dict, enums_used: list, notes: list
) -> dict:
    meta = _meta_of(definition)
    declared = string_of(meta.get(flavour.options["table"]))
    # A table of another schema: "sales"."orders", as Django leaves names already quoted
    qualified = re.fullmatch(r'"([^"]+)"\."([^"]+)"', declared or "")
    name = qualified.group(2) if qualified else declared
    table = empty_table(name if name is not None else flavour.default_table(definition), definition["line"])
    if qualified:
        table["schema"] = qualified.group(1)
    schema = string_of(meta.get("schema"))
    if schema:
        table["schema"] = schema
    table["entity"] = definition["name"]
    model = {
        "def": definition,
        "table": table,
        "columns": {},
        "keys": [],
        "manyToMany": [],
        "meta": meta,
        # Foreign key columns the ORM indexes on its own
        "keyIndexes": [],
    }
    # The fields of abstract models are inherited; a concrete parent keeps its own table
    for item in attributes_of(definition, classes, _is_abstract):
        _add_field(flavour, model, item, enums, enums_used, notes)
    if model.get("compositeKey") is not None:
        table["primaryKey"] = [model["columns"].get(field, field) for field in model["compositeKey"]]
    # A model without a primary key gets the ORM's own
    if table["primaryKey"] is None:
        table["columns"].insert(0, flavour.implicit_key())
        table["primaryKey"] = ["id"]
        model["columns"]["id"] = "id"
    model["columns"]["pk"] = table["primaryKey"][0]
    return model


# Resolving what refers to what


def _resolve(flavour: FieldFlavour, models: list[dict], notes: list) -> list[dict]:
    by_class = {model["def"]["name"]: model for model in models}
    joins: list[dict] = []
    for model in models:
        for pending in model["keys"]:
            target = by_class.get(pending["target"])
            columns = None
            if target:
                to_field = pending.get("toField")
                columns = [target["columns"].get(to_field, to_field)] if to_field else target["table"]["primaryKey"]
            if not target or not columns or len(columns) != 1:
                notes.append(
                    {
                        "code": "orm.unknownReference",
                        "params": {"table": model["table"]["name"], "column": pending["column"]["name"]},
                    }
                )
                continue
            target_table = target["table"]
            pending["key"]["references"] = {
                "table": target_table["name"],
                **({"schema": target_table["schema"]} if target_table.get("schema") else {}),
                "columns": columns,
            }
            model["table"]["foreignKeys"].append(pending["key"])
            # A key takes the type of the column it references, without its numbering
            referenced = next((column for column in target_table["columns"] if column["name"] == columns[0]), None)
            if referenced:
                pending["column"]["type"] = referenced["type"]
        for relation in model["manyToMany"]:
            target = by_class.get(relation["target"])
            if not target:
                notes.append(
                    {
                        "code": "orm.unknownReference",
                        "params": {"table": model["table"]["name"], "column": relation["attribute"]},
                    }
                )
                continue
            join = flavour.join_table(model, target, relation, models)
            if join:
                joins.append(join)
    return joins


def link_table(name: str, line: int, sides: list[tuple[str, dict]]) -> dict:
    """A table of two foreign keys to the primary keys of two models, both deleted with their rows."""
    table = empty_table(name, line)
    for column, side in sides:
        side_table = side["table"]
        key = side_table["primaryKey"][0]
        referenced = next((item for item in side_table["columns"] if item["name"] == key), None)
        table["columns"].append(
            {
                "name": column,
                "type": referenced["type"] if referenced else {"sql": "", "kind": "unknown"},
                "nullable": False,
            }
        )
        table["foreignKeys"].append(
            {
                "columns": [column],
                "references": {
                    "table": side_table["name"],
                    **({"schema": side_table["schema"]} if side_table.get("schema") else {}),
                    "columns": [key],
                },
                "onDelete": "cascade",
            }
        )
    return table


def read_field_models(files: list[dict], flavour: FieldFlavour) -> dict:
    """The schema the models of these files declare, in this flavour."""
    notes: list = []
    _modules, classes, enums = read_modules(files)
    by_name = {definition["name"]: definition for definition in classes}
    enums_used: list = []
    models = [
        _model_of(flavour, definition, by_name, enums, enums_used, notes)
        for definition in classes
        if _is_model(definition, by_name)
        and not _is_abstract(definition)
        and boolean_of(_meta_of(definition).get("proxy")) is not True
    ]
    joins = _resolve(flavour, models, notes)
    for model in models:
        _apply_meta(flavour, model, notes)
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": None,
        "source": {"kind": "orm", "format": flavour.format},
        "tables": [*(model["table"] for model in models), *joins],
        "enums": enums_used,
        "notes": notes,
    }
