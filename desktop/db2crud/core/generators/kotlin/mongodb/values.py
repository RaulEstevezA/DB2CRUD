"""Values between Kotlin and the documents of the MongoDB driver (org.bson.Document). Mirrors
web/src/core/generators/kotlin/mongodb/values.ts."""

from ....schema.documents import is_object_id
from ..kotlin import KtImports, kt_string, member_name


def _base_name(nested: dict) -> str:
    return member_name(" ".join(nested["path"].split(".")[1:])).replace("`", "")


def to_name(nested: dict) -> str:
    """The function that writes a nested class: `lineToDocument`."""
    return f"{_base_name(nested)}ToDocument"


def from_name(nested: dict) -> str:
    """The function that reads a nested class: `lineFromDocument`."""
    return f"{_base_name(nested)}FromDocument"


def encode(column_type: dict, value: str, nested: dict | None, imports: KtImports) -> str:
    """A value that is there, as a document holds it."""
    if is_object_id(column_type):
        imports.add("org.bson.types.ObjectId")
        return f"ObjectId({value})"
    kind = column_type["kind"]
    if kind == "decimal":
        imports.add("org.bson.types.Decimal128")
        return f"Decimal128({value})"
    if kind == "datetime":
        imports.add("java.util.Date")
        return f"Date.from({value})"
    if kind == "binary":
        imports.add("org.bson.types.Binary")
        return f"Binary({value})"
    if kind == "array":
        item = encode(column_type["items"], "it", nested, imports)
        return value if item == "it" else f"{value}.map {{ {item} }}"
    if kind == "json" and column_type.get("fields") is not None and nested:
        return f"{to_name(nested)}({value})"
    return value


def decode(column_type: dict, value: str, nested: dict | None, imports: KtImports) -> str:
    """A value of a document, which may be missing, as Kotlin has it."""
    if is_object_id(column_type):
        return f"{value}?.toString()"
    kind = column_type["kind"]
    if kind == "integer":
        size = {64: "Long", 16: "Short"}.get(column_type.get("bits"), "Int")
        return f"({value} as Number?)?.to{size}()"
    if kind == "float":
        return f"({value} as Number?)?.to{'Float' if column_type.get('bits') == 32 else 'Double'}()"
    if kind == "decimal":
        imports.add("app.Documents")
        return f"Documents.decimal({value})"
    if kind == "boolean":
        return f"{value} as Boolean?"
    if kind == "datetime":
        imports.add("java.util.Date")
        return f"({value} as Date?)?.toInstant()"
    if kind == "uuid":
        imports.add("java.util.UUID")
        return f"{value} as UUID?"
    if kind == "binary":
        imports.add("org.bson.types.Binary")
        return f"({value} as Binary?)?.data"
    if kind == "array":
        items = column_type["items"]
        if (items["kind"] == "json" and items.get("fields") is None) or items["kind"] == "unknown":
            return f"({value} as List<*>?)?.filterNotNull()"
        return f"({value} as List<*>?)?.mapNotNull {{ {decode(items, 'it', nested, imports)} }}"
    if kind == "json":
        if column_type.get("fields") is None or not nested:
            return value
        imports.add("org.bson.Document")
        return f"({value} as Document?)?.let {{ {from_name(nested)}(it) }}"
    if kind == "unknown":
        return value
    return f"{value} as String?"


def _pair(doc: str, kt: str, fields: list[dict], to: str, source: str, imports: KtImports) -> list[str]:
    """The functions between a class and its document: what is null is left out."""
    imports.add("org.bson.Document")
    written = []
    for field in fields:
        name = kt_string(field["name"])
        encoded = encode(field["type"], "it", field["nested"], imports)
        if "map { " in encoded:
            held = encode(field["type"], "held", field["nested"], imports)
            block = f"held -> document[{name}] = {held}"
        else:
            block = f"document[{name}] = {encoded}"
        written.append(f"        value.{field['prop']}?.let {{ {block} }}")
    read = []
    for field in fields:
        value = f"document[{kt_string(field['name'])}]"
        read.append(f"            {field['prop']} = {decode(field['type'], value, field['nested'], imports)},")
    return [
        "",
        f"    /** The document of {doc}: what is null is left out. */",
        f"    private fun {to}(value: {kt}): Document {{",
        "        val document = Document()",
        *written,
        "        return document",
        "    }",
        "",
        f"    private fun {source}(document: Document): {kt} =",
        f"        {kt}(",
        *read,
        "        )",
    ]


def _nested_pairs(item: dict, imports: KtImports) -> list[str]:
    fields = [
        {
            "name": field["column"]["name"],
            "type": field["column"]["type"],
            "prop": field["prop"],
            "nested": field["nested"],
        }
        for field in item["fields"]
    ]
    return [
        *_pair(f"a {item['path']}", item["path"], fields, to_name(item), from_name(item), imports),
        *(line for inner in item["classes"] for line in _nested_pairs(inner, imports)),
    ]


def document_functions(entity: str, fields: list[dict], classes, imports: KtImports) -> list[str]:
    return [
        *_pair(f"a {entity}", entity, fields, "toDocument", "fromDocument", imports),
        *(line for item in classes for line in _nested_pairs(item, imports)),
    ]
