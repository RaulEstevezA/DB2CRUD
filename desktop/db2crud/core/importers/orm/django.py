"""Reads Django models into the physical schema: classes of `models.Model` (and of abstract models, whose fields they
inherit), their fields with the options that reach the database, `Meta` (`db_table`, constraints, indexes,
`unique_together`), foreign keys and one-to-one fields (a column `<name>_id` with an index), many-to-many fields (a
table of their own unless `through` names one) and `TextChoices`/`IntegerChoices` as enums. Django keeps `on_delete`
in the application; the reader takes it as what the database should do, as Model2DB writes it. A model with
`managed = False` is a table Django never creates: it has only the indexes its `Meta` names, and a note says its key
may exist only in the ORM. Mirrors web/src/core/importers/orm/django.ts."""

import re

from ...js import js_string
from ...model.naming import to_snake_case
from ...schema.checks import check_of
from .expressions import boolean_of, literal_of, name_of, number_of, string_of, text_of
from .python import assignment_of, attributes_of, class_of, empty_table, is_now, is_uuid, read_modules
from .types import OrmReader

# Types

# Text fields with the length Django gives them when none is said
_TEXT_LENGTHS = {
    "CharField": None,
    "SlugField": 50,
    "EmailField": 254,
    "URLField": 200,
    "GenericIPAddressField": 39,
    "IPAddressField": 15,
    "FilePathField": 100,
    "FileField": 100,
    "ImageField": 100,
}

_INTEGERS = {
    "AutoField": {"bits": 32, "identity": True},
    "BigAutoField": {"bits": 64, "identity": True},
    "SmallAutoField": {"bits": 16, "identity": True},
    "IntegerField": {"bits": 32},
    "BigIntegerField": {"bits": 64},
    "SmallIntegerField": {"bits": 16},
    "PositiveIntegerField": {"bits": 32, "positive": True},
    "PositiveBigIntegerField": {"bits": 64, "positive": True},
    "PositiveSmallIntegerField": {"bits": 16, "positive": True},
}


def _with_length(sql: str, kind: str, length) -> dict:
    return {"sql": sql, "kind": kind, **({"length": length} if length is not None else {})}


def _type_of(field: dict) -> dict | None:
    """The database type of a field, or None when it is not one the rules know."""
    name = name_of(field) or ""
    named = field["named"]
    sql = text_of(field)
    if name in _INTEGERS:
        return {"sql": sql, "kind": "integer", "bits": _INTEGERS[name]["bits"]}
    if name in _TEXT_LENGTHS:
        length = number_of(named.get("max_length"))
        return _with_length(sql, "text", length if length is not None else _TEXT_LENGTHS[name])
    if name == "TextField":
        return {"sql": sql, "kind": "text"}
    if name == "FloatField":
        return {"sql": sql, "kind": "float", "bits": 64}
    if name == "DecimalField":
        precision = number_of(named.get("max_digits"))
        scale = number_of(named.get("decimal_places"))
        return {
            "sql": sql,
            "kind": "decimal",
            **({"precision": precision} if precision is not None else {}),
            **({"scale": scale} if scale is not None else {}),
        }
    if name in ("BooleanField", "NullBooleanField"):
        return {"sql": sql, "kind": "boolean"}
    if name == "DateField":
        return {"sql": sql, "kind": "date"}
    # Django keeps times in UTC (USE_TZ, on by default since Django 5)
    if name == "DateTimeField":
        return {"sql": sql, "kind": "datetime", "timezone": True}
    if name == "TimeField":
        return {"sql": sql, "kind": "time", "timezone": False}
    if name == "UUIDField":
        return {"sql": sql, "kind": "uuid"}
    if name == "BinaryField":
        return _with_length(sql, "binary", number_of(named.get("max_length")))
    if name == "JSONField":
        return {"sql": sql, "kind": "json"}
    if name == "ArrayField":
        base = field["args"][0] if field["args"] else named.get("base_field")
        items = _type_of(base) if base is not None and base["kind"] == "call" else None
        return {
            "sql": sql,
            "kind": "array",
            "items": items or {"sql": text_of(base) if base is not None else "", "kind": "unknown"},
        }
    return None


