"""src/models.ts: a Mongoose model per collection that reflects the documents instead of designing them (the stored
name of every field, their types, what is required, values and limits, nested documents), defined on a connection by
defineModels. Mongoose never creates collections or indexes with them: the database already exists. Mirrors
web/src/core/generators/typescript/mongoose/models.ts."""

import re

from ....js import number_text
from ...types import lines
from ..typescript import quote, ts_literal

IDENTIFIER = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def models_module(context: dict) -> str:
    """The module defineModels and Models are imported from: the project's, or the one the settings name."""
    if any(info["writesEntity"] for info in context["tables"]):
        return "src/models"
    return context["settings"]["entitiesModule"].replace(".", "/")


def field_key(name: str) -> str:
    return name if IDENTIFIER.fullmatch(name) else quote(name)


def _schema_type(context: dict, column_type: dict) -> str:
    """The Mongoose type of a field."""
    kind = column_type["kind"]
    # JavaScript writes whole numbers as int: a validator may ask for another type
    if kind == "integer":
        return "Schema.Types.BigInt" if column_type["sql"] in ("long", "BigInt") else "Number"
    if kind == "float":
        return "Schema.Types.Double" if column_type["sql"].lower() == "double" else "Number"
    if kind == "array":
        return f"[{_schema_type(context, column_type['items'])}]"
    if kind == "json":
        fields = column_type.get("fields")
        return "Schema.Types.Mixed" if fields is None else _nested_schema(context, fields)
    if kind == "text":
        return "Schema.Types.ObjectId" if column_type.get("objectId") else "String"
    if kind == "enum":
        item = next((item for item in context["schema"]["enums"] if item["name"] == column_type["name"]), None)
        values = ", ".join(quote(value) for value in (item["values"] if item else []))
        return f"{{ type: String, enum: [{values}] }}"
    return {
        "decimal": "Schema.Types.Decimal128",
        "boolean": "Boolean",
        "datetime": "Date",
        "uuid": "Schema.Types.UUID",
        "binary": "Buffer",
        # MongoDB has no dates without a time and no times of the day: their text
        "date": "String",
        "time": "String",
    }.get(kind, "Schema.Types.Mixed")


def _nested_schema(context: dict, fields: list[dict]) -> str:
    """A schema inside another. The fields it does not name are kept when the document is written again."""
    own = [field for field in fields if field["name"] != "_id"]
    identifier = "" if len(own) < len(fields) else "_id: false, "
    written = ", ".join(f"{field_key(field['name'])}: {_definition(context, field, [])}" for field in own)
    return f"new Schema({{ {written} }}, {{ {identifier}strict: false, minimize: false }})"


def _settings_of(column: dict, checks: list[dict]) -> list[str]:
    """The settings of a field, besides its type."""
    column_type = column["type"]
    generated = column.get("generated")
    settings = []
    # An empty list is a value: Mongoose gives one to every list left out
    if column_type["kind"] == "array":
        settings.append("default: undefined")
    if not column["nullable"] and column["name"] != "_id":
        settings.append("required: true")
    if column_type["kind"] == "text" and column_type.get("length") is not None and not column_type.get("objectId"):
        settings.append(f"maxlength: {number_text(column_type['length'])}")
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != column["name"]:
            continue
        if parsed["kind"] == "in":
            settings.append(f"enum: [{', '.join(ts_literal(value) for value in parsed['values'])}]")
        if parsed["kind"] == "compare" and parsed["op"] == ">=":
            settings.append(f"min: {number_text(parsed['value'])}")
        if parsed["kind"] == "compare" and parsed["op"] == "<=":
            settings.append(f"max: {number_text(parsed['value'])}")
        if parsed["kind"] == "length" and parsed["op"] == ">=":
            settings.append(f"minlength: {number_text(parsed['value'])}")
    default = column.get("default")
    if generated in ("now", "onUpdateNow"):
        settings.append("default: () => new Date()")
    elif generated == "uuid" and column_type["kind"] == "uuid":
        settings.append("default: () => randomUUID()")
    elif default and default["kind"] == "literal" and default["value"] is not None:
        settings.append(f"default: {ts_literal(default['value'])}")
    return settings


def _definition(context: dict, column: dict, checks: list[dict]) -> str:
    written = _schema_type(context, column["type"])
    settings = ", ".join(_settings_of(column, checks))
    if not settings:
        return written
    if column["type"]["kind"] == "enum":
        return f"{written[:-2]}, {settings} }}"
    return f"{{ type: {written}, {settings} }}"


def _schema_block(context: dict, info: dict) -> list:
    table = info["table"]
    fields = [column for column in table["columns"] if column["name"] != "_id" or column.get("generated") != "uuid"]

    def index(columns: list[str], options: list[str]) -> str:
        keys = ", ".join(f"{field_key(column)}: 1" for column in columns)
        settings = f", {{ {', '.join(options)} }}" if options else ""
        return f"  {info['attr']}.index({{ {keys} }}{settings})"

    def named(item: dict) -> list[str]:
        return [f"name: {quote(item['name'])}"] if item.get("name") else []

    comment = f": {table['comment']}" if table.get("comment") else ""
    return [
        "",
        f"  /** The {quote(table['name'])} collection{comment}. */",
        f"  const {info['attr']} = new Schema(",
        "    {",
        *(f"      {field_key(column['name'])}: {_definition(context, column, table['checks'])}," for column in fields),
        "    },",
        f"    {{ collection: {quote(table['name'])}, versionKey: false, minimize: false, autoIndex: false, autoCreate: false }},",
        "  )",
        # For the tests' own database: in the application's, indexes are not touched
        *(index(unique["columns"], ["unique: true", *named(unique)]) for unique in table["uniques"]),
        *(index(item["columns"], named(item)) for item in table["indexes"]),
    ]


def models_file(context: dict) -> dict:
    uuid = any(
        column["column"].get("generated") == "uuid" and column["column"]["type"]["kind"] == "uuid"
        for info in context["tables"]
        for column in info["columns"]
    )
    blocks = [line for info in context["tables"] for line in _schema_block(context, info)]
    content = lines(
        "/** The collections of the database, as Mongoose models. They reflect it: Mongoose never creates collections or indexes with them. */",
        uuid and "import { randomUUID } from 'node:crypto'",
        "import { Schema, type Connection, type Model } from 'mongoose'",
        "",
        "/** A document as the driver gives it, by the stored names of its fields */",
        "export type Stored = Record<string, unknown>",
        "",
        "/** The model of every collection */",
        "export interface Models {",
        *(f"  {info['attr']}: Model<Stored>" for info in context["tables"]),
        "}",
        "",
        "/** Defines the model of every collection on `connection`. */",
        "export function defineModels(connection: Connection): Models {",
        *blocks[1:],
        "",
        "  return {",
        *(
            f"    {info['attr']}: connection.model<Stored>({quote(info['entity'])}, {info['attr']} as unknown as Schema<Stored>),"
            for info in context["tables"]
        ),
        "  }",
        "}",
        "",
    )
    return {"path": "src/models.ts", "content": content}
