"""The Beanie repositories: documents become the project's plain entities, reads leave out documents marked as deleted,
pages go by offset or after a key, a change writes only the fields that are not as they were read (so two people changing
different fields do not undo each other, and the ones the models do not know are kept), and one item of a list is added
or removed in the database. Mirrors web/src/core/generators/python/beanie/repository.ts."""

from ....schema.documents import is_object_id
from ..common.context import is_in, query
from ..common.documents import list_of
from ..common.repositories import identified, memory_fill
from ..python import Imports, py_literal
from .models import document_class, model_class, models_of


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


def _touched_by(info: dict) -> list[dict]:
    return [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]


def beanie_helpers(context: dict, info: dict, imports: Imports) -> list:
    """`_entity` and `_document`: an entity of a document, and the other way round."""
    document = document_class(info)
    entity = info["entity"]
    imports.from_("app.db", "plain").from_("app.models", document)
    loads = _updates(info)
    known: list[str] = []
    if loads:
        imports.from_("app.db", "stored").from_("weakref", "WeakKeyDictionary").from_("typing", "Any")
        fields = " ".join(f"{py_literal(column['column']['name'])}," for column in _changeable(info))
        known = [
            "",
            "",
            f"_LOADED: WeakKeyDictionary[{entity}, dict[str, Any]] = WeakKeyDictionary()",
            '"""What each entity was read as: a change writes only the fields that differ."""',
            "",
            f"_FIELDS = ({fields})",
            '"""The fields a change may write."""',
        ]
    return [
        *known,
        "",
        "",
        f"def _document(entity: {entity}) -> {document}:",
        f'    """The document of a {entity}."""',
        f"    return {document}.model_validate(",
        "        {",
        *(
            f"            {py_literal(column['column']['name'])}: entity.{column['attr']},"
            for column in info["columns"]
        ),
        "        }",
        "    )",
        "",
        "",
        f"def _entity(document: {document}) -> {entity}:",
        f'    """The {entity} of a document; a field it does not have is None."""',
        "    values = plain(document)",
        f"    {'entity =' if loads else 'return'} {entity}(",
        *(
            f"        {column['attr']}=values.get({py_literal(column['column']['name'])}),"
            for column in info["columns"]
        ),
        "    )",
        *(
            [
                "    return _loaded(entity)",
                "",
                "",
                f"def _loaded(entity: {entity}) -> {entity}:",
                '    """The same entity, with what it is stored as kept to tell its changes."""',
                "    _LOADED[entity] = stored(_document(entity))",
                "    return entity",
            ]
            if loads
            else []
        ),
    ]


def _lookup(column: dict, value: str, imports: Imports) -> str:
    """The value a field is looked up with: the identifiers of the database are not texts."""
    if not is_object_id(column["column"]["type"]):
        return value
    imports.from_("bson", "ObjectId")
    return f"ObjectId({value})"


def _filter_of(info: dict, conditions: list[str]) -> str:
    soft = info["soft"]
    marked = []
    if soft:
        value = '{"$ne": True}' if soft["column"]["type"]["kind"] == "boolean" else "None"
        marked = [f"{py_literal(soft['column']['name'])}: {value}"]
    return "{" + ", ".join([*conditions, *marked]) + "}"


def _equal(column: dict, value: str, imports: Imports) -> str:
    return f"{py_literal(column['column']['name'])}: {_lookup(column, value, imports)}"


def _guards(columns: list[dict], empty: str, imports: Imports) -> list:
    """A text that is not an identifier points to nothing."""
    result = []
    for column in columns:
        if is_object_id(column["column"]["type"]):
            imports.from_("bson", "ObjectId")
            result += [f"if not ObjectId.is_valid({column['attr']}):", f"    return {empty}"]
    return result


def _write(info: dict, action: list[str], imports: Imports) -> list:
    """A write, with a refusal of the database turned into a domain error."""
    imports.from_("app.db", "REFUSALS", "refusal")
    return [
        "try:",
        *(f"    {line}" for line in action),
        "except REFUSALS as error:",
        f'    raise refusal("{info["entity"]}", error) from error',
    ]


_SESSION = "session=self._db.session"


