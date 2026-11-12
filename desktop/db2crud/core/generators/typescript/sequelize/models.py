"""src/models.ts: a Sequelize model per table that reflects the database instead of designing it (exact table and column
names, the column types of the chosen database, keys, unique values, indexes, foreign keys with their actions and
enums), defined on a Sequelize instance by defineModels. Sequelize never syncs them with the database the application
uses: it already exists; the tests create their own database from them. Mirrors
web/src/core/generators/typescript/sequelize/models.ts."""

import re

from ...types import lines
from ..common.context import find_info
from ..typescript import quote, ts_literal


def dialect_of(context: dict) -> str:
    database = context["settings"]["database"]
    if database in ("mysql", "mariadb"):
        return "mysql"
    return "sqlite" if database == "sqlite" else "postgresql"


def models_module(context: dict) -> str:
    """The module defineModels and Models are imported from: the project's, or the one the settings name."""
    if any(info["writesEntity"] for info in context["tables"]):
        return "src/models"
    return context["settings"]["entitiesModule"].replace(".", "/")


def _model_var(info: dict) -> str:
    """The variable of a model inside defineModels: the table's property, unless the function already uses that name."""
    return f"{info['attr']}Model" if info["attr"] in ("sequelize", "literal", "DataTypes") else info["attr"]


def _precision_of(column_type: dict) -> str | None:
    match = re.search(r"\((\d+)\)", column_type["sql"])
    return match.group(1) if match else None


def _data_type(context: dict, column_type: dict) -> str:
    """The Sequelize data type of a column on the chosen database."""
    dialect = dialect_of(context)
    postgres = dialect == "postgresql"
    kind = column_type["kind"]
    if kind == "integer":
        return {16: "DataTypes.SMALLINT", 64: "DataTypes.BIGINT"}.get(column_type["bits"], "DataTypes.INTEGER")
    if kind == "decimal":
        if column_type.get("precision") is None:
            return "DataTypes.DECIMAL"
        scale = column_type.get("scale")
        return f"DataTypes.DECIMAL({column_type['precision']}, {scale if scale is not None else 0})"
    if kind == "float":
        if column_type["bits"] == 32:
            return "DataTypes.REAL" if postgres else "DataTypes.FLOAT"
        return "DataTypes.DOUBLE"
    if kind == "text":
        if column_type.get("length") is None:
            return "DataTypes.TEXT"
        return f"DataTypes.{'CHAR' if column_type.get('fixed') else 'STRING'}({column_type['length']})"
    if kind == "boolean":
        return "DataTypes.BOOLEAN"
    if kind == "date":
        return "DataTypes.DATEONLY"
    if kind == "time":
        return "DataTypes.TIME"
    if kind == "datetime":
        precision = _precision_of(column_type)
        return f"DataTypes.DATE({precision})" if dialect == "mysql" and precision else "DataTypes.DATE"
    if kind == "uuid":
        return "DataTypes.UUID"
    if kind == "binary":
        return "DataTypes.BLOB"
    if kind in ("json", "array"):
        if postgres and not re.fullmatch(r"json", column_type["sql"], re.IGNORECASE):
            return "DataTypes.JSONB"
        return "DataTypes.JSON"
    if kind == "enum":
        item = next((item for item in context["schema"]["enums"] if item["name"] == column_type["name"]), None)
        values = item["values"] if item else []
        return f"DataTypes.ENUM({', '.join(quote(value) for value in values)})"
    return "DataTypes.TEXT"


ACTIONS = {
    "cascade": "CASCADE",
    "set null": "SET NULL",
    "set default": "SET DEFAULT",
    "restrict": "RESTRICT",
    "no action": "NO ACTION",
}


def _default_of(column: dict) -> str | None:
    generated = column.get("generated")
    if generated == "uuid":
        return "DataTypes.UUIDV4"
    if generated in ("now", "onUpdateNow"):
        return "literal('CURRENT_TIMESTAMP')"
    value = column.get("default")
    if not value:
        return None
    if value["kind"] == "expression":
        return f"literal({quote(value['sql'])})"
    return None if value["value"] is None else ts_literal(value["value"])


