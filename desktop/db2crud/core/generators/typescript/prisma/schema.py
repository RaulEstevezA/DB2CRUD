"""prisma/schema.prisma: a model per table that reflects the database instead of designing it (exact table and column
names with @map, the native types of the chosen database, keys, unique values, indexes and foreign keys with their
actions), the enums the database keeps as types, and the generator of the client into src/generated/prisma. Prisma
never migrates with it: the database already exists; the tests create their own database from it. Mirrors
web/src/core/generators/typescript/prisma/schema.ts."""

import json
import re

from ....js import number_text
from ...types import lines
from ..common.context import column_of, find_info
from ..typescript import member_name, type_name


def provider_of(context: dict) -> str:
    database = context["settings"]["database"]
    if database in ("mysql", "mariadb"):
        return "mysql"
    return "sqlite" if database == "sqlite" else "postgresql"


def _prisma_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


# Enums


def native_enum(context: dict, column_type: dict) -> dict | None:
    """The enum of a column, when the database keeps it as a type of its own (Prisma enum); CHECK enums stay text."""
    if column_type["kind"] != "enum" or provider_of(context) == "sqlite":
        return None
    item = next(
        (candidate for candidate in context["schema"]["enums"] if candidate["name"] == column_type["name"]), None
    )
    return item if item is not None and item.get("storage") == "native" else None


def enum_name(item: dict) -> str:
    return type_name(item["name"])


def member_of(value: str) -> str:
    """The Prisma name of an enum value: the value itself when it is an identifier."""
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", value):
        return value
    cleaned = re.sub(r"^_+|_+$", "", re.sub(r"[^A-Za-z0-9_]+", "_", value))
    return cleaned if re.match(r"[A-Za-z]", cleaned) else f"value_{cleaned}"


def renames_values(item: dict) -> bool:
    """Whether any value of the enum has another name in Prisma: the client returns the names, not the values."""
    return any(member_of(value) != value for value in item["values"])


def _enum_block(item: dict) -> list[str]:
    members = []
    for value in item["values"]:
        renamed = f" @map({_prisma_string(value)})" if member_of(value) != value else ""
        members.append(f"  {member_of(value)}{renamed}")
    return [f"enum {enum_name(item)} {{", *members, "", f"  @@map({_prisma_string(item['name'])})", "}"]


# Columns


def _precision_of(column_type: dict) -> str | None:
    """The precision written in the column's SQL type: timestamp(3) → 3."""
    match = re.search(r"\((\d+)\)", column_type["sql"])
    return match.group(1) if match else None


