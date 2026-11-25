"""The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
are not as they were read (so two people changing different fields do not undo each other, and the ones the entity does
not know are kept), and one item of a list is added or removed in the database. Mirrors
web/src/core/generators/kotlin/mongodb/repository.ts."""

from ....schema.documents import is_object_id
from ..context import column_of, is_in, query
from ..documents import identified_lists, list_of
from ..kotlin import KtImports, kt_string
from ..repositories import memory_fill
from .values import document_functions, encode

_KEEP = "READ[entity] = Documents.copy({}) as Document"


def _changeable(info: dict, column: dict) -> bool:
    return (
        not is_in(column, info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    )


def _updates(info: dict) -> bool:
    return query(info, "update") is not None and any(_changeable(info, column) for column in info["columns"])


def _touched_by(info: dict) -> list[dict]:
    """The columns that take the time of each change."""
    return [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]


def _equal(column: dict, value: str, imports: KtImports) -> tuple[str, str]:
    return column["column"]["name"], encode(column["column"]["type"], value, None, imports)


def _soft_condition(info: dict) -> list[tuple[str, str]]:
    soft = info["soft"]
    if not soft:
        return []
    boolean = soft["column"]["type"]["kind"] == "boolean"
    return [(soft["column"]["name"], 'Document("\\$ne", true)' if boolean else "null")]


def _filter(conditions: list[tuple[str, str]]) -> str:
    """`Document("a", a).append("b", b)`"""
    if not conditions:
        return "Document()"
    (name, value), *others = conditions
    appended = "".join(f".append({kt_string(other)}, {item})" for other, item in others)
    return f"Document({kt_string(name)}, {value}){appended}"


def _guards(columns: list[dict], nothing: str, imports: KtImports) -> list[str]:
    """What a text that is not an identifier finds."""
    result = []
    for column in columns:
        if is_object_id(column["column"]["type"]):
            imports.add("org.bson.types.ObjectId")
            result.append(f"if (!ObjectId.isValid({column['prop']})) return {nothing}")
    return result


def head(context: dict, info: dict) -> list[str]:
    result = []
    if not context["settings"]["repositoryInterfaces"]:
        result += ['    private val db get() = checkNotNull(held) { "This repository has no database" }', ""]
    result.append(f"    private val collection = {kt_string(info['name'])}")
    if _updates(info):
        names = ", ".join(
            kt_string(column["column"]["name"]) for column in info["columns"] if _changeable(info, column)
        )
        result += ["", "    /** The fields a change may write */", f"    private val fields = listOf({names})"]
    return result


def body(context: dict, info: dict, method: dict, imports: KtImports) -> list[str]:
    imports.add("org.bson.Document")
    key = info["key"][0]
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(info)
    sort = f"sort = Document({kt_string(key['column']['name'])}, 1)"

    def given() -> str:
        return _filter([*(_equal(column, column["prop"], imports) for column in columns), *soft])

    entity = kt_string(info["entity"])
    read = "loaded(it)" if _updates(info) else "fromDocument(it)"
    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        return [
            *_guards(columns, "null", imports),
            f"return db.find(collection, {given()}, limit = 1).firstOrNull()?.let {{ {read} }}",
        ]
    if kind in ("listByParent", "findAllBy"):
        return [
            *_guards(columns, "emptyList()", imports),
            f"return db.find(collection, {given()}, {sort}).map {{ {read} }}",
        ]
    if kind == "list":
        paging = context["settings"]["paging"]
        where = _filter(soft)
        if paging == "offset":
            page = f"db.find(collection, {where}, {sort}, skip = offset, limit = limit).map {{ {read} }}"
            return [
                f"val items = if (limit > 0) {page} else emptyList()",
                f"return Page(items, db.count(collection, {where}), offset, limit)",
            ]
        if paging == "cursor":
            after = encode(key["column"]["type"], f"after[0] as {key['kt']}", None, imports)
            return [
                f"val filter = {where}",
                f'if (after != null) filter[{kt_string(key["column"]["name"])}] = Document("\\$gt", {after})',
                f"val rows = db.find(collection, filter, {sort}, limit = limit + 1).map {{ {read} }}",
                "val items = rows.take(limit)",
                f"return CursorPage(items, if (rows.size > limit) listOf(items.last().{key['prop']}!!) else null)",
            ]
        return [f"return db.find(collection, {where}, {sort}).map {{ {read} }}"]
    if kind == "insert":
        # MongoDB fills nothing but the identifier
        fills = [memory_fill(column, imports) for column in info["columns"]]
        return [
            *(line for line in fills if line is not None),
            *(["entity.identifyItems()"] if identified_lists(info) else []),
            f"db.insert({entity}, collection, toDocument(entity))",
            *([_KEEP.format("toDocument(entity)")] if _updates(info) else []),
            "return entity",
        ]
    if kind == "update":
        if not _updates(info):
            return ["// Nothing of it can change but its key", "return entity"]
        imports.add("app.Documents")
        touched = _touched_by(info)
        for column in touched:
            if column["ktImport"]:
                imports.add(column["ktImport"])
        stamps = [kt_string(column["column"]["name"]) for column in touched]
        return [
            *(f"entity.{column['prop']} = {column['kt']}.now()" for column in touched),
            *(["entity.identifyItems()"] if identified_lists(info) else []),
            "val now = toDocument(entity)",
            "val changes = Documents.changes(READ[entity], now, fields)",
            "if (changes.isNotEmpty()) {",
            *(
                f'    (changes.getOrPut("\\$set") {{ Document() }} as Document)[{name}] = now[{name}]'
                for name in stamps
            ),
            f'    db.update({entity}, collection, Document("_id", now["_id"]), changes)',
            "}",
            _KEEP.format("now"),
            "return entity",
        ]
    if kind == "delete":
        where = _filter([_equal(key, f"entity.{key['prop']}!!", imports)])
        return [f"db.delete({entity}, collection, {where})"]
    if kind in ("addItem", "removeItem"):
        return _item_body(info, method, imports)
    return ["throw UnsupportedOperationException()"]


def _item_body(info: dict, method: dict, imports: KtImports) -> list[str]:
    """One item of a list added or removed in the database, whatever the rest of the list is by then."""
    items = list_of(info, method["query"])
    key = info["key"][0]
    param = items["params"][0]
    stored_name = items["column"]["column"]["name"]
    path = kt_string(stored_name)
    touched = []
    for column in _touched_by(info):
        imports.add("java.util.Date")
        touched.append((column["column"]["name"], "Date()"))
    version = info["version"]["column"]["name"] if info["version"] else None
    conditions = [_equal(key, key["prop"], imports), *_soft_condition(info)]
    result = _guards([key], "null", imports)
    adds = method["query"]["kind"] == "addItem"
    rewrites = not adds and items["by"] == "position"
    if rewrites:
        # MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
        conditions.append((stored_name, 'Document("\\$size", size)'))
        kept = kt_string(f"${stored_name}")
        sets = [(stored_name, 'Document("\\$concatArrays", listOf(head, tail))'), *touched]
        if version:
            sets.append((version, f'Document("\\$add", listOf({kt_string(f"${version}")}, 1))'))
        result += [
            f'val head = Document("\\$slice", listOf({kept}, position))',
            f'val tail = Document("\\$slice", listOf({kept}, position + 1, maxOf(size, 1)))',
            f'val change = listOf(Document("\\$set", {_filter(sets)}))',
        ]
    else:
        if adds:
            if items["by"] == "id":
                imports.add("org.bson.types.ObjectId")
                result.append(f"{items['item']}.id = {items['item']}.id ?: ObjectId().toHexString()")
            pushed = encode(items["type"], items["item"], items["nested"], imports)
            main = f'Document("\\$push", Document({path}, {pushed}))'
        elif items["by"] == "id":
            imports.add("org.bson.types.ObjectId")
            result.append(f"if (!ObjectId.isValid({param['name']})) return null")
            main = f'Document("\\$pull", Document({path}, Document("_id", ObjectId({param["name"]}))))'
        else:
            pulled = encode(items["type"], param["name"], items["nested"], imports)
            main = f'Document("\\$pull", Document({path}, {pulled}))'
        also = f'.append("\\$set", {_filter(touched)})' if touched else ""
        if version:
            also += f'.append("\\$inc", Document({kt_string(version)}, 1))'
        result.append(f"val change = {main}{also}")
    call = "rewrite" if rewrites else "change"
    read = "loaded(it)" if _updates(info) else "fromDocument(it)"
    return [
        *result,
        f"return db.{call}({kt_string(info['entity'])}, collection, {_filter(conditions)}, change)?.let {{ {read} }}",
    ]


def helpers(_context: dict, info: dict, imports: KtImports) -> list[str]:
    result = []
    if _updates(info):
        imports.add("app.Documents", "java.util.Collections", "java.util.WeakHashMap")
        result += [
            "",
            "    /** The entity of a document, with the document kept to tell its changes. */",
            f"    private fun loaded(document: Document): {info['entity']} {{",
            "        val entity = fromDocument(document)",
            f"        {_KEEP.format('toDocument(entity)')}",
            "        return entity",
            "    }",
        ]
    fields = [
        {
            "name": column["column"]["name"],
            "type": column["column"]["type"],
            "prop": column["prop"],
            "nested": info["nested"].get(column["column"]["name"]),
        }
        for column in info["columns"]
    ]
    result += document_functions(info["entity"], fields, info["nested"].values(), imports)
    if _updates(info):
        result += [
            "",
            "    private companion object {",
            "        /** The document each entity was read from: a change writes only the fields that differ */",
            f"        val READ: MutableMap<{info['entity']}, Document> = Collections.synchronizedMap(WeakHashMap())",
            "    }",
        ]
    return result