def _attribute_lines(context: dict, info: dict, column: dict) -> list:
    db = column["column"]
    options = [f"type: {_data_type(context, db['type'])}"]
    primary_key = info["table"].get("primaryKey")
    if primary_key and db["name"] in primary_key:
        options.append("primaryKey: true")
    generated = db.get("generated")
    if generated == "identity":
        options.append("autoIncrement: true")
    options.append(f"allowNull: {'true' if db['nullable'] else 'false'}")
    value = _default_of(db)
    if value:
        options.append(f"defaultValue: {value}")
    if column["prop"] != db["name"]:
        options.append(f"field: {quote(db['name'])}")
    if db.get("comment"):
        options.append(f"comment: {quote(db['comment'])}")
    # A foreign key of one column; Sequelize keeps no foreign key of several
    keys = info["table"]["foreignKeys"]
    key = next((item for item in keys if len(item["columns"]) == 1 and item["columns"][0] == db["name"]), None)
    parent = find_info(context, key["references"]["table"]) if key else None
    if key and parent:
        options += [
            f"references: {{ model: {quote(parent['name'])}, key: {quote(key['references']['columns'][0])} }}",
            f"onDelete: '{ACTIONS[key.get('onDelete') or 'no action']}'",
            f"onUpdate: '{ACTIONS[key.get('onUpdate') or 'no action']}'",
        ]
    composite = next((item for item in keys if len(item["columns"]) > 1 and item["columns"][0] == db["name"]), None)
    kind = db["type"]["kind"]
    return [
        isinstance(generated, dict)
        and f"    // TODO: {db['name']} is computed by the database ({generated['computed']}); Sequelize cannot say so, and the repositories never write it",
        kind == "unknown" and f'    // TODO: "{db["type"]["sql"]}" has no Sequelize type here; it is mapped as text',
        kind == "array"
        and f'    // TODO: "{db["type"]["sql"]}" is mapped as JSON; use DataTypes.ARRAY on PostgreSQL if you need the native array',
        composite is not None
        and f"    // TODO: ({', '.join(composite['columns'])}) points to {composite['references']['table']}; Sequelize keeps no foreign key of several columns",
        f"    {column['prop']}: {{ {', '.join(options)} }},",
    ]


def _model_block(context: dict, info: dict) -> list:
    table = info["table"]

    def names(columns: list[str]) -> str:
        return f"[{', '.join(quote(name) for name in columns)}]"

    indexes = [
        f"{{ {'name: ' + quote(unique['name']) + ', ' if unique.get('name') else ''}unique: true, fields: {names(unique['columns'])} }}"
        for unique in table["uniques"]
    ] + [
        f"{{ {'name: ' + quote(index['name']) + ', ' if index.get('name') else ''}fields: {names(index['columns'])} }}"
        for index in table["indexes"]
    ]
    options = [
        f"tableName: {quote(table['name'])}",
        *([f"schema: {quote(table['schema'])}"] if table.get("schema") else []),
        "timestamps: false",
        *([f"comment: {quote(table['comment'])}"] if table.get("comment") else []),
    ]
    attributes = [line for column in info["columns"] for line in _attribute_lines(context, info, column)]
    if indexes:
        config = [
            "    {",
            *(f"      {item}," for item in options),
            "      indexes: [",
            *(f"        {item}," for item in indexes),
            "      ],",
            "    },",
        ]
    else:
        config = [f"    {{ {', '.join(options)} }},"]
    return [
        f'  /** The "{table["name"]}" table. */',
        *(
            f"  // CHECK ({check['sql']}): Sequelize does not keep CHECK constraints; the services check them"
            for check in table["checks"]
        ),
        f"  const {_model_var(info)} = sequelize.define(",
        f"    {quote(table['name'])},",
        "    {",
        *((f"  {line}" if isinstance(line, str) else line) for line in attributes),
        "    },",
        *config,
        "  )",
        not table.get("primaryKey")
        and [
            "  // The table has no primary key: Sequelize would add an id; rows are told apart by all their columns, for reading only",
            f"  {_model_var(info)}.removeAttribute('id')",
        ],
    ]


def models_file(context: dict) -> dict:
    uses_literal = any(
        column["column"].get("generated") in ("now", "onUpdateNow")
        or (column["column"].get("default") or {}).get("kind") == "expression"
        for info in context["tables"]
        for column in info["columns"]
    )
    returned = ", ".join(
        info["attr"] if _model_var(info) == info["attr"] else f"{info['attr']}: {_model_var(info)}"
        for info in context["tables"]
    )
    blocks = []
    for index, info in enumerate(context["tables"]):
        if index > 0:
            blocks.append("")
        blocks += _model_block(context, info)
    content = lines(
        "/** The tables of the database, as Sequelize models. They reflect the database: never sync them with it. */",
        f"import {{ DataTypes, {'literal, ' if uses_literal else ''}type Model, type ModelStatic, type Sequelize }} from 'sequelize'",
        "",
        "/** The model of every table */",
        "export interface Models {",
        *(f"  {info['attr']}: ModelStatic<Model>" for info in context["tables"]),
        "}",
        "",
        "/** Defines the model of every table on `sequelize`. */",
        "export function defineModels(sequelize: Sequelize): Models {",
        *blocks,
        f"  return {{ {returned} }}",
        "}",
        "",
    )
    return {"path": "src/models.ts", "content": content}