# Reading a model

_ON_DELETE = {"CASCADE": "cascade", "SET_NULL": "set null", "SET_DEFAULT": "set default", "RESTRICT": "restrict"}


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


def _app_of(file: str) -> str | None:
    """The app a model belongs to, from where its file is: `shop/models.py` or `shop/models/order.py` → `shop`."""
    parts = [part for part in file.split("/") if part]
    models = len(parts) - 1 - parts[::-1].index("models") if "models" in parts else -1
    if models > 0:
        return parts[models - 1]
    return parts[-2] if len(parts) > 1 and parts[-1] == "models.py" else None


def _default_value(expr: dict, enums: dict) -> dict | None:
    """The value Django stores for a default: `OrderStatus.PAID` is `"paid"`."""
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


_RELATIONS = ("ForeignKey", "OneToOneField", "ManyToManyField")


def _add_field(model: dict, item: dict, enums: dict, enums_used: list, notes: list) -> None:
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
    if kind == "ManyToManyField":
        # A `through` model is a table of its own, read as any other model
        if "through" not in named:
            inverse = string_of(named.get("related_name"))
            model["manyToMany"].append(
                {
                    "attribute": item["name"],
                    "target": _target_of(target_expr, model["def"]["name"]),
                    **({"inverse": inverse} if inverse and not inverse.endswith("+") else {}),
                }
            )
        return
    relation = kind in _RELATIONS
    if not relation and not kind.endswith("Field"):
        return
    primary_key = boolean_of(named.get("primary_key")) is True
    declared = string_of(named.get("db_column"))
    own = f"{item['name']}_id" if relation else item["name"]
    name = declared if declared is not None else own
    if relation:
        column_type = None
    elif kind == "GeneratedField":
        output = named.get("output_field")
        column_type = _type_of(output) if output is not None and output["kind"] == "call" else None
    else:
        column_type = _type_of(field)
    if not relation and not column_type:
        notes.append(
            {"code": "orm.unknownType", "params": {"table": table["name"], "column": name, "type": text_of(field)}}
        )
    column: dict = {
        "name": name,
        "type": column_type or {"sql": "" if relation else text_of(field), "kind": "unknown"},
        "nullable": not primary_key and (boolean_of(named.get("null")) is True or kind == "NullBooleanField"),
    }
    if _INTEGERS.get(kind, {}).get("identity"):
        column["generated"] = "identity"
    if kind == "GeneratedField" and "expression" in named:
        column["generated"] = {"computed": text_of(named["expression"])}
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
    comment = string_of(named.get("db_comment"))
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
    unique = boolean_of(named.get("unique")) is True or kind == "OneToOneField"
    if unique and not primary_key:
        table["uniques"].append({"columns": [name]})
    # Django indexes every foreign key unless told not to
    indexed = boolean_of(named.get("db_index"))
    if not unique and not primary_key:
        if indexed is True:
            table["indexes"].append({"columns": [name]})
        elif indexed is None and relation:
            model["keyIndexes"].append(name)
    if _INTEGERS.get(kind, {}).get("positive"):
        table["checks"].append(check_of(f"{name} >= 0"))
    choices = _choices_of(named.get("choices"), enums, f"{table['name']}_{name}")
    if choices and not any(used["name"] == choices["name"] for used in enums_used):
        enums_used.append(choices)
    if relation:
        on_delete = _ON_DELETE.get(name_of(named.get("on_delete")) or "")
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


def _groups_of(expr: dict | None) -> list[dict]:
    """`unique_together = ("a", "b")` or `(("a", "b"), ("c", "d"))`: the groups of fields."""
    if expr is None or expr["kind"] != "list":
        return []
    if all(item["kind"] == "string" for item in expr["items"]):
        return [expr]
    return [item for item in expr["items"] if item["kind"] == "list"]


def _apply_meta(model: dict, notes: list) -> None:
    """What `Meta` says about the table: its name is read before, the rest once every column is known."""
    table, meta = model["table"], model["meta"]
    comment = string_of(meta.get("db_table_comment"))
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


