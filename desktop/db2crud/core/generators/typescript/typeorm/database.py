"""src/data-source.ts (the TypeORM data source for the database DATABASE_URL names) and the entity of each table:
exact table and column names, the column types of the chosen database and every constraint of the input, so the
entities reflect the database instead of designing it. Mirrors web/src/core/generators/typescript/typeorm/database.ts.
"""

import re

from ....js import number_text
from ...types import lines
from ..common.context import column_of, find_info, is_in, module_of, path_of, writes_entities
from ..typescript import TsImports, member_name, quote, ts_literal

URLS = {
    "postgresql": "postgresql://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mysql://app:app@localhost:3306/app",
    "sqlite": "sqlite:./app.db",
}


def default_url(context: dict) -> str:
    return URLS.get(context["settings"]["database"], URLS["postgresql"])


def data_source_file(context: dict) -> dict:
    imports = TsImports("src/data-source").only("reflect-metadata").from_("typeorm", "DataSource")
    for info in context["tables"]:
        imports.from_(module_of(context, info, "entity"), info["entity"])
    entities = ", ".join(info["entity"] for info in context["tables"])
    content = lines(
        "/** The TypeORM data source: the database DATABASE_URL names (see .env.example), and every entity. */",
        imports.write(),
        "",
        f"export const DATABASE_URL = process.env.DATABASE_URL ?? {quote(default_url(context))}",
        "",
        "/** Every entity, so the data source knows every table */",
        f"export const ENTITIES = [{entities}]",
        "",
        "/**",
        " * A data source for the database at `url`: postgresql://, mysql:// (also MariaDB) or sqlite:<file> (sqlite::memory:",
        " * for one in memory). Call initialize() before using it. Whole numbers come back as numbers, and dates in UTC.",
        " */",
        "export function createDataSource(url: string = DATABASE_URL): DataSource {",
        "  const scheme = url.slice(0, url.indexOf(':'))",
        "  if (scheme === 'sqlite') {",
        "    const file = url.slice('sqlite:'.length).replace(/^\\/\\//, '')",
        "    return new DataSource({ type: 'better-sqlite3', database: file || ':memory:', entities: ENTITIES })",
        "  }",
        "  if (scheme === 'postgresql' || scheme === 'postgres') return new DataSource({ type: 'postgres', url, entities: ENTITIES, parseInt8: true })",
        "  if (scheme === 'mysql' || scheme === 'mariadb')",
        "    return new DataSource({",
        "      type: 'mysql',",
        "      url: url.replace(/^mariadb:/, 'mysql:'),",
        "      entities: ENTITIES,",
        "      supportBigNumbers: true,",
        "      bigNumberStrings: false,",
        "      timezone: 'Z',",
        "    })",
        "  throw new Error(`DATABASE_URL names a database this project does not know: ${scheme}`)",
        "}",
        "",
    )
    return {"path": "src/data-source.ts", "content": content}


def column_types_file(context: dict) -> dict | None:
    """src/column-types.ts, when a column needs it: exact decimals stay text."""
    decimals = any(
        info["writesEntity"] and any(column["column"]["type"]["kind"] == "decimal" for column in info["columns"])
        for info in context["tables"]
    )
    if not decimals:
        return None
    return {
        "path": "src/column-types.ts",
        "content": lines(
            "/** How some values are read from the database. */",
            "import type { ValueTransformer } from 'typeorm'",
            "",
            "/** Exact decimals stay text: drivers return them as text (or as numbers, SQLite), and nothing is rounded. */",
            "export const decimalText: ValueTransformer = {",
            "  to: (value: unknown) => value,",
            "  from: (value: unknown) => (value === null || value === undefined ? value : String(value)),",
            "}",
            "",
        ),
    }


# Entities


def _orm_type(column_type: dict, database: str) -> str:
    """The column type TypeORM writes for the chosen database."""
    kind = column_type["kind"]
    sqlite = database == "sqlite"
    postgres = database == "postgresql"
    if kind == "integer":
        if sqlite:
            return "integer"
        bits = column_type.get("bits")
        return "smallint" if bits == 16 else "bigint" if bits == 64 else "integer" if postgres else "int"
    if kind == "decimal":
        return "numeric" if postgres else "decimal"
    if kind == "float":
        if sqlite:
            return "real"
        if column_type.get("bits") == 32:
            return "real" if postgres else "float"
        return "double precision" if postgres else "double"
    if kind == "text":
        return "text" if "length" not in column_type else "char" if column_type.get("fixed") else "varchar"
    if kind in ("boolean", "date", "time"):
        return kind
    if kind == "datetime":
        return ("timestamptz" if column_type.get("timezone") else "timestamp") if postgres else "datetime"
    if kind == "uuid":
        return "varchar" if sqlite else "uuid"
    if kind == "binary":
        return "bytea" if postgres else "blob" if sqlite else "varbinary" if "length" in column_type else "blob"
    if kind in ("json", "array"):
        # Arrays are portable as JSON; a native PostgreSQL array is a decision for the user
        return "simple-json" if sqlite else "json"
    if kind == "enum":
        return "simple-enum" if sqlite else "enum"
    return "text"


