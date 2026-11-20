"""Reads a Prisma schema into the physical schema. The datasource names the engine, so the dialect is known. Models
are tables (`@@map`, `@@schema`), scalar fields are columns (`@map`, the native type of `@db.*`), relation fields
with `fields` and `references` are foreign keys, and a list on both sides with no fields is an implicit
many-to-many table (`_AToB`, with columns `A` and `B`). Enums are native types where the engine has them.

Prisma keeps no CHECK constraints: they are read from the SQL of the migrations (`prisma/migrations/…/migration.sql`)
when those come with the schema, and a note says so when they do not. A model with no key needs a unique set of
fields in Prisma; a `@@unique` of all its fields is taken as that, not as a constraint of the database. Mirrors
web/src/core/importers/orm/prisma.ts."""

import re

from ...schema.checks import check_of
from ..code.lexer import C_LIKE, Cursor, LexerConfig, LexError, StringRule, Token, tokenize
from .expressions import literal_of, name_of, number_of, read_arguments, read_expression, string_of, text_of
from .types import OrmReader

_NAMED = ":"

# Reading the declarations


def _read_attribute(cursor: Cursor, source: str) -> dict:
    """`@name(args)` at the cursor, after its `@`: {name, args, named}."""
    parts = [cursor.next().value]
    while cursor.is_(".") and cursor.is_ident(1):
        cursor.next()
        parts.append(cursor.next().value)
    if not cursor.is_("("):
        return {"name": ".".join(parts), "args": [], "named": {}}
    cursor.next()
    args, named = read_arguments(cursor, source, _NAMED, ")")
    return {"name": ".".join(parts), "args": args, "named": named}


def _lines_of(cursor: Cursor) -> list[list[Token]]:
    """The tokens of each line of a block, up to its closing brace."""
    lines: list[list[Token]] = []
    depth = 0
    while not cursor.done:
        token = cursor.next()
        if token.kind == "punct" and depth == 0 and token.value == "}":
            break
        if token.kind == "punct" and token.value in ("(", "[", "{"):
            depth += 1
        if token.kind == "punct" and token.value in (")", "]", "}"):
            depth -= 1
        if token.line_start and depth == 0:
            lines.append([token])
        elif lines:
            lines[-1].append(token)
        else:
            lines.append([token])
    return lines


def _read_block(keyword: str, name: str, cursor: Cursor, source: str, line: int) -> dict:
    block = {"keyword": keyword, "name": name, "fields": [], "attributes": [], "settings": {}, "line": line}
    for tokens in _lines_of(cursor):
        inner = Cursor(tokens)
        if inner.is_("@") and inner.is_("@", 1):
            inner.next()
            inner.next()
            block["attributes"].append(_read_attribute(inner, source))
            continue
        if not inner.is_ident():
            continue
        field_name = inner.next().value
        if inner.eat("="):
            block["settings"][field_name] = read_expression(inner, source, _NAMED)
            continue
        field = {
            "name": field_name,
            "type": "",
            "typeArgs": [],
            "optional": False,
            "list": False,
            "attributes": [],
            "line": tokens[0].line,
        }
        if inner.is_ident():
            field["type"] = inner.next().value
            if inner.is_("("):
                inner.next()
                field["typeArgs"] = read_arguments(inner, source, _NAMED, ")")[0]
            if inner.is_("[") and inner.is_("]", 1):
                inner.next()
                inner.next()
                field["list"] = True
            if inner.eat("?"):
                field["optional"] = True
        while not inner.done:
            if inner.eat("@") and inner.is_ident():
                field["attributes"].append(_read_attribute(inner, source))
            else:
                inner.next()
        block["fields"].append(field)
    return block


_KEYWORDS = ("model", "enum", "datasource", "generator", "view", "type")


def _read_blocks(files: list[dict]) -> list[dict]:
    blocks: list[dict] = []
    for file in (item for item in files if not _is_sql(item)):
        cursor = Cursor(tokenize(file["text"], C_LIKE))
        while not cursor.done:
            keyword = cursor.value()
            if keyword in _KEYWORDS and cursor.is_ident(1) and cursor.is_("{", 2):
                line = cursor.next().line
                name = cursor.next().value
                cursor.next()
                blocks.append(_read_block(keyword, name, cursor, file["text"], line))
            else:
                cursor.next()
    return blocks


# The CHECK constraints of the migrations


def _is_sql(file: dict) -> bool:
    return file["name"].lower().endswith(".sql")