def field_of(context: dict, column_type: dict) -> dict:
    """How a column is kept by Prisma: {"type"} and, when Prisma's default is not the column's, {"native"}."""
    provider = provider_of(context)
    sqlite = provider == "sqlite"
    postgres = provider == "postgresql"
    kind = column_type["kind"]
    if kind == "integer":
        # SQLite keeps every whole number in 64 bits, and Prisma only counts up Int keys there
        if column_type["bits"] == 64 and not sqlite:
            return {"type": "BigInt"}
        return (
            {"type": "Int", "native": "@db.SmallInt"} if column_type["bits"] == 16 and not sqlite else {"type": "Int"}
        )
    if kind == "decimal":
        if sqlite or column_type.get("precision") is None:
            return {"type": "Decimal"}
        scale = column_type.get("scale")
        return {
            "type": "Decimal",
            "native": f"@db.Decimal({column_type['precision']}, {scale if scale is not None else 0})",
        }
    if kind == "float":
        if column_type["bits"] == 32 and not sqlite:
            return {"type": "Float", "native": "@db.Real" if postgres else "@db.Float"}
        return {"type": "Float"}
    if kind == "text":
        if sqlite:
            return {"type": "String"}
        if column_type.get("length") is None:
            return {"type": "String"} if postgres else {"type": "String", "native": "@db.Text"}
        native = "Char" if column_type.get("fixed") else "VarChar"
        return {"type": "String", "native": f"@db.{native}({column_type['length']})"}
    if kind == "boolean":
        return {"type": "Boolean"}
    if kind == "date":
        return {"type": "DateTime"} if sqlite else {"type": "DateTime", "native": "@db.Date"}
    if kind == "time":
        if sqlite:
            return {"type": "String"}
        precision = _precision_of(column_type) or ("6" if postgres else "0")
        name = "Timetz" if postgres and column_type.get("timezone") else "Time"
        return {"type": "DateTime", "native": f"@db.{name}({precision})"}
    if kind == "datetime":
        if sqlite:
            return {"type": "DateTime"}
        precision = _precision_of(column_type) or ("6" if postgres else "0")
        if postgres:
            name = "Timestamptz" if column_type.get("timezone") else "Timestamp"
            return {"type": "DateTime", "native": f"@db.{name}({precision})"}
        return {"type": "DateTime", "native": f"@db.DateTime({precision})"}
    if kind == "uuid":
        return (
            {"type": "String"} if sqlite else {"type": "String", "native": "@db.Uuid" if postgres else "@db.Char(36)"}
        )
    if kind == "binary":
        if provider == "mysql":
            length = column_type.get("length")
            return {"type": "Bytes", "native": f"@db.VarBinary({length})" if length is not None else "@db.Blob"}
        return {"type": "Bytes"}
    if kind == "json":
        if postgres and re.fullmatch(r"json", column_type["sql"], re.IGNORECASE):
            return {"type": "Json", "native": "@db.Json"}
        return {"type": "Json"}
    if kind == "array":
        # Arrays are portable as JSON; a native PostgreSQL list is a decision for the user
        return {"type": "Json"}
    if kind == "enum":
        item = native_enum(context, column_type)
        return {"type": enum_name(item)} if item else {"type": "String"}
    return {"type": "String"}


def _default_of(context: dict, column: dict) -> str | None:
    value = column.get("default")
    if not value:
        return None
    if value["kind"] == "expression":
        return f"@default(dbgenerated({_prisma_string(value['sql'])}))"
    literal = value["value"]
    if literal is None:
        return None
    if native_enum(context, column["type"]):
        return f"@default({member_of(literal if isinstance(literal, str) else number_text(literal))})"
    if isinstance(literal, str):
        # A Prisma Decimal or BigInt default is written as a number
        if column["type"]["kind"] in ("decimal", "integer") and re.fullmatch(r"-?\d+(\.\d+)?", literal):
            return f"@default({literal})"
        return f"@default({_prisma_string(literal)})"
    return f"@default({number_text(literal)})"


def _scalar_line(context: dict, info: dict, column: dict) -> dict:
    db = column["column"]
    field = field_of(context, db["type"])
    primary_key = info["table"].get("primaryKey")
    single = primary_key is not None and len(primary_key) == 1 and primary_key[0] == db["name"]
    notes = []
    parts = [f"{column['prop']} {field['type']}{'?' if db['nullable'] and not single else ''}"]
    if single:
        parts.append("@id")
    generated = db.get("generated")
    if generated == "identity":
        parts.append("@default(autoincrement())")
    elif generated == "uuid":
        parts.append("@default(uuid())")
    elif generated == "now":
        parts.append("@default(now())")
    elif generated == "onUpdateNow":
        parts.append("@default(now()) @updatedAt")
    else:
        value = _default_of(context, db)
        if value:
            parts.append(value)
    unique = next(
        (item for item in info["table"]["uniques"] if len(item["columns"]) == 1 and item["columns"][0] == db["name"]),
        None,
    )
    if unique:
        parts.append(f"@unique(map: {_prisma_string(unique['name'])})" if unique.get("name") else "@unique")
    if column["prop"] != db["name"]:
        parts.append(f"@map({_prisma_string(db['name'])})")
    if field.get("native"):
        parts.append(field["native"])
    if isinstance(generated, dict):
        notes.append(
            f"TODO: {db['name']} is computed by the database ({generated['computed']}); Prisma cannot say so, "
            "and the repositories never write it"
        )
    if db["type"]["kind"] == "unknown":
        notes.append(f'TODO: "{db["type"]["sql"]}" has no Prisma type here; it is mapped as text')
    if db["type"]["kind"] == "array":
        notes.append(
            f'TODO: "{db["type"]["sql"]}" is mapped as JSON; use a Prisma list on PostgreSQL if you need the native array'
        )
    if db.get("comment"):
        notes.append(db["comment"])
    return {"line": " ".join(parts), "notes": notes}