def _big_auto_id() -> dict:
    return {
        "name": "id",
        "type": {"sql": "models.BigAutoField()", "kind": "integer", "bits": 64},
        "nullable": False,
        "generated": "identity",
    }


def _model_of(definition: dict, classes: dict, enums: dict, enums_used: list, notes: list) -> dict:
    meta = _meta_of(definition)
    app = _app_of(definition["file"])
    lower = definition["name"].lower()
    db_table = string_of(meta.get("db_table"))
    name = db_table if db_table is not None else (f"{app}_{lower}" if app else lower)
    table = empty_table(name, definition["line"])
    table["entity"] = definition["name"]
    model = {
        "def": definition,
        "table": table,
        "columns": {},
        "keys": [],
        "manyToMany": [],
        "meta": meta,
        # Foreign key columns Django indexes on its own
        "keyIndexes": [],
    }
    # The fields of abstract models are inherited; a concrete parent keeps its own table
    for item in attributes_of(definition, classes, _is_abstract):
        _add_field(model, item, enums, enums_used, notes)
    if model.get("compositeKey") is not None:
        table["primaryKey"] = [model["columns"].get(field, field) for field in model["compositeKey"]]
    # A model without a primary key gets Django's: `id`, a big integer the database numbers
    if table["primaryKey"] is None:
        table["columns"].insert(0, _big_auto_id())
        table["primaryKey"] = ["id"]
        model["columns"]["id"] = "id"
    model["columns"]["pk"] = table["primaryKey"][0]
    return model


# Resolving what refers to what


def _resolve(models: list[dict], notes: list) -> list[dict]:
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
            joins.append(_join_table(model, target, relation))
    return joins


def _join_table(model: dict, target: dict, relation: dict) -> dict:
    """The table Django creates for a many-to-many field: `<table>_<field>`, with a key to each side."""
    is_self = model is target
    source = f"{'from_' if is_self else ''}{model['def']['name'].lower()}_id"
    to = f"{'to_' if is_self else ''}{target['def']['name'].lower()}_id"
    table = empty_table(f"{model['table']['name']}_{relation['attribute']}", model["def"]["line"])

    def key_column(name: str, side: dict) -> dict:
        referenced = next((c for c in side["table"]["columns"] if c["name"] == side["table"]["primaryKey"][0]), None)
        return {
            "name": name,
            "type": referenced["type"] if referenced else {"sql": "", "kind": "unknown"},
            "nullable": False,
        }

    def reference(side: dict) -> dict:
        side_table = side["table"]
        return {
            "table": side_table["name"],
            **({"schema": side_table["schema"]} if side_table.get("schema") else {}),
            "columns": [side_table["primaryKey"][0]],
        }

    table["columns"] += [_big_auto_id(), key_column(source, model), key_column(to, target)]
    table["primaryKey"] = ["id"]
    table["foreignKeys"] += [
        {"columns": [source], "references": reference(model), "onDelete": "cascade"},
        {"columns": [to], "references": reference(target), "onDelete": "cascade"},
    ]
    table["uniques"].append({"columns": [source, to]})
    table["indexes"] += [{"columns": [source]}, {"columns": [to]}]
    return table


def _read_django(files: list[dict]) -> dict:
    notes: list = []
    _modules, classes, enums = read_modules(files)
    by_name = {definition["name"]: definition for definition in classes}
    enums_used: list = []
    models = [
        _model_of(definition, by_name, enums, enums_used, notes)
        for definition in classes
        if _is_model(definition, by_name)
        and not _is_abstract(definition)
        and boolean_of(_meta_of(definition).get("proxy")) is not True
    ]
    joins = _resolve(models, notes)
    for model in models:
        _apply_meta(model, notes)
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": None,
        "source": {"kind": "orm", "format": "django"},
        "tables": [*(model["table"] for model in models), *joins],
        "enums": enums_used,
        "notes": notes,
    }


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    if not re.search(r"\bfrom\s+django\.db\s+import\s+models\b|\bdjango\.db\.models\b", text):
        return 0
    return 1 if re.search(r"\(\s*models\.Model\s*\)|models\.\w+Field\(", text) else 0.5


DJANGO_READER = OrmReader(id="django", label="Django", language="python", detect=_detect, read=_read_django)
