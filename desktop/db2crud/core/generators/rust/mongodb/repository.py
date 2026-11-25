"""The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
are not as they were read (so two people changing different fields do not undo each other, and the ones the entity does
not know are kept), and one item of a list is added or removed in the database. Mirrors
web/src/core/generators/rust/mongodb/repository.ts."""

from ....schema.documents import is_object_id
from ..context import column_of, is_in, stored
from ..documents import identified_lists, list_of
from ..repositories import memory_fill
from ..rust import RsUses, rs_string
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
    """`"_id": of_object_id(&id)?`"""
    return f"{rs_string(column['column']['name'])}: {encoded(column['column']['type'], value)}"


def _soft_condition(info: dict) -> list[str]:
    soft = info["soft"]
    if not soft:
        return []
    boolean = soft["column"]["type"]["kind"] == "boolean"
    kept = '{ "$ne": true }' if boolean else "null"
    return [f"{rs_string(soft['column']['name'])}: {kept}"]


def _doc(conditions: list[str]) -> str:
    return f"doc! {{ {', '.join(conditions)} }}" if conditions else "doc! {}"


def _guards(columns: list[dict], nothing: str) -> list[str]:
    """What a text that is not an identifier finds."""
    result = []
    for column in columns:
        if is_object_id(column["column"]["type"]):
            result += [f"if !bson_values::is_object_id(&{column['field']}) {{", f"    return Ok({nothing});", "}"]
    return result


def body(context: dict, info: dict, method: dict, uses: RsUses) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    key = info["key"][0]
    key_name = rs_string(key["column"]["name"])
    sort = f"doc! {{ {key_name}: 1 }}"
    soft = _soft_condition(info)
    collection = rs_string(info["name"])
    entity = rs_string(info["entity"])

    def given() -> str:
        return _doc([*(_equal(column, column["field"]) for column in columns), *soft])

    def values() -> None:
        uses.add("crate::bson_values", "mongodb::bson::doc")

    def entities(documents: str) -> str:
        return f"{documents}.iter().map({info['entity']}::from_document).collect::<Result<_, _>>()?"

    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        values()
        return [
            *_guards(columns, "None"),
            f"let found = self.db.find_one({collection}, {given()}).await?;",
            f"Ok(found.as_ref().map({info['entity']}::from_document).transpose()?)",
        ]
    if kind in ("listByParent", "findAllBy"):
        values()
        return [
            *_guards(columns, "Vec::new()"),
            f"let found = self.db.find({collection}, {given()}, {sort}, 0, 0).await?;",
            f"Ok({entities('found')})",
        ]
    if kind == "list":
        uses.add("mongodb::bson::doc")
        paging = context["settings"]["paging"]
        if paging == "offset":
            return [
                f"let total = self.db.count({collection}, {_doc(soft)}).await?;",
                "let found = if limit > 0 {",
                f"    self.db.find({collection}, {_doc(soft)}, {sort}, offset, limit).await?",
                "} else {",
                "    Vec::new()",
                "};",
                f"Ok(Page {{ items: {entities('found')}, total, offset, limit }})",
            ]
        if paging == "cursor":
            values()
            last = stored(f"last.{key['field']}", key)
            return [
                f"let mut filter = {_doc(soft)};",
                "if let Some(after) = after {",
                f'    filter.insert({key_name}, doc! {{ "$gt": {encoded(key["column"]["type"], "after")} }});',
                "}",
                f"let found = self.db.find({collection}, filter, {sort}, 0, limit + 1).await?;",
                f"let mut items: Vec<{info['entity']}> = {entities('found')};",
                "let more = items.len() as u64 > limit;",
                "items.truncate(limit as usize);",
                f"let next = if more {{ items.last().map(|last| {last}) }} else {{ None }};",
                "Ok(CursorPage { items, next })",
            ]
        return [
            f"let found = self.db.find({collection}, {_doc(soft)}, {sort}, 0, 0).await?;",
            f"Ok({entities('found')})",
        ]
    if kind == "insert":
        uses.add("crate::bson_values::Loaded")
        fills = [memory_fill(column) for column in info["columns"]]
        return [
            "let mut entity = entity;",
            # MongoDB fills nothing but the identifier
            *(line for line in fills if line is not None),
            *(["entity.identify_items();"] if identified_lists(info) else []),
            "let document = entity.to_document()?;",
            f"self.db.insert({entity}, {collection}, &document).await?;",
            "entity.loaded = Loaded(Some(document));",
            "Ok(entity)",
        ]
    if kind == "update":
        changeable = _changeable(info)
        if not changeable:
            return ["// Nothing of it can change but its key", "Ok(entity)"]
        values()
        uses.add("crate::bson_values::Loaded")
        fields = ", ".join(rs_string(column["column"]["name"]) for column in changeable)
        touched = _touched(info)
        stamps = [rs_string(column["column"]["name"]) for column in touched]
        mutable = "mut " if touched else ""
        return [
            "let mut entity = entity;",
            *(f"entity.{column['field']} = Some(chrono::Utc::now());" for column in touched),
            *(["entity.identify_items();"] if identified_lists(info) else []),
            "let now = entity.to_document()?;",
            f"let {mutable}changes = bson_values::changes(entity.loaded.0.as_ref(), &now, &[{fields}]);",
            "if !changes.is_empty() {",
            *(f"    bson_values::also_set(&mut changes, &now, {name});" for name in stamps),
            f'    self.db.update({entity}, {collection}, doc! {{ "_id": now.get("_id").cloned() }}, changes).await?;',
            "}",
            "entity.loaded = Loaded(Some(now));",
            "Ok(entity)",
        ]
    if kind == "delete":
        values()
        return [
            f"let {key['field']} = {stored('entity.' + key['field'], key)};",
            f"self.db.delete({entity}, {collection}, {_doc([_equal(key, key['field'])])}).await",
        ]
    if kind in ("addItem", "removeItem"):
        values()
        return _item_body(info, method)
    return ["unimplemented!()"]


