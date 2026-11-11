"""Consistency checks on a physical schema, whichever importer wrote it: names that repeat, keys, indexes and checks
on columns that do not exist, foreign keys to missing tables or columns, and enums that are not declared. Errors make
the schema unusable for the tables they name; warnings are shown and the rules go on. Mirrors
web/src/core/schema/validate.ts."""

from .types import find_column, find_table, is_unique_key


def _qualified(table: dict) -> str:
    return f"{table['schema']}.{table['name']}" if table.get("schema") else table["name"]


def _enum_names(column_type: dict) -> list[str]:
    if column_type["kind"] == "enum":
        return [column_type["name"]]
    if column_type["kind"] == "array":
        return _enum_names(column_type["items"])
    return []


def validate_db_schema(schema: dict) -> list[dict]:
    """Every problem of the schema, table by table in the order of the input."""
    issues: list[dict] = []
    seen_tables: set[str] = set()
    enums = {item["name"] for item in schema["enums"]}

    for table in schema["tables"]:
        name = _qualified(table)

        def issue(code: str, severity: str, params: dict | None = None, name=name) -> None:
            issues.append({"code": code, "severity": severity, "table": name, "params": params or {}})

        if name in seen_tables:
            issue("duplicateTable", "error")
        seen_tables.add(name)
        if not table["columns"]:
            issue("noColumns", "error")

        seen_columns: set[str] = set()
        for column in table["columns"]:
            if column["name"] in seen_columns:
                issue("duplicateColumn", "error", {"column": column["name"]})
            seen_columns.add(column["name"])
            for enum_name in _enum_names(column["type"]):
                if enum_name not in enums:
                    issue("unknownEnum", "error", {"column": column["name"], "enum": enum_name})

        def require_columns(columns: list[str], place: str, constraint: str = "", table=table, issue=issue) -> None:
            for column in columns:
                if not find_column(table, column):
                    issue("unknownColumn", "error", {"column": column, "place": place, "constraint": constraint})

        if table["primaryKey"]:
            require_columns(table["primaryKey"], "primaryKey")
        for unique in table["uniques"]:
            require_columns(unique["columns"], "unique", unique.get("name") or "")
        for index in table["indexes"]:
            require_columns(index["columns"], "index", index.get("name") or "")
        for check in table["checks"]:
            if check.get("parsed"):
                require_columns([check["parsed"]["column"]], "check", check.get("name") or "")

        for key in table["foreignKeys"]:
            constraint = key.get("name") or ""
            require_columns(key["columns"], "foreignKey", constraint)
            references = key["references"]
            target = find_table(schema, references["table"], references.get("schema"))
            target_name = (
                f"{references['schema']}.{references['table']}" if references.get("schema") else references["table"]
            )
            if not target:
                issue("unknownTable", "error", {"target": target_name, "constraint": constraint})
                continue
            if len(key["columns"]) != len(references["columns"]):
                issue("foreignKeyArity", "error", {"target": target_name, "constraint": constraint})
                continue
            missing = [column for column in references["columns"] if not find_column(target, column)]
            for column in missing:
                issue(
                    "unknownColumn",
                    "error",
                    {"column": column, "place": "foreignKey", "constraint": constraint, "target": target_name},
                )
            # Engines require the referenced columns to be a key; an input that says otherwise is reported, not fixed
            if not missing and not is_unique_key(target, references["columns"]):
                issue(
                    "foreignKeyNotUnique",
                    "warning",
                    {"target": target_name, "columns": ", ".join(references["columns"]), "constraint": constraint},
                )
    return issues