_SQL = LexerConfig(
    line_comments=("--",),
    block_comments=(("/*", "*/"),),
    strings=(
        StringRule("'", "'", False, True),
        StringRule('"', '"', False, False),
        StringRule("`", "`", False, False),
        StringRule("[", "]", False, False),
    ),
)


def _word(token: Token | None, value: str) -> bool:
    return token is not None and token.kind == "ident" and token.value.upper() == value


def _migration_checks(files: list[dict]) -> dict[str, list[dict]]:
    """The CHECK constraints the SQL creates, by table: in `CREATE TABLE` (of a column or of the table) and in
    `ALTER TABLE … ADD [CONSTRAINT name] CHECK (…)`. A constraint dropped later is left out."""
    checks: dict[str, list[dict]] = {}
    for file in files:
        try:
            tokens = tokenize(file["text"], _SQL)
        except LexError:
            continue

        def at(position: int, tokens: list[Token] = tokens) -> Token | None:
            return tokens[position] if 0 <= position < len(tokens) else None

        table = None
        depth = 0
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if token.kind == "punct" and token.value == ";":
                table = None
            if token.kind == "punct" and token.value == "(":
                depth += 1
            if token.kind == "punct" and token.value == ")":
                depth -= 1
            if (
                depth == 0
                and _word(token, "TABLE")
                and (_word(at(index - 1), "CREATE") or _word(at(index - 1), "ALTER"))
            ):
                # CREATE TABLE IF NOT EXISTS "schema"."name"
                position = index + 1
                while any(_word(at(position), word) for word in ("IF", "NOT", "EXISTS", "ONLY")):
                    position += 1
                while at(position + 1) is not None and at(position + 1).value == "." and at(position + 2) is not None:
                    position += 2
                table = at(position).value if at(position) is not None else None
                index += 1
                continue
            if table is None:
                index += 1
                continue
            if _word(token, "DROP") and _word(at(index + 1), "CONSTRAINT"):
                name = at(index + 2).value if at(index + 2) is not None else None
                checks[table] = [item for item in checks.get(table, []) if item.get("name") != name]
                index += 1
                continue
            following = at(index + 1)
            if not _word(token, "CHECK") or following is None or following.value != "(":
                index += 1
                continue
            end = index + 2
            opened = 1
            while end < len(tokens):
                if tokens[end].kind == "punct" and tokens[end].value == "(":
                    opened += 1
                if tokens[end].kind == "punct" and tokens[end].value == ")":
                    opened -= 1
                    if opened == 0:
                        break
                end += 1
            name = at(index - 1).value if _word(at(index - 2), "CONSTRAINT") else None
            closing = at(end)
            sql = file["text"][following.end : closing.start if closing is not None else len(file["text"])].strip()
            checks[table] = [*checks.get(table, []), check_of(sql, name)]
            index = end + 1
    return checks


# Types


def _attribute_of(attributes: list[dict], name: str) -> dict | None:
    return next((item for item in attributes if item["name"] == name), None)


def _first_arg(attribute: dict | None) -> dict | None:
    return attribute["args"][0] if attribute is not None and attribute["args"] else None


_DIALECTS = {
    "postgresql": "postgresql",
    "postgres": "postgresql",
    "cockroachdb": "postgresql",
    "mysql": "mysql",
    "sqlite": "sqlite",
    "sqlserver": "sqlserver",
}


