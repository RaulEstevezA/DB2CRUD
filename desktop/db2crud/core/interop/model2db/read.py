"""Reads a saved Model2DB project (model2db-project) into a physical schema. The project keeps the input text, the
design decisions and the output settings, not the tables, so the tables are built again the way Model2DB builds
them, with a copy of its code (vendor/, decision 15). Mirrors web/src/core/interop/model2db/read.ts."""

import re

from .vendor.design.edit import reconcile
from .vendor.generate.sql.sql import sql_column_type
from .vendor.interop.project import read_project
from .vendor.parsers.registry import detect_format, parse_input
from .vendor.physical.relational.schema import build_relational

_ALL = ["postgresql", "mysql", "mariadb", "sqlite", "sqlserver", "oracle"]

# Engines of each relational output of Model2DB (generate/outputs): an SQL output is its own engine, an ORM or a
# migration tool uses the project's engine when it supports it, and its first one otherwise
RELATIONAL_OUTPUTS: dict[str, list[str] | None] = {
    "postgresql": None,
    "mysql": None,
    "mariadb": None,
    "sqlite": None,
    "sqlserver": None,
    "oracle": None,
    "flyway": _ALL,
    "liquibase": _ALL,
    "django": ["postgresql", "mysql", "mariadb", "sqlite", "oracle"],
    "sqlalchemy": _ALL,
    "sqlmodel": _ALL,
    "tortoise": _ALL,
    "prisma": ["postgresql", "mysql", "mariadb", "sqlite", "sqlserver"],
    "typeorm": _ALL,
    "sequelize": _ALL,
    "drizzle": ["postgresql", "mysql", "mariadb", "sqlite"],
    "jpa": _ALL,
    "hibernate": _ALL,
    "spring-data-jpa": _ALL,
    "efcore": ["sqlserver", "postgresql", "mysql", "mariadb", "sqlite", "oracle"],
    "eloquent": ["mysql", "mariadb", "postgresql", "sqlite", "sqlserver"],
    "doctrine": ["mysql", "mariadb", "postgresql", "sqlite", "sqlserver", "oracle"],
}

# Outputs that write SQL or migrations, not classes: their tables have no entity of their own
SQL_OUTPUTS = {"postgresql", "mysql", "mariadb", "sqlite", "sqlserver", "oracle", "flyway", "liquibase"}


def _engine_of(output: str, engine: str) -> str:
    engines = RELATIONAL_OUTPUTS[output]
    if not engines:
        return output
    return engine if engine in engines else engines[0]


def _relational_of(project: dict):
    """The tables Model2DB builds for the project, or the code of why it cannot."""
    source, output = project["input"], project["output"]
    if output["output"] not in RELATIONAL_OUTPUTS:
        return "notRelational"
    format_id = source.get("format") or detect_format(source["text"], source.get("fileName"))
    if not format_id:
        return "unreadableInput"
    outcome = parse_input(source["text"], format_id, {"rootName": "Root"})
    if not outcome["ok"]:
        return "noModels" if outcome["error"]["code"] == "noModels" else "unreadableInput"
    if not outcome["schema"]["models"]:
        return "noModels"
    design = reconcile(project["designs"]["relational"], outcome["schema"], "relational")
    engine = _engine_of(output["output"], output["engine"])
    options = {"naming": output["naming"]["relational"], "strings": output["strings"], "dialect": engine}
    return build_relational(outcome["schema"], design, options), engine


# Writing it as db-schema


def _bits_of(column_type: dict) -> int:
    bits = column_type.get("bits")
    if bits == 64:
        return 64
    return 16 if bits is not None and bits <= 16 else 32


