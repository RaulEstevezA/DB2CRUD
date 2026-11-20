"""Reads Sequelize models into the physical schema, declared with `Model.init(attributes, options)` or
`sequelize.define(name, attributes, options)`: attributes with their `DataTypes`, `field`, keys, defaults and
`references`, the table options (`tableName`, `indexes`, `timestamps`, `paranoid`, `underscored`), and the
associations (`belongsTo`, `hasOne`, `hasMany`, `belongsToMany`) that place foreign keys. What Sequelize adds on its
own (an `id` when no attribute is the key, the timestamps, the names of foreign keys and of through tables) follows
its defaults. Sequelize keeps no CHECK constraints: the values a `validate` allows (`isIn`, `min`, `max`, `len`) are
read as CHECKs, as the rules need them, and a note says the database may have others. The engine is the `dialect` of
`new Sequelize(…)`, when the code names only one. Mirrors web/src/core/importers/orm/sequelize.ts.

A model call is {keys, name, attributes, options, line}; an association {kind, source, target, options}."""

import re

from ...js import is_number, json_string, number_text
from ...model.naming import pluralize, singularize
from ...schema.checks import check_of
from ..code.lexer import Cursor, LexError, tokenize
from ..code.typescript import TYPESCRIPT_LEXER
from .expressions import boolean_of, literal_of, name_of, number_of, read_arguments, string_of, text_of
from .types import OrmReader
from .typescript import NAMED, plain_type, read_typescript

# Reading the calls

_ASSOCIATIONS = {"belongsTo", "hasOne", "hasMany", "belongsToMany"}


def _entries_of(expr: dict | None) -> dict:
    """The entries of an object literal, by key."""
    entries: dict = {}
    if expr is not None and expr["kind"] == "dict":
        for entry in expr["entries"]:
            key = name_of(entry["key"])
            key = key if key is not None else string_of(entry["key"])
            if key:
                entries[key] = entry["value"]
    return entries


_DIALECTS = {
    "postgres": "postgresql",
    "postgresql": "postgresql",
    "mysql": "mysql",
    "mariadb": "mariadb",
    "sqlite": "sqlite",
    "mssql": "sqlserver",
    "oracle": "oracle",
}

_SCHEME = re.compile(r"^(\w+):", re.ASCII)


def _read_calls(files: list[dict]) -> tuple[list, list, set, list, dict]:
    models: list[dict] = []
    associations: list[dict] = []
    removed_ids: set[str] = set()
    engines: list[str] = []
    defaults: dict = {}
    for file in files:
        try:
            tokens = tokenize(file["text"], TYPESCRIPT_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)

        def arguments_at(index: int, cursor: Cursor = cursor, source: str = file["text"]) -> list:
            cursor.index = index
            return read_arguments(cursor, source, NAMED, ")")[0]

        def at(position: int, tokens: list = tokens):
            return tokens[position] if 0 <= position < len(tokens) else None

        def value_at(position: int) -> str | None:
            token = at(position)
            return token.value if token is not None else None

        for index, token in enumerate(tokens):
            if token.kind != "ident":
                continue
            if token.value == "new" and value_at(index + 1) == "Sequelize" and value_at(index + 2) == "(":
                for arg in arguments_at(index + 3):
                    dialect = string_of(_entries_of(arg).get("dialect"))
                    if dialect is None:
                        scheme = _SCHEME.match(string_of(arg) or "")
                        dialect = scheme.group(1) if scheme else None
                    if dialect:
                        engines.append(dialect)
                    define = _entries_of(arg).get("define")
                    if define is not None:
                        defaults = _entries_of(define)
                continue
            method_token = at(index + 2)
            if value_at(index + 1) != "." or method_token is None or method_token.kind != "ident":
                continue
            if value_at(index + 3) != "(":
                continue
            method = method_token.value
            receiver = token.value
            if method == "init":
                args = arguments_at(index + 4)
                if not args or args[0]["kind"] != "dict":
                    continue
                options = _entries_of(args[1] if len(args) > 1 else None)
                models.append(
                    {
                        "keys": [receiver],
                        "name": string_of(options.get("modelName")) or receiver,
                        "attributes": args[0],
                        "options": options,
                        "line": token.line,
                    }
                )
            elif method == "define":
                args = arguments_at(index + 4)
                name = string_of(args[0]) if args else None
                if not name or len(args) < 2 or args[1]["kind"] != "dict":
                    continue
                before = at(index - 2)
                variable = (
                    before.value
                    if value_at(index - 1) == "=" and before is not None and before.kind == "ident"
                    else None
                )
                models.append(
                    {
                        "keys": [*([variable] if variable else []), name],
                        "name": name,
                        "attributes": args[1],
                        "options": _entries_of(args[2] if len(args) > 2 else None),
                        "line": token.line,
                    }
                )
            elif method in _ASSOCIATIONS:
                args = arguments_at(index + 4)
                target = name_of(args[0]) if args else None
                if target:
                    associations.append(
                        {
                            "kind": method,
                            "source": receiver,
                            "target": target,
                            "options": _entries_of(args[1] if len(args) > 1 else None),
                        }
                    )
            elif method == "removeAttribute":
                args = arguments_at(index + 4)
                if args and string_of(args[0]) == "id":
                    removed_ids.add(receiver)
    return models, associations, removed_ids, engines, defaults