# Relations

ACTIONS = {
    "cascade": "Cascade",
    "set null": "SetNull",
    "set default": "SetDefault",
    "restrict": "Restrict",
    "no action": "NoAction",
}


def _is_unique_set(info: dict, columns: list[str]) -> bool:
    """Whether the columns are a key of the table (primary or unique): then a row has at most one such row."""

    def same(other: list[str]) -> bool:
        return len(other) == len(columns) and all(name in columns for name in other)

    primary_key = info["table"].get("primaryKey")
    return (primary_key is not None and same(primary_key)) or any(
        same(unique["columns"]) for unique in info["table"]["uniques"]
    )


def relations_of(context: dict) -> list[dict]:
    """Every foreign key Prisma can keep: the parent is in the schema and the referenced columns are one of its keys."""
    taken = {info["name"]: {column["prop"] for column in info["columns"]} for info in context["tables"]}

    def free(table: str, wanted: str) -> str:
        names = taken[table]
        name = wanted
        index = 2
        while name in names:
            name = f"{wanted}{index}"
            index += 1
        names.add(name)
        return name

    result = []
    for child in context["tables"]:
        for key in child["table"]["foreignKeys"]:
            parent = find_info(context, key["references"]["table"])
            if not parent or not _is_unique_set(parent, key["references"]["columns"]):
                continue
            if key.get("attribute") is not None:
                base = key["attribute"]
            elif len(key["columns"]) == 1:
                base = member_name(re.sub(r"_id$", "", key["columns"][0], flags=re.IGNORECASE))
            else:
                base = member_name(parent["name"])
            field = free(child["name"], f"{base}Ref" if base in taken[child["name"]] else base)
            result.append(
                {"key": key, "child": child, "parent": parent, "name": f"{child['entity']}_{field}", "field": field}
            )
    # The other side of each relation, once every relation field is named
    for relation in result:
        inverse = relation["key"].get("inverse")
        wanted = inverse if inverse is not None else relation["child"]["attr"]
        repeated = any(
            other is not relation and other["child"] is relation["child"] and other["parent"] is relation["parent"]
            for other in result
        )
        field = relation["field"]
        relation["back"] = free(
            relation["parent"]["name"], f"{wanted}As{field[:1].upper()}{field[1:]}" if repeated else wanted
        )
    return result


def _relation_line(context: dict, relation: dict) -> str:
    key, child, parent = relation["key"], relation["child"], relation["parent"]
    optional = any(column_of(child, name)["column"]["nullable"] for name in key["columns"])
    fields = [column_of(child, name)["prop"] for name in key["columns"]]
    references = [column_of(parent, name)["prop"] for name in key["references"]["columns"]]
    parts = [
        _prisma_string(relation["name"]),
        f"fields: [{', '.join(fields)}]",
        f"references: [{', '.join(references)}]",
        f"onDelete: {ACTIONS[key.get('onDelete') or 'no action']}",
        f"onUpdate: {ACTIONS[key.get('onUpdate') or 'no action']}",
    ]
    # SQLite has no names for foreign keys
    if key.get("name") and provider_of(context) != "sqlite":
        parts.append(f"map: {_prisma_string(key['name'])}")
    return f"{relation['field']} {parent['entity']}{'?' if optional else ''} @relation({', '.join(parts)})"


def _back_line(relation: dict) -> str:
    one = _is_unique_set(relation["child"], relation["key"]["columns"])
    return f"{relation['back']} {relation['child']['entity']}{'?' if one else '[]'} @relation({_prisma_string(relation['name'])})"


# Models


def _column_list(context: dict, info: dict, names: list[str]) -> str:
    """Columns as the attributes of a block list them: MySQL can only index long text by a prefix."""
    result = []
    for name in names:
        column = column_of(info, name)
        column_type = column["column"]["type"]
        long_text = column_type["kind"] == "text" and column_type.get("length") is None
        if provider_of(context) == "mysql" and (long_text or column_type["kind"] == "unknown"):
            result.append(f"{column['prop']}(length: 191)")
        else:
            result.append(column["prop"])
    return ", ".join(result)