def _type_of(field: dict, dialect: str | None) -> dict | None:
    """The database type of a scalar field, from its Prisma type and its native type (`@db.VarChar(120)`)."""
    native = next((item for item in field["attributes"] if item["name"].startswith("db.")), None)
    native_name = native["name"][3:] if native is not None else ""
    parts = [field["type"]]
    if native is not None:
        args = f"({', '.join(text_of(arg) for arg in native['args'])})" if native["args"] else ""
        parts.append(f"@{native['name']}{args}")
    sql = " ".join(parts)
    size = number_of(native["args"][0]) if native is not None and native["args"] else None
    kind = field["type"]
    if kind == "String":
        if native_name in ("Uuid", "UniqueIdentifier"):
            return {"sql": sql, "kind": "uuid"}
        if re.fullmatch(r"N?VarChar|VarChar2", native_name):
            return {"sql": sql, "kind": "text", "length": size} if size is not None else {"sql": sql, "kind": "text"}
        if re.fullmatch(r"N?Char", native_name):
            if size is not None:
                return {"sql": sql, "kind": "text", "length": size, "fixed": True}
            return {"sql": sql, "kind": "text", "fixed": True}
        return {"sql": sql, "kind": "text"}
    if kind == "Int":
        small = re.fullmatch(r"SmallInt|TinyInt|UnsignedSmallInt|UnsignedTinyInt", native_name)
        return {"sql": sql, "kind": "integer", "bits": 16 if small else 32}
    if kind == "BigInt":
        return {"sql": sql, "kind": "integer", "bits": 64}
    if kind == "Float":
        single = native_name == "Real" or (native_name == "Float" and dialect == "mysql")
        return {"sql": sql, "kind": "float", "bits": 32 if single else 64}
    if kind == "Decimal":
        scale = number_of(native["args"][1]) if native is not None and len(native["args"]) > 1 else None
        return {
            "sql": sql,
            "kind": "decimal",
            **({"precision": size} if size is not None else {}),
            **({"scale": scale} if scale is not None else {}),
        }
    if kind == "Boolean":
        return {"sql": sql, "kind": "boolean"}
    if kind == "DateTime":
        if native_name == "Date":
            return {"sql": sql, "kind": "date"}
        if native_name in ("Time", "Timetz"):
            return {"sql": sql, "kind": "time", "timezone": native_name == "Timetz"}
        return {"sql": sql, "kind": "datetime", "timezone": native_name in ("Timestamptz", "DateTimeOffset")}
    if kind == "Json":
        return {"sql": sql, "kind": "json"}
    if kind == "Bytes":
        return {"sql": sql, "kind": "binary"}
    return None


# Building the tables

_ACTIONS = {
    "Cascade": "cascade",
    "Restrict": "restrict",
    "NoAction": "no action",
    "SetNull": "set null",
    "SetDefault": "set default",
}

_UUID_SQL = re.compile(r"(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)", re.IGNORECASE)
_NOW_SQL = re.compile(r"now\(\)|current_timestamp(\(\))?", re.IGNORECASE)


def _apply_default(expr: dict, column: dict, enum_info: dict | None) -> None:
    """A default as the database applies it, or as Prisma fills it in. `enum_info` is {sqlName, values}."""
    call = name_of(expr) if expr["kind"] == "call" else None
    if call in ("autoincrement", "sequence"):
        column["generated"] = "identity"
    elif call == "now":
        column["generated"] = "now"
    elif call in ("uuid", "cuid", "nanoid", "ulid"):
        column["generated"] = "uuid"
    elif call == "dbgenerated":
        sql = string_of(expr["args"][0] if expr["args"] else None) or ""
        if _UUID_SQL.fullmatch(sql.strip()):
            column["generated"] = "uuid"
        elif _NOW_SQL.fullmatch(sql.strip()):
            column["generated"] = "now"
        elif sql:
            column["default"] = {"kind": "expression", "sql": sql}
    elif (
        expr["kind"] == "name"
        and len(expr["path"]) == 1
        and enum_info is not None
        and expr["path"][0] in enum_info["values"]
    ):
        column["default"] = {"kind": "literal", "value": enum_info["values"][expr["path"][0]]}
    else:
        value = literal_of(expr)
        if value is not None:
            column["default"] = {"kind": "literal", "value": value}
        elif expr["kind"] == "list":
            column["default"] = {"kind": "expression", "sql": text_of(expr)}


def _field_names(expr: dict | None) -> list[str]:
    """The fields a list names: `[customerId, createdAt(sort: Desc)]`."""
    if expr is None or expr["kind"] != "list":
        return []
    return [name for name in (name_of(item) for item in expr["items"]) if name]


def _relation_name(attribute: dict | None) -> str | None:
    if attribute is None:
        return None
    first = string_of(_first_arg(attribute))
    return first if first is not None else string_of(attribute["named"].get("name"))


def _reference(table: dict, columns: list[str]) -> dict:
    return {"table": table["name"], **({"schema": table["schema"]} if "schema" in table else {}), "columns": columns}


