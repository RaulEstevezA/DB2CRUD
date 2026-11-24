"""The entity of each collection, for Spring Data MongoDB: the stored name and type of every field, a class per nested
document, and the indexes, which only the tests create. Mirrors web/src/core/generators/java/springdata/entities.ts."""

from ...types import lines
from ..context import package_of
from ..documents import identified_lists, nested_imports
from ..java import JavaImports, java_path, java_string

MAPPING = "org.springframework.data.mongodb.core.mapping"


def _innermost(column_type: dict) -> dict:
    return _innermost(column_type["items"]) if column_type["kind"] == "array" else column_type


def _field_annotation(column: dict, prop: str, imports: JavaImports) -> list[str]:
    """`@Field`, when the stored name or type is not what Spring would write."""
    if column["name"] == "_id":
        return []
    column_type = _innermost(column["type"])
    target = None
    if column_type["kind"] == "text" and column_type.get("objectId"):
        target = "OBJECT_ID"
    elif column_type["kind"] == "decimal":
        target = "DECIMAL128"
    named = column["name"] != prop
    if not named and not target:
        return []
    imports.add(f"{MAPPING}.Field")
    if not target:
        return [f"@Field({java_string(column['name'])})"]
    imports.add(f"{MAPPING}.FieldType")
    name = f"name = {java_string(column['name'])}, " if named else ""
    return [f"@Field({name}targetType = FieldType.{target})"]


def _accessors(fields: list[dict]) -> list[str]:
    result = []
    for field in fields:
        result += [
            "",
            f"public {field['java']} {field['getter']}() {{",
            f"    return {field['prop']};",
            "}",
            "",
            f"public void {field['setter']}({field['java']} {field['prop']}) {{",
            f"    this.{field['prop']} = {field['prop']};",
            "}",
        ]
    return result


def _indented(items: list[str]) -> list[str]:
    return ["" if line == "" else f"    {line}" for line in items]


def _nested_block(item: dict, imports: JavaImports) -> list[str]:
    body = []
    for index, field in enumerate(item["fields"]):
        if index > 0:
            body.append("")
        body += _field_annotation(field["column"], field["prop"], imports)
        if field["column"].get("comment"):
            body.append(f"/** {field['column']['comment']} */")
        body.append(f"private {field['java']} {field['prop']};")
    body += _accessors(item["fields"])
    for inner in item["classes"]:
        body += ["", *_nested_block(inner, imports)]
    return [
        "/** A nested document: it is stored with the one that holds it. */",
        f"public static class {item['name']} {{",
        *_indented(body),
        "}",
    ]


def _keys(columns: list[str]) -> str:
    """The path of an index key in Spring's JSON: `{'year': 1, 'number': 1}`."""
    return "{" + ", ".join(f"'{column}': 1" for column in columns) + "}"


def _class_annotations(info: dict, imports: JavaImports) -> list[str]:
    imports.add(f"{MAPPING}.Document")
    table = info["table"]
    nullable = {column["name"]: column["nullable"] for column in table["columns"]}

    def head(item: dict) -> str:
        name = f"name = {java_string(item['name'])}, " if item.get("name") else ""
        return f"{name}def = {java_string(_keys(item['columns']))}"

    indexes = []
    for unique in table["uniques"]:
        sparse = ", sparse = true" if all(nullable.get(name) for name in unique["columns"]) else ""
        indexes.append(f"@CompoundIndex({head(unique)}, unique = true{sparse})")
    indexes += [f"@CompoundIndex({head(index)})" for index in table["indexes"]]
    if indexes:
        imports.add("org.springframework.data.mongodb.core.index.CompoundIndex")
    if len(indexes) > 1:
        imports.add("org.springframework.data.mongodb.core.index.CompoundIndexes")
        indexes = ["@CompoundIndexes({", *(f"    {item}," for item in indexes), "})"]
    return [f"@Document(collection = {java_string(info['name'])})", *indexes]


def entity_file(context: dict, info: dict) -> dict:
    pkg = package_of(context, info, "entity")
    nested = list(info["nested"].values())
    imports = JavaImports(pkg).add("org.springframework.data.annotation.Id", *nested_imports(nested))
    for column in info["columns"]:
        if column["javaImport"]:
            imports.add(column["javaImport"])
    annotations = _class_annotations(info, imports)
    fields: list = []
    for index, column in enumerate(info["columns"]):
        db = column["column"]
        fields.append("" if index > 0 else None)
        fields.append(f"    /** {db['comment']} */" if db.get("comment") else None)
        if db["name"] == "_id":
            fields.append("    @Id")
        else:
            fields += [f"    {line}" for line in _field_annotation(db, column["prop"], imports)]
        fields.append(f"    private {column['java']} {column['prop']};")
    lists = identified_lists(info)
    identify: list[str] = []
    if lists:
        imports.add("org.bson.types.ObjectId")
        identify = [
            "",
            "    /** Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents. */",
            "    public void identifyItems() {",
        ]
        for column in lists:
            identify += [
                f"        if ({column['prop']} != null) {{",
                f"            {column['prop']}.forEach((item) -> {{",
                "                if (item.getId() == null) item.setId(new ObjectId().toHexString());",
                "            });",
                "        }",
            ]
        identify.append("    }")
    # Written before the imports, which it adds to
    classes: list[str] = []
    for item in nested:
        classes += ["", *_indented(_nested_block(item, imports))]
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    content = lines(
        f"package {pkg};",
        "",
        imports.write(),
        "",
        f'/** A document of the "{info["name"]}" collection{comment}. Its indexes are for the tests: in the application\'s database they are not touched. */',
        *annotations,
        f"public class {info['entity']} {{",
        *fields,
        *_indented(_accessors(info["columns"])),
        *identify,
        *classes,
        "}",
        "",
    )
    return {"path": java_path(pkg, info["entity"]), "content": content}