# Types

_MODIFIERS = ("UNSIGNED", "ZEROFILL", "BINARY")


def _base_type(expr: dict) -> dict:
    """The type without `.UNSIGNED`, `.ZEROFILL` and `.BINARY`."""
    if expr["kind"] == "attribute" and expr["name"] in _MODIFIERS:
        return _base_type(expr["target"])
    if expr["kind"] == "name" and len(expr["path"]) > 1 and expr["path"][-1] in _MODIFIERS:
        return _base_type({"kind": "name", "path": expr["path"][:-1]})
    return expr


def _zoned(dialect: str | None) -> bool:
    """Whether the dates of the engine keep their zone: MySQL, MariaDB and SQLite keep none."""
    return dialect not in ("mysql", "mariadb", "sqlite")


def _type_of(original: dict, dialect: str | None) -> dict | None:
    """The database type of a Sequelize data type (`DataTypes.STRING(120)`): {type, values?}."""
    expr = _base_type(original)
    name = (name_of(expr) or "").upper()
    args = expr["args"] if expr["kind"] == "call" else []
    sql = text_of(original)
    first = number_of(args[0]) if args else None
    if name == "STRING":
        return {"type": {"sql": sql, "kind": "text", "length": first if first is not None else 255}}
    if name == "CHAR":
        return {"type": {"sql": sql, "kind": "text", "length": first if first is not None else 255, "fixed": True}}
    if name in ("TEXT", "CITEXT"):
        return {"type": {"sql": sql, "kind": "text"}}
    if name in ("TINYINT", "SMALLINT"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 16}}
    if name in ("MEDIUMINT", "INTEGER"):
        return {"type": {"sql": sql, "kind": "integer", "bits": 32}}
    if name == "BIGINT":
        return {"type": {"sql": sql, "kind": "integer", "bits": 64}}
    if name == "FLOAT":
        return {"type": {"sql": sql, "kind": "float", "bits": 64 if dialect in ("postgresql", "sqlite") else 32}}
    if name == "REAL":
        return {"type": {"sql": sql, "kind": "float", "bits": 64 if dialect == "sqlite" else 32}}
    if name == "DOUBLE":
        return {"type": {"sql": sql, "kind": "float", "bits": 64}}
    if name in ("DECIMAL", "NUMERIC"):
        scale = number_of(args[1]) if len(args) > 1 else None
        return {
            "type": {
                "sql": sql,
                "kind": "decimal",
                **({"precision": first} if first is not None else {}),
                **({"scale": scale} if scale is not None else {}),
            }
        }
    if name == "BOOLEAN":
        return {"type": {"sql": sql, "kind": "boolean"}}
    if name == "DATE":
        # A Sequelize date is an instant: TIMESTAMP WITH TIME ZONE, except where the engine has no zone
        return {"type": {"sql": sql, "kind": "datetime", "timezone": _zoned(dialect)}}
    if name == "DATEONLY":
        return {"type": {"sql": sql, "kind": "date"}}
    if name == "TIME":
        return {"type": {"sql": sql, "kind": "time", "timezone": False}}
    if name == "UUID":
        return {"type": {"sql": sql, "kind": "uuid"}}
    if name in ("JSON", "JSONB"):
        return {"type": {"sql": sql, "kind": "json"}}
    if name == "BLOB":
        return {"type": {"sql": sql, "kind": "binary"}}
    if name == "ENUM":
        listed = _entries_of(args[0]).get("values") if len(args) == 1 and args[0]["kind"] == "dict" else None
        items = listed["items"] if listed is not None and listed["kind"] == "list" else args
        values = [value for value in (string_of(item) for item in items) if value is not None]
        return {"type": {"sql": sql, "kind": "text"}, "values": values}
    if name == "ARRAY":
        items = _type_of(args[0], dialect) if args else None
        return {"type": {"sql": sql, "kind": "array", "items": items["type"]}} if items else None
    return None