def _db_type(column_type: dict, engine: str, enums: list[dict]) -> dict:
    sql = sql_column_type(column_type, engine, enums)
    kind = column_type["kind"]
    if kind == "raw":
        return {"sql": sql, "kind": "unknown"}
    if kind == "json":
        return {"sql": sql, "kind": "json"}
    if kind == "array":
        return {"sql": sql, "kind": "array", "items": _db_type(column_type["items"], engine, enums)}
    if kind == "enum":
        physical = next((item for item in enums if item["name"] == column_type["name"]), None)
        if physical and physical["storage"] == "native":
            return {"sql": sql, "kind": "enum", "name": physical["sqlName"]}
        return {"sql": sql, "kind": "text"}
    name = column_type["name"]
    if name == "string":
        return {"sql": sql, "kind": "text", **({"length": column_type["length"]} if "length" in column_type else {})}
    if name == "integer":
        return {"sql": sql, "kind": "integer", "bits": _bits_of(column_type)}
    if name == "float":
        return {"sql": sql, "kind": "float", "bits": 32 if column_type.get("bits") == 32 else 64}
    if name == "decimal":
        result = {"sql": sql, "kind": "decimal"}
        for key in ("precision", "scale"):
            if key in column_type:
                result[key] = column_type[key]
        return result
    if name in ("time", "datetime"):
        pattern = r"zone|tz" if name == "time" else r"zone|tz|offset"
        return {"sql": sql, "kind": name, "timezone": bool(re.search(pattern, sql, re.IGNORECASE))}
    if name in ("boolean", "date", "uuid", "binary"):
        return {"sql": sql, "kind": name}
    if name == "any":
        return {"sql": sql, "kind": "json"}
    return {"sql": sql, "kind": "unknown"}


def _db_column(column: dict, engine: str, enums: list[dict]) -> dict:
    result = {"name": column["name"], "type": _db_type(column["type"], engine, enums), "nullable": column["nullable"]}
    if "defaultValue" in column:
        result["default"] = {"kind": "literal", "value": column["defaultValue"]}
    if column.get("generated"):
        result["generated"] = column["generated"]
    return result


def _quoted(value) -> str:
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return str(value)


def _db_table(table: dict, engine: str, enums: list[dict], with_entities: bool) -> dict:
    foreign_keys = []
    for key in table["foreignKeys"]:
        item = {
            "name": key["name"],
            "columns": key["columns"],
            "references": {"table": key["table"], "columns": key["references"]},
        }
        for source, target in (("onDelete", "onDelete"), ("field", "attribute"), ("inverse", "inverse")):
            if key.get(source):
                item[target] = key[source]
        foreign_keys.append(item)
    result = {
        "name": table["name"],
        "columns": [_db_column(column, engine, enums) for column in table["columns"]],
        "primaryKey": table["primaryKey"] if table["primaryKey"] else None,
        "foreignKeys": foreign_keys,
        "uniques": [{"name": index["name"], "columns": index["columns"]} for index in table["uniques"]],
        "indexes": [{"name": index["name"], "columns": index["columns"]} for index in table["indexes"]],
        "checks": [
            {
                "name": check["name"],
                "sql": f"{check['column']} IN ({', '.join(_quoted(value) for value in check['values'])})",
                "parsed": {"kind": "in", "column": check["column"], "values": check["values"]},
            }
            for check in table["checks"]
        ],
    }
    if with_entities and table["kind"] == "entity":
        result["entity"] = table["model"]
    return result


def _notes_of(physical: dict) -> list[dict]:
    """What the build left pending or noted, so the interface can say it."""
    notes = [{"code": f"model2db.{note['code']}", "params": note["params"]} for note in physical["notes"]]
    for table in physical["tables"]:
        for todo in table["todos"]:
            notes.append({"code": f"model2db.{todo['code']}", "params": {**todo["params"], "table": table["name"]}})
    return notes


def read_model2db_project(text: str) -> dict:
    """The physical schema of a saved Model2DB project, or why it cannot be read."""
    read = read_project(text)
    if not read["ok"]:
        return {"ok": False, "error": read["error"], **({"path": read["path"]} if read.get("path") else {})}
    built = _relational_of(read["project"])
    if isinstance(built, str):
        return {"ok": False, "error": built}
    physical, engine = built
    output = read["project"]["output"]["output"]
    with_entities = output not in SQL_OUTPUTS
    enums = [
        {"name": item["sqlName"], "values": [str(value) for value in item["values"]], "storage": item["storage"]}
        for item in physical["enums"]
        if item["storage"] in ("native", "check")
    ]
    return {
        "ok": True,
        "schema": {
            "format": "db-schema",
            "version": 1,
            "dialect": engine,
            "source": {"kind": "model2db", "format": output},
            "tables": [_db_table(table, engine, physical["enums"], with_entities) for table in physical["tables"]],
            "enums": enums,
            "notes": _notes_of(physical),
        },
    }
