"""The database repositories over a MongoTemplate: reads leave out documents marked as deleted, a change writes only the
fields that are not as they were read (so two people changing different fields do not undo each other, and the ones the
entity does not know are kept), and one item of a list is added or removed in the database. Mirrors
web/src/core/generators/java/springdata/repository.ts."""

from ....schema.documents import is_object_id
from ..context import column_of, is_in, query, sql_repository_class
from ..documents import identified_lists, list_of
from ..java import JavaImports, java_string
from ..repositories import memory_fill

CORE = "org.springframework.data.mongodb.core"


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


def _criteria(conditions: list[tuple[str, str]], imports: JavaImports) -> str:
    """`Criteria.where("a").is(a).and("b").is(b)`, with the condition that leaves out documents marked as deleted."""
    imports.add(f"{CORE}.query.Criteria", f"{CORE}.query.Query")
    if not conditions:
        return "new Query()"
    (path, test), *others = conditions
    rest = "".join(f".and({java_string(other)}){other_test}" for other, other_test in others)
    return f"Query.query(Criteria.where({java_string(path)}){test}{rest})"


def _soft_condition(info: dict) -> list[tuple[str, str]]:
    soft = info["soft"]
    if not soft:
        return []
    return [(soft["prop"], ".ne(true)" if soft["column"]["type"]["kind"] == "boolean" else ".is(null)")]


def _equal(column: dict, value: str) -> tuple[str, str]:
    return column["prop"], f".is({value})"


def _write(context: dict, info: dict, action: list[str], imports: JavaImports) -> list[str]:
    """A write, with a refusal of the database turned into a ConflictException."""
    imports.add("org.springframework.dao.DataAccessException", f"{context['base']}.Documents")
    return [
        "try {",
        *(f"    {line}" for line in action),
        "} catch (DataAccessException error) {",
        f'    throw Documents.refusal("{info["entity"]}", error);',
        "}",
    ]


def head(context: dict, info: dict, imports: JavaImports) -> list:
    imports.add(f"{CORE}.MongoTemplate")
    known: list[str] = []
    if _updates(info):
        imports.add(
            "java.util.Collections", "java.util.List", "java.util.Map", "java.util.WeakHashMap", "org.bson.Document"
        )
        fields = ", ".join(java_string(column["column"]["name"]) for column in _changeable(info))
        known = [
            "    /** The document each entity was read from: a change writes only the fields that differ */",
            f"    private static final Map<{info['entity']}, Document> LOADED = Collections.synchronizedMap(new WeakHashMap<>());",
            "",
            "    /** The fields a change may write */",
            f"    private static final List<String> FIELDS = List.of({fields});",
            "",
        ]
    return [
        *known,
        "    private final MongoTemplate mongo;",
        "",
        f"    public {sql_repository_class(info)}(MongoTemplate mongo) {{",
        "        this.mongo = mongo;",
        "    }",
    ]


def _loaded(info: dict, expression: str) -> str:
    return f"loaded({expression})" if _updates(info) else expression


def _each_loaded(info: dict, expression: str) -> str:
    return f"{expression}.stream().map(this::loaded).toList()" if _updates(info) else expression