_NOW_SQL = re.compile(r"now\(\)|current_timestamp(\(\d*\))?|localtimestamp|datetime\('now'\)", re.IGNORECASE)
_UUID_SQL = re.compile(r"(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)", re.IGNORECASE)


def _apply_default(expr: dict, column: dict, enums: dict) -> None:
    """A default: a literal, an enum member, SQL (`literal('…')`), the time (`DataTypes.NOW`, `fn('now')`) or a new
    UUID."""
    name = name_of(expr)
    if expr["kind"] == "call" and name == "literal":
        sql = (string_of(expr["args"][0]) if expr["args"] else None) or ""
        if _NOW_SQL.fullmatch(sql.strip()):
            column["generated"] = "now"
        elif _UUID_SQL.fullmatch(sql.strip()):
            column["generated"] = "uuid"
        elif sql:
            column["default"] = {"kind": "expression", "sql": sql}
        return
    if expr["kind"] == "call" and name == "fn":
        called = (string_of(expr["args"][0]) if expr["args"] else None) or ""
        if _NOW_SQL.fullmatch(f"{called}()"):
            column["generated"] = "now"
        elif _UUID_SQL.fullmatch(f"{called}()"):
            column["generated"] = "uuid"
        elif called:
            column["default"] = {"kind": "expression", "sql": f"{called}()"}
        return
    if expr["kind"] == "name":
        path = expr["path"]
        if len(path) > 1 and name == "NOW":
            column["generated"] = "now"
        elif len(path) > 1 and name in ("UUIDV4", "UUIDV1"):
            column["generated"] = "uuid"
        elif len(path) == 1 and name == "null":
            column["default"] = {"kind": "literal", "value": None}
        elif len(path) == 2 and path[0] in enums:
            value = enums[path[0]].get(path[1])
            if value is not None:
                column["default"] = {"kind": "literal", "value": value}
        else:
            value = literal_of(expr)
            if value is not None:
                column["default"] = {"kind": "literal", "value": value}
        return
    value = literal_of(expr)
    if value is not None:
        column["default"] = {"kind": "literal", "value": value}
    elif expr["kind"] in ("list", "dict"):
        column["default"] = {"kind": "literal", "value": _to_json(expr)}


def _to_json(expr: dict) -> str:
    """An array or object literal as JSON, for the default of a JSON column."""
    if expr["kind"] == "list":
        return f"[{','.join(_to_json(item) for item in expr['items'])}]"
    if expr["kind"] == "dict":
        entries = []
        for entry in expr["entries"]:
            key = name_of(entry["key"])
            key = key if key is not None else string_of(entry["key"])
            entries.append(f"{json_string(key if key is not None else '')}:{_to_json(entry['value'])}")
        return "{" + ",".join(entries) + "}"
    value = literal_of(expr)
    if value is None:
        return "null"
    return json_string(value) if isinstance(value, str) else number_text(value)


def _quoted(values: list) -> str:
    return ", ".join(
        number_text(value) if is_number(value) else "'" + value.replace("'", "''") + "'" for value in values
    )


