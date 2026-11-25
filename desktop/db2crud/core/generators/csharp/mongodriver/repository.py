"""The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
are not as they were read (so two people changing different fields do not undo each other, and the ones the entity does
not know are kept), and one item of a list is added or removed in the database. Mirrors
web/src/core/generators/csharp/mongodriver/repository.ts."""

from ....schema.documents import is_object_id
from ..context import column_of, is_in, query
from ..csharp import CsUsings, cs_string
from ..documents import identified_lists, list_of
from ..repositories import memory_fill


def _changeable(info: dict) -> list[dict]:
    return [
        column
        for column in info["columns"]
        if not is_in(column, info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    ]


def _updates(info: dict) -> bool:
    return query(info, "update") is not None and bool(_changeable(info))


def _touched(info: dict) -> list[dict]:
    """The columns that take the time of each change."""
    return [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]


def _builder(info: dict) -> str:
    return f"Builders<{info['entity']}>"


def _equal(column: dict, value: str) -> str:
    return f"Filter.Eq(row => row.{column['prop']}, {value})"


def _soft_condition(info: dict) -> list[str]:
    soft = info["soft"]
    if not soft:
        return []
    if soft["column"]["type"]["kind"] == "boolean":
        return [f"Filter.Ne(row => row.{soft['prop']}, true)"]
    return [f"Filter.Eq(row => row.{soft['prop']}, null)"]


def _filter(info: dict, conditions: list[str]) -> str:
    """`Builders<Order>.Filter.And(…)` of some conditions."""
    every = [f"{_builder(info)}.{item}" for item in conditions]
    if not every:
        return f"{_builder(info)}.Filter.Empty"
    return every[0] if len(every) == 1 else f"{_builder(info)}.Filter.And({', '.join(every)})"


def _guards(columns: list[dict], nothing: str) -> list[str]:
    """What a text that is not an identifier finds."""
    return [
        f"if (!ObjectId.TryParse({column['local']}, out _)) return {nothing};"
        for column in columns
        if is_object_id(column["column"]["type"])
    ]


def _find(info: dict, conditions: list[str]) -> str:
    return f"db.Find(Collection, {_filter(info, conditions)})"


def _sort(info: dict) -> str:
    return f".Sort({_builder(info)}.Sort.Ascending(row => row.{info['key'][0]['prop']}))"


def head(_context: dict, info: dict) -> list:
    result = [f"    private const string Collection = {cs_string(info['name'])};"]
    if _updates(info):
        fields = ", ".join(cs_string(column["column"]["name"]) for column in _changeable(info))
        result += [
            "",
            "    /// <summary>The document each entity was read from: a change writes only the fields that differ</summary>",
            f"    private static readonly ConditionalWeakTable<{info['entity']}, BsonDocument> Read = [];",
            "",
            "    /// <summary>The fields a change may write</summary>",
            f"    private static readonly string[] Fields = [{fields}];",
        ]
    return result


def _loaded(info: dict, expression: str) -> str:
    return f"Loaded({expression})" if _updates(info) else expression


def _each_loaded(info: dict, expression: str) -> str:
    return f"({expression}).Select(Loaded).ToList()" if _updates(info) else expression


def body(context: dict, info: dict, method: dict, usings: CsUsings) -> list:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(info)
    key = info["key"][0]
    entity = cs_string(info["entity"])
    updates = _updates(info)
    if updates:
        usings.add("System.Runtime.CompilerServices")
    kind = method["query"]["kind"]
    conditions = [*(_equal(column, column["local"]) for column in columns), *soft]
    if kind in ("getByKey", "findByUnique"):
        return [
            *_guards(columns, "null"),
            f"var found = await {_find(info, conditions)}.FirstOrDefaultAsync();",
            f"return {'found is null ? null : Loaded(found)' if updates else 'found'};",
        ]
    if kind in ("listByParent", "findAllBy"):
        found = _each_loaded(info, f"await {_find(info, conditions)}{_sort(info)}.ToListAsync()")
        return [*_guards(columns, "[]"), f"return {found};"]
    if kind == "list":
        paging = context["settings"]["paging"]
        if paging == "offset":
            found = _each_loaded(
                info, f"await {_find(info, soft)}{_sort(info)}.Skip(offset).Limit(limit).ToListAsync()"
            )
            count = f"await db.CountAsync(Collection, {_filter(info, soft)})"
            return [f"var items = {found};", f"return new Page<{info['entity']}>(items, {count}, offset, limit);"]
        if paging == "cursor":
            after = f"{_builder(info)}.Filter.Gt(row => row.{key['prop']}, ({key['cs']})after[0])"
            found = _each_loaded(info, f"await db.Find(Collection, filter){_sort(info)}.Limit(limit + 1).ToListAsync()")
            return [
                f"var filter = {_filter(info, soft)};",
                f"if (after is not null) filter &= {after};",
                f"var rows = {found};",
                "var items = rows.Take(limit).ToList();",
                f"return new CursorPage<{info['entity']}>(items, rows.Count > limit ? [items[^1].{key['prop']}] : null);",
            ]
        return [f"return {_each_loaded(info, f'await {_find(info, soft)}{_sort(info)}.ToListAsync()')};"]
    identify = ["entity.IdentifyItems();"] if identified_lists(info) else []
    if kind == "insert":
        # MongoDB fills nothing but the identifier
        fills = [memory_fill(context, info, column) for column in info["columns"]]
        return [
            *(line for line in fills if line is not None),
            *identify,
            f"await db.InsertAsync({entity}, Collection, entity);",
            f"return {_loaded(info, 'entity')};",
        ]
    if kind == "update":
        if not updates:
            return ["// Nothing of it can change but its key", "await Task.CompletedTask;", "return entity;"]
        touched = _touched(info)
        names = [cs_string(column["column"]["name"]) for column in touched]
        change = f'await db.UpdateAsync<{info["entity"]}>({entity}, Collection, new BsonDocument("_id", now["_id"]), changes);'
        return [
            *(f"entity.{column['prop']} = DateTime.UtcNow;" for column in touched),
            *identify,
            "var now = entity.ToBsonDocument();",
            "var changes = Documents.Changes(Read.TryGetValue(entity, out var before) ? before : null, now, Fields);",
            *(
                [
                    "if (changes.ElementCount > 0)",
                    "{",
                    '    if (!changes.Contains("$set")) changes["$set"] = new BsonDocument();',
                    *(f'    changes["$set"][{name}] = now[{name}];' for name in names),
                    "}",
                ]
                if touched
                else []
            ),
            f"if (changes.ElementCount > 0) {change}",
            "return Loaded(entity);",
        ]
    if kind == "delete":
        condition = _filter(info, [_equal(key, f"entity.{key['prop']}")])
        return [f"await db.DeleteAsync({entity}, Collection, {condition});"]
    if kind in ("addItem", "removeItem"):
        return _item_body(info, method)
    return ["throw new NotSupportedException();"]


def _stored_value(column_type: dict, value: str) -> str:
    kind = column_type["kind"]
    if is_object_id(column_type):
        return f"new ObjectId({value})"
    if kind == "decimal":
        return f"new BsonDecimal128({value})"
    if kind == "uuid":
        return f"new BsonBinaryData({value}, GuidRepresentation.Standard)"
    if kind in ("json", "unknown"):
        return value
    return f"BsonValue.Create({value})"


def _stored_item(items: dict, value: str) -> str:
    """An item as the list keeps it."""
    if items["nested"] and items["type"]["kind"] == "json":
        return f"{value}.ToBsonDocument()"
    return _stored_value(items["type"], value)


def _item_body(info: dict, method: dict) -> list[str]:
    """One item of a list added or removed in the database, whatever the rest of the list is by then."""
    items = list_of(info, method["query"])
    key = info["key"][0]
    param = items["params"][0]
    stored_name = items["column"]["column"]["name"]
    path = cs_string(stored_name)
    touched = [cs_string(column["column"]["name"]) for column in _touched(info)]
    conditions = [f'["_id"] = {_stored_value(key["column"]["type"], key["local"])}']
    soft = info["soft"]
    if soft:
        boolean = soft["column"]["type"]["kind"] == "boolean"
        kept = 'new BsonDocument("$ne", true)' if boolean else "BsonNull.Value"
        conditions.append(f"[{cs_string(soft['column']['name'])}] = {kept}")
    result = _guards([key], "null")
    version = info["version"]["column"]["name"] if info["version"] else None
    adds = method["query"]["kind"] == "addItem"
    if not adds and items["by"] == "position":
        # MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
        conditions.append(f'[{path}] = new BsonDocument("$size", size)')
        stored = cs_string("$" + stored_name)
        sets = [
            f'[{path}] = new BsonDocument("$concatArrays", new BsonArray {{ head, tail }})',
            *(f"[{name}] = DateTime.UtcNow" for name in touched),
        ]
        if version:
            sets.append(
                f'[{cs_string(version)}] = new BsonDocument("$add", new BsonArray {{ {cs_string("$" + version)}, 1 }})'
            )
        result += [
            f'var head = new BsonDocument("$slice", new BsonArray {{ {stored}, position }});',
            f'var tail = new BsonDocument("$slice", new BsonArray {{ {stored}, position + 1, Math.Max(size, 1) }});',
            f'BsonDocument[] change = [new("$set", new BsonDocument {{ {", ".join(sets)} }})];',
        ]
    else:
        also = []
        if touched:
            sets = ", ".join(f"[{name}] = DateTime.UtcNow" for name in touched)
            also.append(f'["$set"] = new BsonDocument {{ {sets} }}')
        if version:
            also.append(f'["$inc"] = new BsonDocument({cs_string(version)}, 1)')
        if adds:
            if items["by"] == "id":
                result.append(f"{items['item']}.Id ??= ObjectId.GenerateNewId().ToString();")
            main = f'["$push"] = new BsonDocument({path}, {_stored_item(items, items["item"])})'
        elif items["by"] == "id":
            result.append(f"if (!ObjectId.TryParse({param['name']}, out _)) return null;")
            main = f'["$pull"] = new BsonDocument({path}, new BsonDocument("_id", new ObjectId({param["name"]})))'
        else:
            main = f'["$pull"] = new BsonDocument({path}, {_stored_item(items, param["name"])})'
        result.append(f"var change = new BsonDocument {{ {', '.join([main, *also])} }};")
    call = f"db.ChangeAsync<{info['entity']}>({cs_string(info['entity'])}, Collection, filter, change)"
    return [
        *result,
        f"var filter = new BsonDocument {{ {', '.join(conditions)} }};",
        f"var changed = await {call};",
        f"return {'changed is null ? null : Loaded(changed)' if _updates(info) else 'changed'};",
    ]


def tail(_context: dict, info: dict, _usings: CsUsings) -> list:
    if not _updates(info):
        return []
    return [
        "",
        "    /// <summary>The same entity, with what it is stored as kept to tell its changes.</summary>",
        f"    private static {info['entity']} Loaded({info['entity']} entity)",
        "    {",
        "        Read.AddOrUpdate(entity, entity.ToBsonDocument());",
        "        return entity;",
        "    }",
    ]
