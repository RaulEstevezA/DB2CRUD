"""The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
are not as they were read (so two people changing different fields do not undo each other, and the ones the entity does
not know are kept), and one item of a list is added or removed in the database. Mirrors
web/src/core/generators/php/mongodb/repository.ts."""

from ....schema.documents import is_object_id
from ..common.context import column_of, is_in, query
from ..common.documents import identified_lists, list_of
from ..common.php import PhpUses, access, php_string
from ..common.repositories import memory_fill
from .shapes import shape_lines, stored


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


def _equal(column: dict, value: str) -> str:
    return f"{php_string(column['column']['name'])} => {stored(column['column']['type'], value)}"


def _soft_condition(info: dict) -> list[str]:
    soft = info["soft"]
    if not soft:
        return []
    kept = "['$ne' => true]" if soft["column"]["type"]["kind"] == "boolean" else "null"
    return [f"{php_string(soft['column']['name'])} => {kept}"]


def _filter(conditions: list[str]) -> str:
    return f"[{', '.join(conditions)}]"


def _guards(columns: list[dict], nothing: str) -> list[str]:
    """What a text that is not an identifier finds."""
    result = []
    for column in columns:
        if is_object_id(column["column"]["type"]):
            result += [f"if (!Documents::isId(${column['field']})) {{", f"    return {nothing};", "}"]
    return result


def init(context: dict, info: dict, uses: PhpUses) -> list:
    uses.add(f"{context['base']}\\Db", f"{context['base']}\\Documents")
    result = [
        "    /** What each field is in MongoDB, when it is not what PHP has */",
        *shape_lines(info),
    ]
    if _updates(info):
        fields = ", ".join(php_string(column["column"]["name"]) for column in _changeable(info))
        result += [
            "",
            "    /** The fields a change may write */",
            f"    private const FIELDS = [{fields}];",
            "",
            "    /**",
            "     * The document each entity was read from: a change writes only the fields that differ.",
            "     *",
            f"     * @var \\WeakMap<{info['entity']}, array<string, mixed>>|null",
            "     */",
            "    private static ?\\WeakMap $read = null;",
        ]
    return [*result, "", "    public function __construct(private readonly Db $db)", "    {", "    }"]


def helpers(_context: dict, info: dict, _uses: PhpUses) -> list:
    entity = info["entity"]
    reads = []
    writes = []
    for column in info["columns"]:
        name = php_string(column["column"]["name"])
        prop = access("$entity", column["prop"])
        reads.append(f"        {prop} = Documents::fromBson($document[{name}] ?? null, self::SHAPE[{name}]);")
        writes.append(f"            {name} => Documents::toBson({prop}, self::SHAPE[{name}]),")
    result = [
        "    /**",
        f"     * The {entity} of a document.",
        "     *",
        "     * @param array<string, mixed> $document",
        "     */",
        f"    private static function entity(array $document): {entity}",
        "    {",
        f"        $entity = new {entity}();",
        *reads,
        "        return self::loaded($entity);" if _updates(info) else "        return $entity;",
        "    }",
        "",
        "    /**",
        f"     * The document of a {entity}: what is null is left out.",
        "     *",
        "     * @return array<string, mixed>",
        "     */",
        f"    private static function document({entity} $entity): array",
        "    {",
        "        return array_filter([",
        *writes,
        "        ], fn (mixed $value) => $value !== null);",
        "    }",
    ]
    if _updates(info):
        result += [
            "",
            "    /** The same entity, with what it is stored as kept to tell its changes. */",
            f"    private static function loaded({entity} $entity): {entity}",
            "    {",
            "        self::$read ??= new \\WeakMap();",
            "        self::$read[$entity] = self::document($entity);",
            "        return $entity;",
            "    }",
        ]
    return result


def _find(info: dict, conditions: list[str], options: str) -> str:
    return (
        f"array_map(self::entity(...), $this->db->find({php_string(info['name'])}, {_filter(conditions)}, {options}))"
    )


def _identify(info: dict) -> list[str]:
    result = []
    for column in identified_lists(info):
        prop = access("$entity", column["prop"])
        result.append(f"{prop} = Documents::identify({prop});")
    return result