def _validation_checks(column: str, validate: dict) -> list[dict]:
    """The CHECKs a `validate` stands for: `isIn`, `min`, `max` and `len`."""
    checks: list[dict] = []

    def setting(expr: dict | None) -> dict | None:
        # `{ args: …, msg: '…' }` gives the value with a message
        args = _entries_of(expr).get("args")
        return args if args is not None else expr

    is_in = setting(validate.get("isIn"))
    listed = (
        is_in["items"][0]
        if is_in is not None and is_in["kind"] == "list" and is_in["items"] and is_in["items"][0]["kind"] == "list"
        else None
    )
    if listed is not None:
        values = [
            value
            for value in (literal_of(item) for item in listed["items"])
            if isinstance(value, str) or is_number(value)
        ]
        if values:
            checks.append(check_of(f"{column} IN ({_quoted(values)})"))
    low_value = number_of(setting(validate.get("min")))
    if low_value is not None:
        checks.append(check_of(f"{column} >= {number_text(low_value)}"))
    high_value = number_of(setting(validate.get("max")))
    if high_value is not None:
        checks.append(check_of(f"{column} <= {number_text(high_value)}"))
    length = setting(validate.get("len"))
    if length is not None and length["kind"] == "list":
        bounds = [number_of(item) for item in length["items"]]
        low = bounds[0] if bounds else None
        high = bounds[1] if len(bounds) > 1 else None
        if low is not None and low > 0:
            checks.append(check_of(f"LENGTH({column}) >= {number_text(low)}"))
        if high is not None:
            checks.append(check_of(f"LENGTH({column}) <= {number_text(high)}"))
    return checks


_ACTIONS = {
    "CASCADE": "cascade",
    "SET NULL": "set null",
    "SET DEFAULT": "set default",
    "RESTRICT": "restrict",
    "NO ACTION": "no action",
}


def _action_of(expr: dict | None) -> str | None:
    return _ACTIONS.get((string_of(expr) or "").upper())


# Sequelize's names

_CAMELIZE = re.compile(r"[-_\s]+(.)?")


def _camelize(text: str) -> str:
    """`Utils.camelize`: `Customer_id` → `CustomerId`."""
    return _CAMELIZE.sub(lambda match: match.group(1).upper() if match.group(1) else "", text.strip())


def _underscore(text: str) -> str:
    """`Utils.underscore`: `customerId` → `customer_id`."""
    text = re.sub(r"([a-z\d])([A-Z])", r"\1_\2", text)
    text = re.sub(r"([A-Z]+)([A-Z][a-z\d]+)", r"\1_\2", text)
    return text.replace("-", "_").lower()


_CREATION_OPTIONAL = re.compile(r"^CreationOptional<(.*)>$")
_NULL = re.compile(r"\|\s*null\b")


# Building the tables