def body(context: dict, info: dict, method: dict, imports: JavaImports) -> list:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(info)
    entity = info["entity"]
    type_ = f"{entity}.class"
    key = info["key"][0]
    kind = method["query"]["kind"]

    def sorted_() -> str:
        imports.add("org.springframework.data.domain.Sort")
        return f".with(Sort.by({', '.join(java_string(column['prop']) for column in info['key'])}))"

    def matching() -> str:
        return _criteria([*(_equal(column, column["prop"]) for column in columns), *soft], imports)

    if kind in ("getByKey", "findByUnique"):
        found = "found == null ? null : loaded(found)" if _updates(info) else "found"
        return [
            f"{entity} found = mongo.findOne({matching()}, {type_});",
            f"return Optional.ofNullable({found});",
        ]
    if kind in ("listByParent", "findAllBy"):
        rows = f"mongo.find({matching()}{sorted_()}, {type_})"
        return [f"return {_each_loaded(info, rows)};"]
    if kind == "list":
        all_ = _criteria(soft, imports)
        if context["settings"]["paging"] == "offset":
            imports.add("java.util.List")
            rows = f"mongo.find({all_}{sorted_()}.skip(offset).limit(limit), {type_})"
            return [
                f"List<{entity}> items = {_each_loaded(info, rows)};",
                f"return new Page<>(items, mongo.count({all_}, {type_}), offset, limit);",
            ]
        if context["settings"]["paging"] == "cursor":
            return [
                f"Query query = {all_}{sorted_()}.limit(limit + 1);",
                f"if (after != null) query.addCriteria(Criteria.where({java_string(key['prop'])}).gt(after.get(0)));",
                f"List<{entity}> rows = {_each_loaded(info, f'mongo.find(query, {type_})')};",
                f"List<{entity}> items = rows.stream().limit(limit).toList();",
                f"return new CursorPage<>(items, rows.size() > limit ? List.of(items.get(items.size() - 1).{key['getter']}()) : null);",
            ]
        return [f"return {_each_loaded(info, f'mongo.find({all_}{sorted_()}, {type_})')};"]
    if kind == "insert":
        # MongoDB fills nothing but the identifier
        fills = []
        for column in info["columns"]:
            if column["column"]["name"] == "_id":
                continue
            fill = memory_fill(column, imports)
            if fill is None:
                continue
            if column["javaImport"]:
                imports.add(column["javaImport"])
            fills.append(fill)
        return [
            *fills,
            *(["entity.identifyItems();"] if identified_lists(info) else []),
            *_write(context, info, ["mongo.insert(entity);"], imports),
            f"return {_loaded(info, 'entity')};",
        ]
    if kind == "update":
        if not _updates(info):
            return ["// Nothing of it can change but its key", "return entity;"]
        imports.add(f"{context['base']}.Documents", "com.mongodb.client.model.Filters")
        touched = _touched(info)
        for column in touched:
            if column["javaImport"]:
                imports.add(column["javaImport"])
        also = [java_string(column["column"]["name"]) for column in touched]
        return [
            *(f"entity.{column['setter']}({column['java']}.now());" for column in touched),
            *(["entity.identifyItems();"] if identified_lists(info) else []),
            "Document now = Documents.of(mongo, entity);",
            "Document changes = Documents.changes(LOADED.get(entity), now, FIELDS);",
            *(
                [
                    f'if (!changes.isEmpty()) ((Document) changes.computeIfAbsent("$set", (name) -> new Document())).append({also[0]}, now.get({also[0]}));'
                ]
                if also
                else []
            ),
            *_write(
                context,
                info,
                [
                    f'if (!changes.isEmpty()) mongo.execute({type_}, (collection) -> collection.updateOne(Filters.eq("_id", now.get("_id")), changes));'
                ],
                imports,
            ),
            "return loaded(entity);",
        ]
    if kind == "delete":
        by_key = _criteria([_equal(key, f"entity.{key['getter']}()")], imports)
        return _write(context, info, [f"mongo.remove({by_key}, {type_});"], imports)
    if kind in ("addItem", "removeItem"):
        return _item_body(context, info, method, imports)
    return ["throw new UnsupportedOperationException();"]