def _column_options(context: dict, column: dict, imports: TsImports, primary: bool) -> list[str]:
    db = column["column"]
    column_type = db["type"]
    kind = column_type["kind"]
    database = context["settings"]["database"]
    options = []
    if column["prop"] != db["name"]:
        options.append(f"name: {quote(db['name'])}")
    options.append(f"type: {quote(_orm_type(column_type, database))}")
    if kind == "text" and "length" in column_type:
        options.append(f"length: {number_text(column_type['length'])}")
    if kind == "uuid" and database == "sqlite":
        options.append("length: 36")
    if kind == "binary" and "length" in column_type and database not in ("postgresql", "sqlite"):
        options.append(f"length: {number_text(column_type['length'])}")
    if kind == "decimal":
        if "precision" in column_type:
            options.extend(
                [
                    f"precision: {number_text(column_type['precision'])}",
                    f"scale: {number_text(column_type.get('scale', 0))}",
                ]
            )
        imports.from_("src/column-types", "decimalText")
        options.append("transformer: decimalText")
    if kind == "enum":
        item = next(
            (candidate for candidate in context["schema"]["enums"] if candidate["name"] == column_type["name"]), None
        )
        values = item["values"] if item else []
        options.append(f"enum: [{', '.join(quote(value) for value in values)}]")
        if database == "postgresql":
            options.append(f"enumName: {quote(column_type['name'])}")
    if not primary and db["nullable"]:
        options.append("nullable: true")
    generated = db.get("generated")
    if generated in ("now", "onUpdateNow"):
        options.append("default: () => 'CURRENT_TIMESTAMP'")
        if generated == "onUpdateNow" and database not in ("postgresql", "sqlite"):
            options.append("onUpdate: 'CURRENT_TIMESTAMP'")
    if isinstance(generated, dict):
        options.extend(
            [
                "generatedType: 'STORED'",
                f"asExpression: {quote(generated['computed'])}",
                "insert: false",
                "update: false",
            ]
        )
    default = db.get("default")
    if default and default["kind"] == "literal":
        options.append(f"default: {ts_literal(default['value'])}")
    if default and default["kind"] == "expression":
        options.append(f"default: () => {quote(default['sql'])}")
    if db.get("comment"):
        options.append(f"comment: {quote(db['comment'])}")
    return options


def _column_lines(context: dict, info: dict, column: dict, imports: TsImports) -> list:
    db = column["column"]
    generated = db.get("generated")
    primary = is_in(column, info["key"])
    options = ", ".join(_column_options(context, column, imports, primary))
    has_key = info["table"]["primaryKey"] is not None
    decorators = []
    if primary and generated == "identity" and has_key:
        imports.from_("typeorm", "PrimaryGeneratedColumn")
        decorators.append(f"@PrimaryGeneratedColumn({{ {options} }})")
    elif primary and generated == "uuid" and has_key:
        imports.from_("typeorm", "PrimaryGeneratedColumn")
        named = f", {{ name: {quote(db['name'])} }}" if column["prop"] != db["name"] else ""
        decorators.append(f"@PrimaryGeneratedColumn('uuid'{named})")
    else:
        decorator = "PrimaryColumn" if primary else "Column"
        imports.from_("typeorm", decorator)
        decorators.append(f"@{decorator}({{ {options} }})")
        if not primary and generated in ("identity", "uuid"):
            imports.from_("typeorm", "Generated")
            decorators.append(f"@Generated({quote('uuid' if generated == 'uuid' else 'increment')})")
    optional = db["nullable"] and not primary
    kind = db["type"]["kind"]
    return [
        kind == "unknown" and f'  // TODO: "{db["type"]["sql"]}" has no TypeORM type here; it is mapped as text',
        kind == "array"
        and f'  // TODO: "{db["type"]["sql"]}" is mapped as JSON; use `array: true` on PostgreSQL if you need the native array',
        *(f"  {decorator}" for decorator in decorators),
        f"  {column['prop']}!: {column['ts'] + ' | null' if optional else column['ts']}",
    ]


def _relation_name(info: dict, key: dict) -> str:
    """The property of the row a foreign key points to: category for category_id."""
    if len(key["columns"]) == 1:
        base = member_name(re.sub(r"_id$", "", key["columns"][0], flags=re.IGNORECASE))
    else:
        base = member_name(key["references"]["table"])
    taken = any(column["prop"] == base for column in info["columns"])
    return f"{base}Ref" if taken else base