def _read_sequelize(files: list[dict]) -> dict:
    notes: list[dict] = []
    classes, enums, _order = read_typescript(files)
    calls, associations, removed_ids, engines, defaults = _read_calls(files)
    seen_engines: list[str] = []
    for engine in engines:
        if engine not in seen_engines:
            seen_engines.append(engine)
    for engine in seen_engines:
        if engine not in _DIALECTS:
            notes.append({"code": "orm.unsupportedEngine", "params": {"engine": engine}})
    dialects = {_DIALECTS[engine] for engine in engines if engine in _DIALECTS}
    dialect = next(iter(dialects)) if len(dialects) == 1 else None
    db_enums: list[dict] = []

    def add_enum(name: str, values: list, storage: str) -> None:
        if not any(item["name"] == name for item in db_enums):
            db_enums.append(
                {
                    "name": name,
                    "values": [value if isinstance(value, str) else number_text(value) for value in values],
                    "storage": storage,
                }
            )

    models: list[dict] = []
    by_key: dict[str, dict] = {}
    for call in calls:
        options = call["options"]

        def option(name: str, options: dict = options):
            return options.get(name) if options.get(name) is not None else defaults.get(name)

        underscored = boolean_of(option("underscored")) is True
        freeze = boolean_of(option("freezeTableName")) is True
        table_name = string_of(options.get("tableName"))
        table = {
            "name": table_name if table_name is not None else (call["name"] if freeze else pluralize(call["name"])),
            "columns": [],
            "primaryKey": None,
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
            "entity": call["keys"][0],
            "origin": {"line": call["line"], "column": 1},
        }
        schema = string_of(options.get("schema"))
        if schema:
            table["schema"] = schema
        comment = string_of(options.get("comment"))
        if comment:
            table["comment"] = comment
        model = {"call": call, "table": table, "columns": {}, "underscored": underscored}
        definition = classes.get(call["keys"][0])
        members = {member["name"]: member for member in (definition["members"] if definition else [])}
        primary: list[str] = []
        attributes = call["attributes"]
        for entry in attributes["entries"] if attributes is not None and attributes["kind"] == "dict" else []:
            attribute = name_of(entry["key"])
            attribute = attribute if attribute is not None else string_of(entry["key"])
            if not attribute:
                continue
            settings = _entries_of(entry["value"]) if entry["value"]["kind"] == "dict" else {"type": entry["value"]}
            type_expr = settings.get("type")
            if type_expr is not None and name_of(_base_type(type_expr)) == "VIRTUAL":
                continue
            field = string_of(settings.get("field"))
            name = field if field is not None else (_underscore(attribute) if underscored else attribute)
            read = _type_of(type_expr, dialect) if type_expr is not None else None
            column_type = read["type"] if read else None
            if read and "values" in read:
                # Sequelize names the type of an enum enum_<table>_<column> on PostgreSQL; SQLite keeps text
                enum_name = f"enum_{table['name']}_{name}"
                native = dialect != "sqlite"
                add_enum(enum_name, read["values"], "native" if native else "check")
                if native:
                    column_type = {"sql": read["type"]["sql"], "kind": "enum", "name": enum_name}
                else:
                    table["checks"].append(check_of(f"{name} IN ({_quoted(read['values'])})"))
            if column_type is None:
                notes.append(
                    {
                        "code": "orm.unknownType",
                        "params": {
                            "table": table["name"],
                            "column": name,
                            "type": text_of(type_expr) if type_expr is not None else "",
                        },
                    }
                )
            is_primary = boolean_of(settings.get("primaryKey")) is True
            column = {
                "name": name,
                "type": column_type
                if column_type is not None
                else {"sql": text_of(type_expr) if type_expr is not None else "", "kind": "unknown"},
                "nullable": not is_primary and boolean_of(settings.get("allowNull")) is not False,
            }
            value = settings.get("defaultValue")
            if value is not None:
                _apply_default(value, column, enums)
            if boolean_of(settings.get("autoIncrement")) is True:
                column["generated"] = "identity"
            column_comment = string_of(settings.get("comment"))
            if column_comment:
                column["comment"] = column_comment
            if name != attribute:
                column["attribute"] = attribute
            table["columns"].append(column)
            model["columns"][attribute] = name
            if is_primary:
                primary.append(name)
            unique = settings.get("unique")
            if boolean_of(unique) is True or string_of(unique):
                unique_name = string_of(unique)
                same = (
                    next((item for item in table["uniques"] if item.get("name") == unique_name), None)
                    if unique_name
                    else None
                )
                if same is not None:
                    same["columns"].append(name)
                else:
                    table["uniques"].append({**({"name": unique_name} if unique_name else {}), "columns": [name]})
            checks = _validation_checks(name, _entries_of(settings.get("validate")))
            # A TypeScript enum on the attribute keeps its values in a text column: an enum checked by a CHECK
            member = members.get(attribute)
            ts_enum = ""
            if member is not None:
                ts_enum = _NULL.sub("", _CREATION_OPTIONAL.sub(r"\1", plain_type(member))).strip()
            if (
                not (read and "values" in read)
                and column_type is not None
                and column_type["kind"] == "text"
                and ts_enum in enums
            ):
                values = list(enums[ts_enum].values())
                add_enum(_underscore(ts_enum), values, "check")
                if not any((check.get("parsed") or {}).get("kind") == "in" for check in checks):
                    checks.append(check_of(f"{name} IN ({_quoted(values)})"))
            table["checks"].extend(checks)
            references = settings.get("references")
            if references is not None:
                target = _entries_of(references)
                referenced_model = target.get("model")
                referenced_table = name_of(referenced_model)
                if referenced_table is None:
                    referenced_table = string_of(referenced_model) or ""
                on_delete = _action_of(settings.get("onDelete"))
                on_update = _action_of(settings.get("onUpdate"))
                table["foreignKeys"].append(
                    {
                        "columns": [name],
                        # Resolved below: a model, or the name of a table
                        "references": {"table": referenced_table, "columns": [string_of(target.get("key")) or "id"]},
                        **({"onDelete": on_delete} if on_delete else {}),
                        **({"onUpdate": on_update} if on_update else {}),
                    }
                )
        # Sequelize adds an integer key `id` to a model with no key, unless the code removes it
        if not primary and not any(key in removed_ids for key in call["keys"]):
            table["columns"].insert(
                0,
                {
                    "name": "id",
                    "type": {"sql": "INTEGER", "kind": "integer", "bits": 32},
                    "nullable": False,
                    "generated": "identity",
                },
            )
            model["columns"]["id"] = "id"
            primary.append("id")
        if primary:
            table["primaryKey"] = primary
        # The timestamps Sequelize keeps (and the time of a soft delete, with `paranoid`)
        if boolean_of(option("timestamps")) is not False:
            stamps = [("createdAt", "now", False), ("updatedAt", "onUpdateNow", False)]
            if boolean_of(option("paranoid")) is True:
                stamps.append(("deletedAt", None, True))
            for attribute, generated, nullable in stamps:
                setting = options.get(attribute) if options.get(attribute) is not None else defaults.get(attribute)
                if boolean_of(setting) is False or attribute in model["columns"]:
                    continue
                given = string_of(setting)
                name = given if given is not None else (_underscore(attribute) if underscored else attribute)
                if any(item["name"] == name for item in table["columns"]):
                    continue
                column = {
                    "name": name,
                    "type": {"sql": "DATE", "kind": "datetime", "timezone": _zoned(dialect)},
                    "nullable": nullable,
                }
                if generated:
                    column["generated"] = generated
                if name != attribute:
                    column["attribute"] = attribute
                table["columns"].append(column)
                model["columns"][attribute] = name
        indexes = options.get("indexes")
        for index in indexes["items"] if indexes is not None and indexes["kind"] == "list" else []:
            index_settings = _entries_of(index)
            fields = index_settings.get("fields")
            columns = []
            for item in fields["items"] if fields is not None and fields["kind"] == "list" else []:
                field_name = string_of(item)
                if field_name is None:
                    field_name = string_of(_entries_of(item).get("name"))
                if field_name is None:
                    field_name = string_of(_entries_of(item).get("attribute"))
                if field_name is not None:
                    columns.append(model["columns"].get(field_name, field_name))
            if not columns:
                continue
            index_name = string_of(index_settings.get("name"))
            target = table["uniques"] if boolean_of(index_settings.get("unique")) is True else table["indexes"]
            target.append({**({"name": index_name} if index_name else {}), "columns": columns})
        models.append(model)
        for key in call["keys"]:
            by_key[key] = model

    def by_table(name: str) -> dict | None:
        found = by_key.get(name)
        return found if found is not None else next((item for item in models if item["table"]["name"] == name), None)

    # References: to the table of the model they name
    for model in models:
        for key in model["table"]["foreignKeys"]:
            target = by_table(key["references"]["table"])
            if target is None:
                continue
            key["references"] = {
                "table": target["table"]["name"],
                **({"schema": target["table"]["schema"]} if target["table"].get("schema") else {}),
                "columns": [target["columns"].get(column, column) for column in key["references"]["columns"]],
            }

    joins: list[dict] = []
    for association in associations:
        source = by_key.get(association["source"])
        target = by_key.get(association["target"])
        if source is None or target is None:
            continue
        options = association["options"]
        alias = string_of(options.get("as"))
        if association["kind"] == "belongsToMany":
            join = _through_table(source, target, options, by_table)
            if join is not None and not any(item["name"] == join["name"] for item in joins):
                joins.append(join)
            continue
        # belongsTo puts the key on the source; hasOne and hasMany on the target
        belongs = association["kind"] == "belongsTo"
        owner = source if belongs else target
        parent = target if belongs else source
        parent_key = string_of(options.get("targetKey" if belongs else "sourceKey"))
        if parent_key:
            referenced = parent["columns"].get(parent_key, parent_key)
        else:
            referenced = parent["table"]["primaryKey"][0] if parent["table"]["primaryKey"] else None
        parent_column = next((item for item in parent["table"]["columns"] if item["name"] == referenced), None)
        if parent_column is None:
            continue
        foreign_key = options.get("foreignKey")
        key_settings = _entries_of(foreign_key)
        parent_attribute = next(
            (attribute for attribute, column in parent["columns"].items() if column == parent_column["name"]),
            parent_column["name"],
        )
        prefix = alias if belongs and alias is not None else singularize(parent["call"]["name"])
        default_name = _camelize(f"{prefix}_{parent_attribute}")
        attribute = string_of(foreign_key)
        if attribute is None:
            attribute = string_of(key_settings.get("name"))
        if attribute is None:
            attribute = default_name
        column = owner["columns"].get(attribute)
        if column is None:
            column = string_of(key_settings.get("field"))
        if column is None:
            column = _underscore(attribute) if owner["underscored"] else attribute
        if not any(item["name"] == column for item in owner["table"]["columns"]):
            owner["table"]["columns"].append(
                {
                    "name": column,
                    "type": parent_column["type"],
                    "nullable": boolean_of(key_settings.get("allowNull")) is not False,
                    **({"attribute": attribute} if column != attribute else {}),
                }
            )
            owner["columns"][attribute] = column
        on_delete = _action_of(options.get("onDelete"))
        on_update = _action_of(options.get("onUpdate"))
        key = next((item for item in owner["table"]["foreignKeys"] if item["columns"] == [column]), None)
        if key is None:
            parent_table = parent["table"]
            key = {
                "columns": [column],
                "references": {
                    "table": parent_table["name"],
                    **({"schema": parent_table["schema"]} if parent_table.get("schema") else {}),
                    "columns": [parent_column["name"]],
                },
            }
            owner["table"]["foreignKeys"].append(key)
        if on_delete and not key.get("onDelete"):
            key["onDelete"] = on_delete
        if on_update and not key.get("onUpdate"):
            key["onUpdate"] = on_update
        if belongs and alias and not key.get("attribute"):
            key["attribute"] = alias
        if not belongs and alias and not key.get("inverse"):
            key["inverse"] = alias
        # hasOne: one row of the owner for each parent
        if association["kind"] == "hasOne" and not any(
            item["columns"] == [column] for item in owner["table"]["uniques"]
        ):
            owner["table"]["uniques"].append({"columns": [column]})

    if models:
        notes.append({"code": "orm.checksNotKept"})
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": dialect,
        "source": {"kind": "orm", "format": "sequelize"},
        "tables": [*(model["table"] for model in models), *joins],
        "enums": db_enums,
        "notes": notes,
    }