def _read_prisma(files: list[dict]) -> dict:
    notes: list[dict] = []
    blocks = _read_blocks(files)
    datasource = next((block for block in blocks if block["keyword"] == "datasource"), None)
    provider = string_of(datasource["settings"].get("provider")) if datasource is not None else None
    dialect = _DIALECTS.get(provider) if provider else None
    if provider and provider not in _DIALECTS:
        notes.append({"code": "orm.unsupportedEngine", "params": {"engine": provider}})
    native_enums = dialect in ("postgresql", "mysql")
    enum_infos: dict[str, dict] = {}
    enums: list[dict] = []
    for block in (item for item in blocks if item["keyword"] == "enum"):
        values = {}
        for field in block["fields"]:
            mapped = string_of(_first_arg(_attribute_of(field["attributes"], "map")))
            values[field["name"]] = mapped if mapped is not None else field["name"]
        sql_name = string_of(_first_arg(_attribute_of(block["attributes"], "map"))) or block["name"]
        enum_infos[block["name"]] = {"sqlName": sql_name, "values": values}
        enums.append(
            {"name": sql_name, "values": list(values.values()), "storage": "native" if native_enums else "check"}
        )
    model_blocks = [block for block in blocks if block["keyword"] == "model"]
    model_names = {block["name"] for block in model_blocks}
    models: dict[str, dict] = {}
    for block in model_blocks:
        table = {
            "name": string_of(_first_arg(_attribute_of(block["attributes"], "map"))) or block["name"],
            "columns": [],
            "primaryKey": None,
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
            "entity": block["name"],
            "origin": {"line": block["line"], "column": 1},
        }
        schema = string_of(_first_arg(_attribute_of(block["attributes"], "schema")))
        if schema:
            table["schema"] = schema
        model = {"block": block, "table": table, "columns": {}}
        for field in block["fields"]:
            enum_info = enum_infos.get(field["type"])
            if field["type"] in model_names:
                continue
            name = string_of(_first_arg(_attribute_of(field["attributes"], "map"))) or field["name"]
            if enum_info is not None:
                if native_enums:
                    column_type = {"sql": field["type"], "kind": "enum", "name": enum_info["sqlName"]}
                else:
                    column_type = {"sql": field["type"], "kind": "text"}
                    quoted = ", ".join("'" + value.replace("'", "''") + "'" for value in enum_info["values"].values())
                    table["checks"].append(check_of(f"{name} IN ({quoted})"))
            else:
                column_type = _type_of(field, dialect)
            if column_type is not None and field["list"]:
                column_type = {"sql": f"{field['type']}[]", "kind": "array", "items": column_type}
            if column_type is None:
                notes.append(
                    {
                        "code": "orm.unknownType",
                        "params": {"table": table["name"], "column": name, "type": field["type"]},
                    }
                )
            column = {
                "name": name,
                "type": column_type
                if column_type is not None
                else {
                    "sql": " ".join([field["type"], *(text_of(arg) for arg in field["typeArgs"])]),
                    "kind": "unknown",
                },
                "nullable": field["optional"],
            }
            value = _first_arg(_attribute_of(field["attributes"], "default"))
            if value is not None:
                _apply_default(value, column, enum_info)
            if _attribute_of(field["attributes"], "updatedAt"):
                column["generated"] = "onUpdateNow"
            if name != field["name"]:
                column["attribute"] = field["name"]
            table["columns"].append(column)
            model["columns"][field["name"]] = name
            if _attribute_of(field["attributes"], "id"):
                table["primaryKey"] = [name]
            unique = _attribute_of(field["attributes"], "unique")
            if unique is not None:
                mapped = string_of(unique["named"].get("map"))
                table["uniques"].append({**({"name": mapped} if mapped else {}), "columns": [name]})
        models[block["name"]] = model

    def columns_of(model: dict, expr: dict | None) -> list[str]:
        return [model["columns"].get(field, field) for field in _field_names(expr)]

    for model in models.values():
        table = model["table"]
        for attribute in model["block"]["attributes"]:
            fields = _first_arg(attribute) or attribute["named"].get("fields")
            mapped = string_of(attribute["named"].get("map")) or string_of(attribute["named"].get("name"))
            named = {"name": mapped} if mapped else {}
            if attribute["name"] == "id":
                table["primaryKey"] = columns_of(model, fields)
            elif attribute["name"] == "unique":
                table["uniques"].append({**named, "columns": columns_of(model, fields)})
            elif attribute["name"] == "index":
                table["indexes"].append({**named, "columns": columns_of(model, fields)})
    for model in models.values():
        table = model["table"]
        # Prisma needs a unique set of fields on a table with no key: one of all its fields is only that
        every = ",".join(sorted(model["columns"].values()))
        orm_only = (
            -1
            if table["primaryKey"] is not None
            else next(
                (i for i, item in enumerate(table["uniques"]) if ",".join(sorted(item["columns"])) == every),
                -1,
            )
        )
        if orm_only >= 0:
            del table["uniques"][orm_only]
            notes.append({"code": "orm.ormOnlyUnique", "params": {"table": table["name"]}})
    sql_files = [file for file in files if _is_sql(file)]
    if sql_files:
        checks = _migration_checks(sql_files)
        for model in models.values():
            model["table"]["checks"].extend(checks.get(model["table"]["name"], []))
    elif models:
        notes.append({"code": "orm.checksNotKept"})
    joins: list[dict] = []
    for model in models.values():
        for field in model["block"]["fields"]:
            target = models.get(field["type"])
            if target is None:
                continue
            relation = _attribute_of(field["attributes"], "relation")
            relation_name = _relation_name(relation)

            def same_relation(other: dict, field=field, relation_name=relation_name, model=model) -> bool:
                return (
                    other["type"] == model["block"]["name"]
                    and _relation_name(_attribute_of(other["attributes"], "relation")) == relation_name
                    and other is not field
                )

            inverse = next((other for other in target["block"]["fields"] if same_relation(other)), None)
            relation_named = relation["named"] if relation is not None else {}
            columns = columns_of(model, relation_named.get("fields"))
            if columns:
                references = columns_of(target, relation_named.get("references"))
                on_delete = _ACTIONS.get(name_of(relation_named.get("onDelete")) or "")
                if on_delete is None:
                    nullable = all(
                        next((item for item in model["table"]["columns"] if item["name"] == column), {}).get("nullable")
                        for column in columns
                    )
                    on_delete = "set null" if nullable else "restrict"
                on_update = _ACTIONS.get(name_of(relation_named.get("onUpdate")) or "")
                mapped = string_of(relation_named.get("map"))
                model["table"]["foreignKeys"].append(
                    {
                        **({"name": mapped} if mapped else {}),
                        "columns": columns,
                        "references": _reference(target["table"], references),
                        "onDelete": on_delete,
                        **({"onUpdate": on_update} if on_update else {}),
                        "attribute": field["name"],
                        **({"inverse": inverse["name"]} if inverse is not None else {}),
                    }
                )
            elif (
                field["list"]
                and inverse is not None
                and inverse["list"]
                and model["block"]["name"] <= target["block"]["name"]
                and (model is not target or field["name"] < inverse["name"])
            ):
                joins.append(_implicit_join(model, target, relation_name, field["line"]))
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": dialect,
        "source": {"kind": "orm", "format": "prisma"},
        "tables": [*(model["table"] for model in models.values()), *joins],
        "enums": enums,
        "notes": notes,
    }