def body(context: dict, info: dict, method: dict, uses: PhpUses) -> list:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(info)
    name = php_string(info["name"])
    entity = php_string(info["entity"])
    key = info["key"][0]
    given = [*(_equal(column, f"${column['field']}") for column in columns), *soft]
    sort = f"'sort' => [{php_string(key['column']['name'])} => 1]"
    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        found = _find(info, given, "['limit' => 1]")
        return [*_guards(columns, "null"), f"return {found}[0] ?? null;"]
    if kind in ("listByParent", "findAllBy"):
        return [*_guards(columns, "[]"), f"return {_find(info, given, f'[{sort}]')};"]
    if kind == "list":
        paging = context["settings"]["paging"]
        if paging == "offset":
            found = _find(info, soft, f"[{sort}, 'skip' => $offset, 'limit' => $limit]")
            return [
                f"$items = $limit > 0 ? {found} : [];",
                f"return new Page($items, $this->db->count({name}, {_filter(soft)}), $offset, $limit);",
            ]
        if paging == "cursor":
            last = access("$items[$limit - 1]", key["prop"])
            return [
                f"$filter = {_filter(soft)};",
                "if ($after !== null) {",
                f"    $filter[{php_string(key['column']['name'])}] = ['$gt' => {stored(key['column']['type'], '$after[0]')}];",
                "}",
                f"$rows = array_map(self::entity(...), $this->db->find({name}, $filter, [{sort}, 'limit' => $limit + 1]));",
                "$items = array_slice($rows, 0, $limit);",
                f"return new CursorPage($items, count($rows) > $limit ? [{last}] : null);",
            ]
        return [f"return {_find(info, soft, f'[{sort}]')};"]
    if kind == "insert":
        # MongoDB fills nothing but the identifier
        fills = [line for column in info["columns"] for line in memory_fill(context, info, column, uses)]
        return [
            *fills,
            *_identify(info),
            f"$this->db->insert({entity}, {name}, fn () => self::document($entity));",
            f"return {'self::loaded($entity)' if _updates(info) else '$entity'};",
        ]
    if kind == "update":
        if not _updates(info):
            return ["// Nothing of it can change but its key", "return $entity;"]
        touched = _touched(info)
        names = [php_string(column["column"]["name"]) for column in touched]
        return [
            *(f"{access('$entity', column['prop'])} = new \\DateTimeImmutable();" for column in touched),
            *_identify(info),
            f"$this->db->write({entity}, function () use ($entity): void {{",
            "    $now = self::document($entity);",
            "    $changes = Documents::changes(self::$read[$entity] ?? [], $now, self::FIELDS);",
            "    if ($changes === []) {",
            "        return;",
            "    }",
            *(f"    $changes['$set'][{item}] = $now[{item}];" for item in names),
            f"    $this->db->update({name}, ['_id' => $now['_id']], $changes);",
            "});",
            "return self::loaded($entity);",
        ]
    if kind == "delete":
        condition = _filter([_equal(key, access("$entity", key["prop"]))])
        return [f"$this->db->delete({entity}, {name}, {condition});"]
    if kind in ("addItem", "removeItem"):
        return _item_body(context, info, method, uses)
    return ["throw new \\LogicException('not supported');"]


def _item_body(context: dict, info: dict, method: dict, uses: PhpUses) -> list[str]:
    """One item of a list added or removed in the database, whatever the rest of the list is by then."""
    items = list_of(context, info, method["query"])
    key = info["key"][0]
    param = items["params"][0]["name"]
    list_name = items["column"]["column"]["name"]
    path = php_string(list_name)
    touched = [f"{php_string(column['column']['name'])} => new UTCDateTime()" for column in _touched(info)]
    if touched:
        uses.add("MongoDB\\BSON\\UTCDateTime")
    version = info["version"]["column"]["name"] if info["version"] else None
    conditions = [_equal(key, f"${key['field']}"), *_soft_condition(info)]
    result = _guards([key], "null")
    adds = method["query"]["kind"] == "addItem"
    if not adds and items["by"] == "position":
        # MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
        conditions.append(f"{path} => ['$size' => $size]")
        kept = php_string("$" + list_name)
        head = f"['$slice' => [{kept}, $position]]"
        tail = f"['$slice' => [{kept}, $position + 1, max($size, 1)]]"
        sets = [f"{path} => ['$concatArrays' => [{head}, {tail}]]", *touched]
        if version:
            sets.append(f"{php_string(version)} => ['$add' => [{php_string('$' + version)}, 1]]")
        change = f"[['$set' => [{', '.join(sets)}]]]"
    else:
        if adds:
            item = f"${items['item']}"
            if items["by"] == "id":
                result.append(f"[{item}] = Documents::identify([{item}]);")
            main = f"'$push' => [{path} => {stored(items['type'], item)}]"
        elif items["by"] == "id":
            result += [f"if (!Documents::isId(${param})) {{", "    return null;", "}"]
            main = f"'$pull' => [{path} => ['_id' => Documents::toBson(${param}, 'objectId')]]"
        else:
            main = f"'$pull' => [{path} => {stored(items['type'], f'${param}')}]"
        also = [f"'$set' => [{', '.join(touched)}]"] if touched else []
        if version:
            also.append(f"'$inc' => [{php_string(version)} => 1]")
        change = f"[{', '.join([main, *also])}]"
    call = f"$this->db->change({php_string(info['entity'])}, {php_string(info['name'])}"
    return [
        *result,
        f"$document = {call}, fn () => [{_filter(conditions)}, {change}]);",
        "return $document === null ? null : self::entity($document);",
    ]