def _item_body(context: dict, info: dict, method: dict, imports: JavaImports) -> list[str]:
    """One item of a list added or removed in the database, whatever the rest of the list is by then."""
    items = list_of(info, method["query"])
    key = info["key"][0]
    stored_name = items["column"]["column"]["name"]
    path = java_string(stored_name)
    object_key = is_object_id(key["column"]["type"])
    adds = method["query"]["kind"] == "addItem"
    item, by, param = items["item"], items["by"], items["params"][0]["name"]
    imports.add(
        "org.bson.Document",
        "com.mongodb.client.model.FindOneAndUpdateOptions",
        "com.mongodb.client.model.ReturnDocument",
        "java.util.Optional",
    )
    if object_key or by == "id":
        imports.add("org.bson.types.ObjectId")
    touched = "".join(
        f".append({java_string(column['column']['name'])}, new java.util.Date())" for column in _touched(info)
    )
    key_value = f"new ObjectId({key['prop']})" if object_key else key["prop"]
    filter_ = f'new Document("_id", {key_value})'
    soft, version = info["soft"], info["version"]
    if soft:
        unmarked = 'new Document("$ne", true)' if soft["column"]["type"]["kind"] == "boolean" else "null"
        filter_ += f".append({java_string(soft['column']['name'])}, {unmarked})"
    result = [f"if (!ObjectId.isValid({key['prop']})) return Optional.empty();"] if object_key else []
    if not adds and by == "position":
        # MongoDB removes by position only by writing the list without it; the size says it is still the list that was
        # seen
        filter_ += f'.append({path}, new Document("$size", size))'
        imports.add("java.util.List")
        stored = java_string(f"${stored_name}")
        result += [
            f'Document head = new Document("$slice", List.of({stored}, position));',
            f'Document tail = new Document("$slice", List.of({stored}, position + 1, Math.max(size, 1)));',
        ]
        next_version = ""
        if version:
            name = version["column"]["name"]
            next_version = f'.append({java_string(name)}, new Document("$add", List.of({java_string("$" + name)}, 1)))'
        result.append(
            f'List<Document> change = List.of(new Document("$set", new Document({path}, new Document("$concatArrays", List.of(head, tail))){touched}{next_version}));'
        )
    else:
        also = f'.append("$set", new Document(){touched})' if touched else ""
        if version:
            also += f'.append("$inc", new Document({java_string(version["column"]["name"])}, 1))'
        if adds:
            if by == "id":
                result.append(f"if ({item}.getId() == null) {item}.setId(new ObjectId().toHexString());")
            change = f'"$push", new Document({path}, {_stored_item(context, items, item, imports)})'
        elif by == "id":
            result.append(f"if (!ObjectId.isValid({param})) return Optional.empty();")
            change = f'"$pull", new Document({path}, new Document("_id", new ObjectId({param})))'
        else:
            change = f'"$pull", new Document({path}, {_stored_item(context, items, param, imports)})'
        result.append(f"Document change = new Document({change}){also};")
    read = f"mongo.getConverter().read({info['entity']}.class, document)"
    result += [
        f"Document filter = {filter_};",
        "FindOneAndUpdateOptions after = new FindOneAndUpdateOptions().returnDocument(ReturnDocument.AFTER);",
        "Document changed;",
        *_write(
            context,
            info,
            [
                f"changed = mongo.execute({info['entity']}.class, (collection) -> collection.findOneAndUpdate(filter, change, after));"
            ],
            imports,
        ),
        f"return Optional.ofNullable(changed).map((document) -> {_loaded(info, read)});",
    ]
    return result


def _stored_item(context: dict, items: dict, value: str, imports: JavaImports) -> str:
    """An item as the list keeps it."""
    if items["nested"] and items["type"]["kind"] == "json":
        imports.add(f"{context['base']}.Documents")
        return f"Documents.of(mongo, {value})"
    if is_object_id(items["type"]):
        imports.add("org.bson.types.ObjectId")
        return f"new ObjectId({value})"
    if items["type"]["kind"] == "decimal":
        return f"new org.bson.types.Decimal128({value})"
    return f"mongo.getConverter().convertToMongoType({value})"


def tail(context: dict, info: dict, imports: JavaImports) -> list:
    if not _updates(info):
        return []
    imports.add(f"{context['base']}.Documents")
    return [
        "",
        "    /** The same entity, with what it is stored as kept to tell its changes. */",
        f"    private {info['entity']} loaded({info['entity']} entity) {{",
        "        LOADED.put(entity, Documents.of(mongo, entity));",
        "        return entity;",
        "    }",
    ]
