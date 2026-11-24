"""The entity of each table (a plain struct with a property per column, every one of them nil until it is set) and its
Fluent model, which maps the table's exact name and columns: a column with @Field, or @OptionalField when it takes
null, and the key with @ID, or @CompositeID when it has several columns. Fluent reads and writes rows through the model;
the repositories turn models into entities and back. The constraints of the table live in the database: the tests
create them, and the services check the values. Mirrors web/src/core/generators/swift/fluent/entities.ts."""

from ..context import file_of, is_in, sw_file
from ..swift import imports, sw_string


def entity_file(context: dict, info: dict) -> dict:
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    params = ", ".join(f"{column['prop']}: {column['sw']}? = nil" for column in info["columns"])
    return sw_file(
        file_of(context, info, "entity", info["entity"]),
        imports("Foundation"),
        [
            f'/// A row of the "{info["name"]}" table{comment}. A property stays nil until it is set or read.',
            f"public struct {info['entity']}: Sendable, Equatable {{",
            *(f"    public var {column['prop']}: {column['sw']}?" for column in info["columns"]),
            "",
            f"    public init({params}) {{",
            *(f"        self.{column['prop']} = {column['prop']}" for column in info["columns"]),
            "    }",
            "}",
        ],
    )


def _indexable(column: dict) -> bool:
    """Columns a database can index whole: not text or bytes without a length (MySQL cannot key those)."""
    column_type = column["column"]["type"]
    if column_type["kind"] in ("text", "binary"):
        return column_type.get("length") is not None
    return column_type["kind"] not in ("json", "array", "unknown")


def mapped_key(info: dict) -> list[dict]:
    """The columns the model keys a table by: its primary key, or, when it has none, the columns that cannot be null
    and can be indexed (or, failing those, every column that cannot be null). Fluent needs a key."""
    if info["table"]["primaryKey"] is not None:
        return info["key"]
    columns = [column for column in info["columns"] if not column["column"]["nullable"]]
    keyable = [column for column in columns if _indexable(column)]
    if keyable:
        return keyable
    return columns if columns else info["columns"]


def model_value(info: dict, column: dict, variable: str = "model") -> str:
    """How code reads a column of a model: model.email, the key model.id, or a part of it model.id?.line."""
    key = mapped_key(info)
    if not is_in(column, key):
        return f"{variable}.{column['prop']}"
    return f"{variable}.id" if len(key) == 1 else f"{variable}.id?.{column['prop']}"


def model_path(info: dict, column: dict) -> str:
    """The key path of a column of a model, for filters and sorts: \\.$email, \\.$id, \\.$id.$line."""
    key = mapped_key(info)
    name = column["prop"].replace("`", "")
    if not is_in(column, key):
        return f"\\.${name}"
    return "\\.$id" if len(key) == 1 else f"\\.$id.${name}"


def _field(column: dict, nullable: bool) -> list[str]:
    key = sw_string(column["column"]["name"])
    if nullable:
        return [f"@OptionalField(key: {key})", f"var {column['prop']}: {column['sw']}?"]
    return [f"@Field(key: {key})", f"var {column['prop']}: {column['sw']}"]


def model_file(context: dict, info: dict) -> dict:
    table = info["table"]
    key = mapped_key(info)
    others = [column for column in info["columns"] if not is_in(column, key)]
    checks = [
        f"/// CHECK ({check['sql']}): the services check what they understand of it." for check in table["checks"]
    ]
    primary_key = table["primaryKey"]
    if len(key) == 1:
        column = key[0]
        by = (
            ".database"
            if column["column"].get("generated") == "identity" and primary_key is not None and len(primary_key) == 1
            else ".user"
        )
        id_lines = [
            f"@ID(custom: {sw_string(column['column']['name'])}, generatedBy: {by})",
            f"var id: {column['sw']}?",
        ]
    else:
        equal = " && ".join(f"lhs.{column['prop']} == rhs.{column['prop']}" for column in key)
        fields: list[str] = []
        for column in key:
            fields += [*(f"    {line}" for line in _field(column, False)), ""]
        id_lines = [
            "/// The key, a value of each of its columns.",
            "final class IDValue: Fields, Hashable, @unchecked Sendable {",
            *fields,
            "    init() {}",
            "",
            "    static func == (lhs: IDValue, rhs: IDValue) -> Bool {",
            f"        {equal}",
            "    }",
            "",
            "    func hash(into hasher: inout Hasher) {",
            *(f"        hasher.combine({column['prop']})" for column in key),
            "    }",
            "}",
            "",
            "@CompositeID()",
            "var id: IDValue?",
        ]
    other_lines: list[str] = []
    for column in others:
        other_lines += ["", *(f"    {line}" for line in _field(column, column["column"]["nullable"]))]
    key_names = ", ".join(column["key"] for column in key)
    return sw_file(
        file_of(context, info, "model", info["model"]),
        imports("FluentKit", "Foundation"),
        [
            f'/// The "{table["name"]}" table, as the database has it. Fluent never creates or changes it: the database already exists.',
            *(["///", *checks] if checks else []),
            *(
                []
                if primary_key is not None
                else ["///", f"/// It has no primary key: the model keys its rows by {key_names}."]
            ),
            f"final class {info['model']}: Model, @unchecked Sendable {{",
            f"    static let schema = {sw_string(table['name'])}",
            *([f"    static let space: String? = {sw_string(table['schema'])}"] if table.get("schema") else []),
            "",
            *("" if line == "" else f"    {line}" for line in id_lines),
            *other_lines,
            "",
            "    init() {}",
            "}",
        ],
    )
