"""The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
are not as they were read (so two people changing different fields do not undo each other, and the ones the entity does
not know are kept), and one item of a list is added or removed in the database. Mirrors
web/src/core/generators/swift/mongodb/repository.ts."""

from ....schema.documents import is_object_id
from ..context import column_of, is_in
from ..documents import identified_lists, list_of
from ..repositories import memory_fill
from ..swift import sw_string
from .values import encoded


def _changeable(info: dict) -> list[dict]:
    return [
        column
        for column in info["columns"]
        if not is_in(column, info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    ]


def _touched(info: dict) -> list[dict]:
    """The columns that take the time of each change."""
    return [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]


def _equal(column: dict, value: str) -> str:
    """`"_id": try Bson.ofObjectId(id)`"""
    return f"{sw_string(column['column']['name'])}: {encoded(column['column']['type'], value)}"


def _soft_condition(info: dict) -> list[str]:
    soft = info["soft"]
    if not soft:
        return []
    kept = '["$ne": true] as BsonDocument' if soft["column"]["type"]["kind"] == "boolean" else "Bson.null"
    return [f"{sw_string(soft['column']['name'])}: {kept}"]


def _doc(conditions: list[str]) -> str:
    return f"[{', '.join(conditions)}]" if conditions else "[:]"


def _nested_doc(conditions: list[str]) -> str:
    return f"{_doc(conditions)} as BsonDocument"


def _guards(columns: list[dict], nothing: str) -> list[str]:
    """What a text that is not an identifier finds."""
    return [
        f"guard Bson.isObjectId({column['prop']}) else {{ return {nothing} }}"
        for column in columns
        if is_object_id(column["column"]["type"])
    ]


def body(context: dict, info: dict, method: dict) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    key = info["key"][0]
    key_name = sw_string(key["column"]["name"])
    soft = _soft_condition(info)
    collection = sw_string(info["name"])
    sort = f"sort: [{key_name}: 1]"
    every = f"let documentFilter: BsonDocument = {_doc(soft)}"
    entities = f".map({info['entity']}.from)"

    def given() -> str:
        conditions = [*(_equal(column, column["prop"]) for column in columns), *soft]
        return f"let documentFilter: BsonDocument = {_doc(conditions)}"

    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        return [
            *_guards(columns, "nil"),
            given(),
            f"return try await database.find({collection}, documentFilter, limit: 1).first{entities}",
        ]
    if kind in ("listByParent", "findAllBy"):
        return [
            *_guards(columns, "[]"),
            given(),
            f"return try await database.find({collection}, documentFilter, {sort}){entities}",
        ]
    if kind == "list":
        paging = context["settings"]["paging"]
        if paging == "offset":
            page = f"try await database.find({collection}, documentFilter, {sort}, skip: offset, limit: limit)"
            return [
                every,
                f"let total = try await database.count({collection}, documentFilter)",
                f"let found = limit > 0 ? {page} : []",
                f"return Page(items: try found{entities}, total: total, offset: offset, limit: limit)",
            ]
        if paging == "cursor":
            after = f'["$gt": {encoded(key["column"]["type"], "after")}] as BsonDocument'
            return [
                f"var documentFilter: BsonDocument = {_doc(soft)}",
                f"if let after {{ documentFilter[{key_name}] = {after} }}",
                f"let rows = try await database.find({collection}, documentFilter, {sort}, limit: limit + 1){entities}",
                "let items = Array(rows.prefix(limit))",
                f"return CursorPage(items: items, next: rows.count > limit ? items.last?.{key['prop']} : nil)",
            ]
        return [every, f"return try await database.find({collection}, documentFilter, {sort}){entities}"]
    if kind == "insert":
        fills = [memory_fill(column) for column in info["columns"]]
        return [
            "var entity = entity",
            # MongoDB fills nothing but the identifier
            *(line for line in fills if line is not None),
            *(["entity.identifyItems()"] if identified_lists(info) else []),
            "let document = try entity.toDocument()",
            f"try await write {{ try await database.insert({collection}, document) }}",
            "entity.loadedDocument = Loaded(document: document)",
            "return entity",
        ]
    if kind == "update":
        changeable = _changeable(info)
        if not changeable:
            return ["// Nothing of it can change but its key", "return entity"]
        touched = _touched(info)
        stamps = ", ".join(sw_string(column["column"]["name"]) for column in touched)
        fields = ", ".join(sw_string(column["column"]["name"]) for column in changeable)
        changes = "stamped" if touched else "changes"
        return [
            "var entity = entity",
            *(f"entity.{column['prop']} = Date()" for column in touched),
            *(["entity.identifyItems()"] if identified_lists(info) else []),
            "let now = try entity.toDocument()",
            f"let fields = [{fields}]",
            "let changes = Bson.changes(entity.loadedDocument.document, now, fields)",
            'if !changes.isEmpty, let id = now["_id"] {',
            *([f"    let stamped = Bson.alsoSet(changes, now, [{stamps}])"] if touched else []),
            f'    try await write {{ try await database.update({collection}, ["_id": id], {changes}) }}',
            "}",
            "entity.loadedDocument = Loaded(document: now)",
            "return entity",
        ]
    if kind == "delete":
        return [
            f"let documentFilter: BsonDocument = {_doc([_equal(key, 'entity.' + key['prop'] + '!')])}",
            f"try await write {{ try await database.delete({collection}, documentFilter) }}",
        ]
    if kind in ("addItem", "removeItem"):
        return _item_body(info, method)
    return ['fatalError("not written")']


def _item_body(info: dict, method: dict) -> list[str]:
    """One item of a list added or removed in the database, whatever the rest of the list is by then."""
    items = list_of(info, method["query"])
    key = info["key"][0]
    param = items["params"][0]["name"]
    stored_name = items["column"]["column"]["name"]
    path = sw_string(stored_name)
    touched = [f"{sw_string(column['column']['name'])}: try Bson.ofDate(Date())" for column in _touched(info)]
    version = info["version"]["column"]["name"] if info["version"] else None
    conditions = [_equal(key, key["prop"]), *_soft_condition(info)]
    result = _guards([key], "nil")
    adds = method["query"]["kind"] == "addItem"
    if not adds and items["by"] == "position":
        # MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
        conditions.append(f"{path}: {_nested_doc([chr(34) + '$size' + chr(34) + ': size'])}")
        kept = sw_string(f"${stored_name}")
        both = _nested_doc(['"$concatArrays": [head, tail] as BsonDocument'])
        sets = [f"{path}: {both}", *touched]
        if version:
            added = _nested_doc([f'"$add": [{sw_string("$" + version)}, Int32(1)] as BsonDocument'])
            sets.append(f"{sw_string(version)}: {added}")
        result += [
            f'let head: BsonDocument = ["$slice": [{kept}, position] as BsonDocument]',
            f'let tail: BsonDocument = ["$slice": [{kept}, position + 1, max(size, 1)] as BsonDocument]',
            f"let set: BsonDocument = {_doc(sets)}",
            'let change: BsonDocument = [["$set": set] as BsonDocument]',
        ]
    else:
        item = items["item"]
        if adds:
            if items["by"] == "id":
                result += [f"var {item} = {item}", f"{item}.id = {item}.id ?? Bson.newId()"]
            pushed = _nested_doc([f"{path}: {encoded(items['type'], item, items['nested'])}"])
            main = f'"$push": {pushed}'
        elif items["by"] == "id":
            result.append(f"guard Bson.isObjectId({param}) else {{ return nil }}")
            identified = _nested_doc([f'"_id": try Bson.ofObjectId({param})'])
            main = f'"$pull": {_nested_doc([f"{path}: {identified}"])}'
        else:
            pulled = _nested_doc([f"{path}: {encoded(items['type'], param, items['nested'])}"])
            main = f'"$pull": {pulled}'
        also = []
        if touched:
            also.append(f'"$set": {_nested_doc(touched)}')
        if version:
            also.append(f'"$inc": {_nested_doc([f"{sw_string(version)}: Int32(1)"])}')
        result.append(f"let change: BsonDocument = {_doc([main, *also])}")
    call = f"database.change({sw_string(info['name'])}, documentFilter, change)"
    return [
        *result,
        f"let documentFilter: BsonDocument = {_doc(conditions)}",
        f"return try await write {{ try await {call} }}.map({info['entity']}.from)",
    ]