def _item_body(info: dict, method: dict) -> list[str]:
    """One item of a list added or removed in the database, whatever the rest of the list is by then."""
    items = list_of(info, method["query"])
    key = info["key"][0]
    param = items["params"][0]["name"]
    stored_name = items["column"]["column"]["name"]
    path = rs_string(stored_name)
    touched = [f"{rs_string(column['column']['name'])}: mongodb::bson::DateTime::now()" for column in _touched(info)]
    version = info["version"]["column"]["name"] if info["version"] else None
    conditions = [_equal(key, key["field"]), *_soft_condition(info)]
    result = _guards([key], "None")
    adds = method["query"]["kind"] == "addItem"
    if not adds and items["by"] == "position":
        # MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
        conditions.append(f'{path}: {{ "$size": size as i64 }}')
        kept = rs_string(f"${stored_name}")
        sets = [f'{path}: {{ "$concatArrays": [head, tail] }}', *touched]
        if version:
            sets.append(f'{rs_string(version)}: {{ "$add": [{rs_string("$" + version)}, 1] }}')
        result += [
            f'let head = doc! {{ "$slice": [{kept}, position as i64] }};',
            f'let tail = doc! {{ "$slice": [{kept}, position as i64 + 1, size.max(1) as i64] }};',
            f'let change = vec![doc! {{ "$set": {{ {", ".join(sets)} }} }}];',
        ]
    else:
        item = items["item"]
        if adds:
            if items["by"] == "id":
                result += [
                    f"let mut {item} = {item};",
                    f"{item}.id = {item}.id.or_else(|| Some(mongodb::bson::oid::ObjectId::new().to_hex()));",
                ]
            main = f'"$push": {{ {path}: {encoded(items["type"], item, items["nested"])} }}'
        elif items["by"] == "id":
            result += [f"if !bson_values::is_object_id(&{param}) {{", "    return Ok(None);", "}"]
            main = f'"$pull": {{ {path}: {{ "_id": bson_values::of_object_id(&{param})? }} }}'
        else:
            main = f'"$pull": {{ {path}: {encoded(items["type"], param, items["nested"])} }}'
        also = []
        if touched:
            also.append(f'"$set": {{ {", ".join(touched)} }}')
        if version:
            also.append(f'"$inc": {{ {rs_string(version)}: 1 }}')
        result.append(f"let change = {_doc([main, *also])};")
    names = f"{rs_string(info['entity'])}, {rs_string(info['name'])}"
    return [
        *result,
        f"let changed = self.db.change({names}, {_doc(conditions)}, change).await?;",
        f"Ok(changed.as_ref().map({info['entity']}::from_document).transpose()?)",
    ]