def _aligned(fields: list[dict]) -> list[str]:
    """Names, types and attributes in columns, as `prisma format` leaves them."""
    parts = [field["line"].split(" ") for field in fields]
    name_width = max(len(part[0]) for part in parts)
    type_width = max(len(part[1]) for part in parts)
    result = []
    for field, part in zip(fields, parts, strict=True):
        name, kind, rest = part[0], part[1], part[2:]
        line = (
            f"{name.ljust(name_width)} {kind.ljust(type_width)} {' '.join(rest)}"
            if rest
            else f"{name.ljust(name_width)} {kind}"
        )
        result.extend(f"  /// {note}" for note in field["notes"])
        result.append(f"  {line}")
    return result


def _model_block(context: dict, info: dict, relations: list[dict]) -> list[str]:
    table = info["table"]
    fields = [_scalar_line(context, info, column) for column in info["columns"]]
    fields += [{"line": _relation_line(context, item), "notes": []} for item in relations if item["child"] is info]
    fields += [{"line": _back_line(item), "notes": []} for item in relations if item["parent"] is info]
    primary_key = table.get("primaryKey")
    attributes = []
    if primary_key and len(primary_key) > 1:
        attributes.append(f"@@id([{_column_list(context, info, primary_key)}])")
    if not primary_key:
        attributes.append(f"@@unique([{_column_list(context, info, [column['name'] for column in table['columns']])}])")
    for unique in table["uniques"]:
        if len(unique["columns"]) > 1:
            name = f", map: {_prisma_string(unique['name'])}" if unique.get("name") else ""
            attributes.append(f"@@unique([{_column_list(context, info, unique['columns'])}]{name})")
    for index in table["indexes"]:
        name = f", map: {_prisma_string(index['name'])}" if index.get("name") else ""
        attributes.append(f"@@index([{_column_list(context, info, index['columns'])}]{name})")
    attributes.append(f"@@map({_prisma_string(table['name'])})")
    header = []
    if table.get("comment"):
        header.append(f"/// {table['comment']}")
    if not primary_key:
        header += [
            "/// The table has no primary key: Prisma needs a unique set of fields, so rows are told apart by all of them,",
            "/// for reading only (the tests create that unique index; the database keeps none)",
        ]
    if table.get("schema"):
        header.append(
            f'/// TODO: the table is in the "{table["schema"]}" schema; enable Prisma\'s multiSchema and add @@schema'
        )
    header += [
        f"/// CHECK ({check['sql']}): Prisma does not keep CHECK constraints; the services check them"
        for check in table["checks"]
    ]
    return [*header, f"model {info['entity']} {{", *_aligned(fields), "", *(f"  {line}" for line in attributes), "}"]


def schema_file(context: dict) -> dict:
    provider = provider_of(context)
    relations = relations_of(context)
    used = []
    for info in context["tables"]:
        for column in info["columns"]:
            item = native_enum(context, column["column"]["type"])
            if item is not None and not any(item is other for other in used):
                used.append(item)
    enums = [item for item in context["schema"]["enums"] if any(item is other for other in used)]
    content = lines(
        "// Prisma schema of the database, written by DB2CRUD to reflect it: the tables already exist, so do not migrate",
        "// with it. `npm install` generates the client into src/generated/prisma.",
        "",
        "generator client {",
        '  provider            = "prisma-client"',
        '  output              = "../src/generated/prisma"',
        '  moduleFormat        = "esm"',
        '  importFileExtension = "js"',
        "}",
        "",
        "// The address is in prisma.config.ts (DATABASE_URL); the application connects through src/database.ts",
        "datasource db {",
        f"  provider = {_prisma_string(provider)}",
        "}",
        *[line for item in enums for line in ("", *_enum_block(item))],
        *[line for info in context["tables"] for line in ("", *_model_block(context, info, relations))],
        "",
    )
    return {"path": "prisma/schema.prisma", "content": content}