def _implicit_join(first: dict, second: dict, relation_name: str | None, line: int) -> dict:
    """The table Prisma creates for a many-to-many relation with no model: `_<A>To<B>` (or `_<relation name>`), with
    a column `A` to the model first in alphabetical order and `B` to the other."""
    name = relation_name if relation_name is not None else f"{first['block']['name']}To{second['block']['name']}"
    table = {
        "name": f"_{name}",
        "columns": [],
        "primaryKey": ["A", "B"],
        "foreignKeys": [],
        "uniques": [],
        "indexes": [{"columns": ["B"]}],
        "checks": [],
        "origin": {"line": line, "column": 1},
    }
    for column, side in (("A", first), ("B", second)):
        key = side["table"]["primaryKey"][0] if side["table"]["primaryKey"] else "id"
        referenced = next((item for item in side["table"]["columns"] if item["name"] == key), None)
        column_type = referenced["type"] if referenced is not None else {"sql": "", "kind": "unknown"}
        table["columns"].append({"name": column, "type": column_type, "nullable": False})
        table["foreignKeys"].append(
            {
                "columns": [column],
                "references": _reference(side["table"], [key]),
                "onDelete": "cascade",
                "onUpdate": "cascade",
            }
        )
    return table


_SETUP = re.compile(r"^\s*(datasource|generator)\s+\w+\s*\{", re.MULTILINE)
_MODEL = re.compile(r"^\s*model\s+\w+\s*\{[^}]*@(id|relation|map)\b", re.MULTILINE)


def _detect(files: list[dict]) -> float:
    if any(file["name"].endswith(".prisma") for file in files):
        return 1
    text = "\n".join(file["text"] for file in files)
    return 1 if _SETUP.search(text) or _MODEL.search(text) else 0


PRISMA_READER = OrmReader(id="prisma", label="Prisma", language="prisma", detect=_detect, read=_read_prisma)