def beanie_body(context: dict, info: dict, method: dict, imports: Imports) -> list:
    document = document_class(info)
    imports.from_("app.models", document)
    columns = [
        next(column for column in info["columns"] if column["column"]["name"] == name)
        for name in method["query"]["columns"]
    ]
    kind = method["query"]["kind"]
    order = ", ".join(f"({py_literal(column['column']['name'])}, 1)" for column in info["key"])
    sort = f".sort([{order}])"

    def matching() -> str:
        return _filter_of(info, [_equal(column, column["attr"], imports) for column in columns])

    def by_key() -> str:
        return "{" + ", ".join(_equal(column, f"entity.{column['attr']}", imports) for column in info["key"]) + "}"

    if kind in ("getByKey", "findByUnique"):
        return [
            *_guards(columns, "None", imports),
            f"document = await {document}.find_one({matching()}, {_SESSION})",
            "return None if document is None else _entity(document)",
        ]
    if kind in ("listByParent", "findAllBy"):
        return [
            *_guards(columns, "[]", imports),
            f"return [_entity(document) for document in await {document}.find({matching()}, {_SESSION}){sort}.to_list()]",
        ]
    if kind == "list":
        all_ = _filter_of(info, [])
        paging = context["settings"]["paging"]
        if paging == "offset":
            return [
                f"documents = await {document}.find({all_}, {_SESSION}){sort}.skip(offset).limit(limit).to_list()",
                f"total = await {document}.find({all_}, {_SESSION}).count()",
                "return Page(items=[_entity(document) for document in documents], total=total, offset=offset, limit=limit)",
            ]
        if paging == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            after = []
            for index, column in enumerate(info["key"]):
                same = [
                    _equal(before, f"after[{position}]", imports) for position, before in enumerate(info["key"][:index])
                ]
                greater = f'{{"$gt": {_lookup(column, f"after[{index}]", imports)}}}'
                after.append("{" + ", ".join([*same, f"{py_literal(column['column']['name'])}: {greater}"]) + "}")
            last = ", ".join(f"items[-1].{column['attr']}" for column in info["key"])
            return [
                f"conditions: dict[str, Any] = {all_}",
                "if after is not None:",
                f"    conditions |= {after[0]}" if len(after) == 1 else f'    conditions["$or"] = [{", ".join(after)}]',
                f"documents = await {document}.find(conditions, {_SESSION}){sort}.limit(limit + 1).to_list()",
                "items = [_entity(document) for document in documents[:limit]]",
                f"return CursorPage(items=items, next=({last},) if len(documents) > limit else None)",
            ]
        return [f"return [_entity(document) for document in await {document}.find({all_}, {_SESSION}){sort}.to_list()]"]
    if kind == "insert":
        # MongoDB fills nothing but the identifier
        fills = [
            memory_fill(context, column, imports) for column in info["columns"] if column["column"]["name"] != "_id"
        ]
        key = info["key"][0]
        return [
            *(line for line in fills if line is not None),
            *identified(info, imports),
            *_write(info, ["document = _document(entity)", f"await document.insert({_SESSION})"], imports),
            *([f"entity.{key['attr']} = str(document.id)"] if is_object_id(key["column"]["type"]) else []),
            f"return {'_loaded(entity)' if _updates(info) else 'entity'}",
        ]
    if kind == "update":
        if not _updates(info):
            return ["# Nothing of it can change but its key", "return entity"]
        imports.from_("app.db", "changes", "stored")
        touched = _touched_by(info)
        if touched:
            imports.from_("datetime", "UTC", "datetime")
        times = []
        for column in touched:
            times += [
                f"    entity.{column['attr']} = datetime.now(UTC)",
                f'    change.setdefault("$set", {{}})[{py_literal(column["column"]["name"])}] = entity.{column["attr"]}',
            ]
        return [
            *identified(info, imports),
            *_write(
                info,
                [
                    "change = changes(_LOADED.get(entity, {}), stored(_document(entity)), _FIELDS)",
                    "if change:",
                    *times,
                    f"    await {document}.find_one({by_key()}).update(change, {_SESSION})",
                ],
                imports,
            ),
            "return _loaded(entity)",
        ]
    if kind == "delete":
        return _write(info, [f"await {document}.find_one({by_key()}).delete({_SESSION})"], imports)
    if kind in ("addItem", "removeItem"):
        return _item_body(info, method, imports)
    return ["raise NotImplementedError"]


def _item_body(info: dict, method: dict, imports: Imports) -> list:
    """One item of a list added or removed in the database, whatever the rest of the list is by then."""
    document = document_class(info)
    items = list_of(info, method["query"])
    name = items["column"]["column"]["name"]
    path = py_literal(name)
    item, by = items["item"], items["by"]
    adds = method["query"]["kind"] == "addItem"
    touched = [f"{py_literal(column['column']['name'])}: datetime.now(UTC)" for column in _touched_by(info)]
    if touched:
        imports.from_("datetime", "UTC", "datetime")
    imports.from_("beanie", "UpdateResponse")
    version = info["version"]["column"]["name"] if info["version"] else None
    conditions = [_equal(column, column["attr"], imports) for column in info["key"]]
    nested = models_of(info).get(name)

    def stored(value: str) -> str:
        """An item as the list keeps it"""
        if nested and items["type"]["kind"] == "json":
            imports.from_("app.db", "stored").from_("app.models", model_class(nested))
            return f"stored({model_class(nested)}.model_validate({value}))"
        if is_object_id(items["type"]):
            imports.from_("bson", "ObjectId")
            return f"ObjectId({value})"
        return value

    before = _guards(info["key"], "None", imports)
    if not adds and by == "position":
        # MongoDB removes by position only by writing the list without it; the size says it is still the list that was
        # seen
        conditions.append(f'{path}: {{"$size": size}}')
        kept = py_literal(f"${name}")
        values = [
            f'{path}: {{"$concatArrays": [{{"$slice": [{kept}, position]}}, {{"$slice": [{kept}, position + 1, size]}}]}}',
            *touched,
        ]
        if version:
            values.append(f'{py_literal(version)}: {{"$add": [{py_literal(f"${version}")}, 1]}}')
        change = f'[{{"$set": {{{", ".join(values)}}}}}]'
    else:
        if adds:
            if by == "id":
                imports.from_("app.documents", "identify")
                before.append(f"identify([{item}])")
            action = f'"$push": {{{path}: {stored(item)}}}'
        elif by == "id":
            imports.from_("bson", "ObjectId")
            before += [f"if not ObjectId.is_valid({item}_id):", "    return None"]
            action = f'"$pull": {{{path}: {{"_id": ObjectId({item}_id)}}}}'
        else:
            action = f'"$pull": {{{path}: {stored(item)}}}'
        parts = [action]
        if touched:
            parts.append(f'"$set": {{{", ".join(touched)}}}')
        if version:
            parts.append(f'"$inc": {{{py_literal(version)}: 1}}')
        change = "{" + ", ".join(parts) + "}"
    return [
        *before,
        *_write(
            info,
            [
                f"document = await {document}.find_one({_filter_of(info, conditions)}).update(",
                f"    {change},",
                f"    {_SESSION},",
                "    response_type=UpdateResponse.NEW_DOCUMENT,",
                ")",
            ],
            imports,
        ),
        "return None if document is None else _entity(document)",
    ]