def _key_name(options: dict, name: str) -> str | None:
    value = string_of(options.get(name))
    return value if value is not None else string_of(_entries_of(options.get(name)).get("name"))


def _through_table(source: dict, target: dict, options: dict, by_table) -> dict | None:
    """The table of a `belongsToMany`: the model `through` names gets the two foreign keys it lacks; a name that is no
    model is a table Sequelize creates, keyed by both columns and deleted with either row."""
    through = options.get("through")
    through_settings = _entries_of(through)
    through_name = string_of(through)
    for candidate in (
        string_of(through_settings.get("model")),
        name_of(through_settings.get("model")),
        name_of(through),
    ):
        if through_name is None:
            through_name = candidate
    if not through_name:
        return None
    existing = by_table(through_name)
    sides = ((source, _key_name(options, "foreignKey")), (target, _key_name(options, "otherKey")))
    table = (
        existing["table"]
        if existing is not None
        else {
            "name": through_name,
            "columns": [],
            "primaryKey": [],
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
        }
    )
    for side, given in sides:
        side_key = side["table"]["primaryKey"][0] if side["table"]["primaryKey"] else None
        key_column = next((item for item in side["table"]["columns"] if item["name"] == side_key), None)
        if key_column is None:
            continue
        if given is not None:
            attribute = given
        else:
            key_attribute = next(
                (name for name, column in side["columns"].items() if column == key_column["name"]), key_column["name"]
            )
            attribute = _camelize(f"{singularize(side['call']['name'])}_{key_attribute}")
        column = existing["columns"].get(attribute, attribute) if existing is not None else attribute
        if not any(item["name"] == column for item in table["columns"]):
            table["columns"].append({"name": column, "type": key_column["type"], "nullable": False})
            if existing is None:
                table["primaryKey"].append(column)
        if any(item["columns"] == [column] for item in table["foreignKeys"]):
            continue
        side_table = side["table"]
        table["foreignKeys"].append(
            {
                "columns": [column],
                "references": {
                    "table": side_table["name"],
                    **({"schema": side_table["schema"]} if side_table.get("schema") else {}),
                    "columns": [key_column["name"]],
                },
                "onDelete": "cascade",
                "onUpdate": "cascade",
            }
        )
    return None if existing is not None else table


_IMPORTS = re.compile(r"\bfrom\s+['\"]sequelize['\"]|\brequire\(\s*['\"]sequelize['\"]\s*\)")
_CALLS = re.compile(r"\.(init|define)\s*\(")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if _IMPORTS.search(text) and _CALLS.search(text) else 0


SEQUELIZE_READER = OrmReader(
    id="sequelize", label="Sequelize", language="typescript", detect=_detect, read=_read_sequelize
)