ACTIONS = {
    "cascade": "CASCADE",
    "set null": "SET NULL",
    "set default": "SET DEFAULT",
    "restrict": "RESTRICT",
    "no action": "NO ACTION",
}


def _relation_lines(context: dict, info: dict, imports: TsImports) -> list:
    """A many-to-one relation for each foreign key, so the database gets the constraint; the key columns stay properties."""
    result = []
    for key in info["table"]["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        if not parent or parent["table"]["primaryKey"] is None:
            continue
        imports.from_("typeorm", "ManyToOne", "JoinColumn").type("typeorm", "Relation")
        if parent is not info:
            imports.from_(module_of(context, parent, "entity"), parent["entity"])
        nullable = any(column_of(info, name)["column"]["nullable"] for name in key["columns"])
        options = [f"nullable: {'true' if nullable else 'false'}"]
        if key.get("onDelete"):
            options.append(f"onDelete: '{ACTIONS[key['onDelete']]}'")
        if key.get("onUpdate"):
            options.append(f"onUpdate: '{ACTIONS[key['onUpdate']]}'")
        constraint = (
            f", foreignKeyConstraintName: {quote(key['name'])}" if key.get("name") and len(key["columns"]) == 1 else ""
        )
        joins = [
            f"{{ name: {quote(name)}, referencedColumnName: {quote(column_of(parent, key['references']['columns'][position])['prop'])}{constraint} }}"
            for position, name in enumerate(key["columns"])
        ]
        join = joins[0] if len(joins) == 1 else f"[{', '.join(joins)}]"
        result.extend(
            [
                "",
                f"  /** The {parent['entity']} this row points to ({', '.join(key['columns'])}); loaded only when asked for */",
                f"  @ManyToOne(() => {parent['entity']}, {{ {', '.join(options)} }})",
                f"  @JoinColumn({join})",
                f"  {_relation_name(info, key)}?: Relation<{parent['entity']}>",
            ]
        )
    return result


def _class_decorators(info: dict, imports: TsImports) -> list[str]:
    table = info["table"]

    def props(names: list[str]) -> str:
        return f"[{', '.join(quote(column_of(info, name)['prop']) for name in names)}]"

    result = []
    options = [f"name: {quote(table['name'])}"]
    if table.get("schema"):
        options.append(f"schema: {quote(table['schema'])}")
    if table["primaryKey"] is None:
        options.append("synchronize: false")
    imports.from_("typeorm", "Entity")
    result.append(f"@Entity({{ {', '.join(options)} }})")
    for unique in table["uniques"]:
        imports.from_("typeorm", "Unique")
        result.append(
            f"@Unique({quote(unique['name'])}, {props(unique['columns'])})"
            if unique.get("name")
            else f"@Unique({props(unique['columns'])})"
        )
    for index in table["indexes"]:
        imports.from_("typeorm", "Index")
        result.append(
            f"@Index({quote(index['name'])}, {props(index['columns'])})"
            if index.get("name")
            else f"@Index({props(index['columns'])})"
        )
    for check in table["checks"]:
        imports.from_("typeorm", "Check")
        result.append(
            f"@Check({quote(check['name'])}, {quote(check['sql'])})"
            if check.get("name")
            else f"@Check({quote(check['sql'])})"
        )
    return result


def entity_file(context: dict, info: dict) -> dict:
    module = module_of(context, info, "entity")
    imports = TsImports(module)
    decorators = _class_decorators(info, imports)
    columns = [
        item
        for index, column in enumerate(info["columns"])
        for item in ("" if index > 0 else None, *_column_lines(context, info, column, imports))
    ]
    relations = _relation_lines(context, info, imports)
    comment = info["table"].get("comment")
    content = lines(
        f'/** Entity of the "{info["name"]}" table{": " + comment if comment else ""}. */',
        imports.write(),
        "",
        info["table"]["primaryKey"] is None
        and [
            "// The table has no primary key: rows are told apart by all their columns, for reading only, and the",
            "// tests' data source does not create it (synchronize: false)",
        ],
        f'/** A row of the "{info["name"]}" table. */',
        *decorators,
        f"export class {info['entity']} {{",
        *columns,
        *relations,
        "}",
        "",
    )
    return {"path": path_of(module), "content": content}


def database_files(context: dict) -> list[dict]:
    files = [data_source_file(context)]
    if writes_entities(context):
        files.append(column_types_file(context))
    files.extend(entity_file(context, info) for info in context["tables"] if info["writesEntity"])
    return [file for file in files if file is not None]
