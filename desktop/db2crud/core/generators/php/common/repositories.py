"""The repositories of each table: the interface services depend on (when the settings want one), its database
implementation (whose bodies the ORM writes), and its in-memory one, with the same methods. Repositories decide
nothing. Mirrors web/src/core/generators/php/common/repositories.ts.

A method is {"query", "name", "params": [{"name", "type"}], "returns", "tags", "doc"}."""

import re

from ....js import number_text
from ....schema.documents import is_object_id
from .context import (
    class_name,
    column_of,
    common_class,
    ind,
    is_in,
    memory_repository_class,
    namespace_of,
    path_of,
    php_file,
    query_name,
    repository_interface,
    sql_repository_class,
)
from .documents import identified_lists, list_of
from .php import PhpUses, access, php_literal, php_string


def repository_methods(context: dict, info: dict, uses: PhpUses) -> list[dict]:
    """The methods of a table's repository, with their PHP signatures."""
    entity = info["entity"]
    paging = context["settings"]["paging"]
    methods = []
    for item in info["queries"]:
        name = query_name(context, item)
        by_columns = [
            {"name": column_of(info, column)["field"], "type": column_of(info, column)["php"]}
            for column in item["columns"]
        ]

        def add(params, returns, doc, tags=None, item=item, name=name):
            methods.append(
                {"query": item, "name": name, "params": params, "returns": returns, "doc": doc, "tags": tags or []}
            )

        kind = item["kind"]
        joined = " and ".join(item["columns"])
        if kind == "getByKey":
            add(by_columns, f"?{entity}", "The row with this primary key, or null.")
        elif kind == "findByUnique":
            add(by_columns, f"?{entity}", f"The row with this {joined}, or null.")
        elif kind in ("listByParent", "findAllBy"):
            add(by_columns, "array", f"Rows with this {joined}, by primary key.", [f"@return list<{entity}>"])
        elif kind == "list":
            if paging == "offset":
                uses.add(common_class(context, "Page"))
                add(
                    [{"name": "offset", "type": "int"}, {"name": "limit", "type": "int"}],
                    "Page",
                    "At most $limit rows from $offset, by primary key, and how many there are.",
                    [f"@return Page<{entity}>"],
                )
            elif paging == "cursor":
                uses.add(common_class(context, "CursorPage"))
                add(
                    [{"name": "after", "type": "?array"}, {"name": "limit", "type": "int"}],
                    "CursorPage",
                    "At most $limit rows after the key $after (null for the first page), by primary key, and the key "
                    "to read the next page from.",
                    ["@param list<mixed>|null $after", f"@return CursorPage<{entity}>"],
                )
            else:
                add([], "array", "Every row, by primary key.", [f"@return list<{entity}>"])
        elif kind == "insert":
            add(
                [{"name": "entity", "type": entity}],
                entity,
                "Stores a new row; the values the database fills are read back.",
            )
        elif kind == "update":
            add(
                [{"name": "entity", "type": entity}],
                entity,
                "Stores the changes made to a row read from this repository.",
            )
        elif kind in ("addItem", "removeItem"):
            listed = list_of(context, info, item)
            adds = kind == "addItem"
            # Told apart by its position, it is only removed from a list of the size it was seen in
            size = [{"name": "size", "type": "int"}] if not adds and listed["by"] == "position" else []
            own = [{"name": column["field"], "type": column["php"]} for column in info["key"]]
            given = [{"name": listed["item"], "type": listed["php"]}] if adds else listed["params"]
            stored = item["columns"][0]
            add(
                [*own, *given, *size],
                f"?{entity}",
                f"Adds an item to {stored}, and gives the row as it is then, if there is one."
                if adds
                else f"Removes an item from {stored}{' that has this size' if size else ''}, and gives the row as it is then, if there is one.",
            )
        elif kind == "delete":
            add([{"name": "entity", "type": entity}], "void", "Removes a row read from this repository.")
    return methods


def uuid_fills(context: dict, info: dict, uses: PhpUses) -> list[str]:
    """The uuids an insert makes first: not every database can fill a uuid column."""
    result = []
    for column in info["columns"]:
        if column["column"].get("generated") == "uuid":
            uses.add(common_class(context, "Uuid"))
            result.append(f"{access('$entity', column['prop'])} ??= Uuid::v4();")
    return result


def filled_by_database(info: dict) -> list[dict]:
    """The columns the database fills when a row leaves them out, besides an identity key and uuids."""

    def filled(column: dict) -> bool:
        generated = column["column"].get("generated")
        if (
            generated is not None
            and generated != "uuid"
            and not (generated == "identity" and is_in(column, info["key"]))
        ):
            return True
        return (column["column"].get("default") or {}).get("kind") == "expression"

    return [column for column in info["columns"] if filled(column)]


def _signature(method: dict) -> str:
    params = ", ".join(f"{param['type']} ${param['name']}" for param in method["params"])
    return f"public function {method['name']}({params}): {method['returns']}"


def doc_block(summary: str, tags: list[str], pad: str = "    ") -> list[str]:
    """The doc comment of a method: one line, or a block when it has tags."""
    if not tags:
        return [f"{pad}/** {summary} */"]
    return [f"{pad}/**", f"{pad} * {summary}", f"{pad} *", *(f"{pad} * {tag}" for tag in tags), f"{pad} */"]


def _block(method: dict, body: list, doc: bool) -> list:
    return [
        "",
        *(doc_block(method["doc"], method["tags"]) if doc else []),
        f"    {_signature(method)}",
        "    {",
        *ind(body, 8),
        "    }",
    ]


# In memory


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def default_literal(column: dict, value) -> str:
    """A literal of the column's PHP type, for a default the database would set."""
    if value is None or isinstance(value, bool):
        return php_literal(value)
    if column["php"] == "string":
        return php_string(_text(value))
    if column["php"] == "float":
        text = _text(value)
        return text if re.search(r"[.eE]", text) else f"{text}.0"
    if column["php"] == "\\DateTimeImmutable":
        return f"new \\DateTimeImmutable({php_string(_text(value))})"
    return php_literal(value)


def memory_fill(context: dict, info: dict, column: dict, uses: PhpUses) -> list[str]:
    db = column["column"]
    target = access("$entity", column["prop"])
    primary = is_in(column, info["key"])
    generated = db.get("generated")
    if generated == "identity":
        if primary:
            return [f"if ({target} === null) {{", f"    {target} = $this->nextId++;", "}"]
        return [f"{target} ??= $this->nextId++;"]
    if generated == "uuid" and is_object_id(db["type"]):
        return [f"{target} ??= (string) new \\MongoDB\\BSON\\ObjectId();"]
    if generated == "uuid":
        uses.add(common_class(context, "Uuid"))
        return [f"{target} ??= Uuid::v4();"]
    if generated in ("now", "onUpdateNow"):
        now = "new \\DateTimeImmutable()" if column["php"] == "\\DateTimeImmutable" else "date('H:i:s')"
        return [f"{target} ??= {now};"]
    default = db.get("default")
    if default and default["kind"] == "literal" and default["value"] is not None:
        return [f"{target} ??= {default_literal(column, default['value'])};"]
    return []


def _memory_visible(info: dict) -> str:
    if not info["soft"]:
        return "true"
    target = access("$row", info["soft"]["prop"])
    return f"{target} !== true" if info["soft"]["column"]["type"]["kind"] == "boolean" else f"{target} === null"


def _memory_body(context: dict, info: dict, method: dict) -> list:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    conditions = " && ".join(f"{access('$row', column['prop'])} == ${column['field']}" for column in columns)
    entity = info["entity"]
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [
            "foreach ($this->visible() as $row) {",
            f"    if ({conditions}) {{",
            "        return $row;",
            "    }",
            "}",
            "return null;",
        ]
    if kind in ("listByParent", "findAllBy"):
        return [f"return array_values(array_filter($this->visible(), fn ({entity} $row) => {conditions}));"]
    if kind == "list":
        if paging == "offset":
            return [
                "$rows = $this->visible();",
                "return new Page(array_slice($rows, $offset, $limit), count($rows), $offset, $limit);",
            ]
        if paging == "cursor":
            return [
                f"$rows = array_values(array_filter($this->visible(), fn ({entity} $row) => $after === null || "
                "(self::keyOf($row) <=> $after) > 0));",
                "$items = array_slice($rows, 0, $limit);",
                "return new CursorPage($items, count($rows) > $limit ? self::keyOf($items[count($items) - 1]) : null);",
            ]
        return ["return $this->visible();"]
    if kind in ("insert", "update"):
        lists = [access("$entity", column["prop"]) for column in identified_lists(info)]
        identify = [f"{prop} = \\App\\Documents::identify({prop});" for prop in lists]
        return [*identify, "$this->rows[self::keyText($entity)] = $entity;", "return $entity;"]
    if kind in ("addItem", "removeItem"):
        return _memory_item(context, info, method)
    if kind == "delete":
        return ["unset($this->rows[self::keyText($entity)]);"]
    return ["throw new \\LogicException('not supported');"]


def _memory_item(context: dict, info: dict, method: dict) -> list:
    """One item of a list added or removed in memory."""
    listed = list_of(context, info, method["query"])
    param = listed["params"][0]["name"]
    items = access("$row", listed["column"]["prop"])
    adds = method["query"]["kind"] == "addItem"
    position = not adds and listed["by"] == "position"
    if adds:
        item = f"${listed['item']}"
        made = [f"[{item}] = \\App\\Documents::identify([{item}]);"] if listed["by"] == "id" else []
        change = [*made, f"{items} = [...({items} ?? []), {item}];"]
    elif position:
        change = [f"{items} = array_values(array_diff_key({items} ?? [], [$position => true]));"]
    else:
        candidate = "($candidate['_id'] ?? null)" if listed["by"] == "id" else "$candidate"
        kept = f"fn (mixed $candidate) => {candidate} !== ${param}"
        change = [f"{items} = array_values(array_filter({items} ?? [], {kept}));"]
    conditions = [f"{access('$row', column['prop'])} == ${column['field']}" for column in info["key"]]
    if position:
        conditions.append(f"count({items} ?? []) === $size")
    if info["version"]:
        version = access("$row", info["version"]["prop"])
        change.append(f"{version} = ({version} ?? 0) + 1;")
    change += [
        f"{access('$row', column['prop'])} = new \\DateTimeImmutable();"
        for column in info["columns"]
        if column["column"].get("generated") == "onUpdateNow"
    ]
    return [
        "foreach ($this->visible() as $row) {",
        f"    if ({' && '.join(conditions)}) {{",
        *(f"        {line}" for line in [*change, "return $row;"]),
        "    }",
        "}",
        "return null;",
    ]


def repository_files(context: dict, info: dict) -> list[dict]:
    ns = namespace_of(context, info, "repository")
    entity_class = class_name(namespace_of(context, info, "entity"), info["entity"])
    interfaces = context["settings"]["repositoryInterfaces"]
    orm = context["orm"]["repository"]
    files = []

    def unit(name: str, uses: PhpUses, body: list) -> dict:
        return php_file(path_of(ns, name), ns, uses.write(), [line for line in body if isinstance(line, str)])

    if interfaces:
        uses = PhpUses(ns).add(entity_class)
        methods = repository_methods(context, info, uses)
        body = [
            f"/** Where {info['name']} rows are kept. Services depend only on this interface. */",
            f"interface {repository_interface(info)}",
            "{",
        ]
        for index, method in enumerate(methods):
            if index > 0:
                body.append("")
            body.extend([*doc_block(method["doc"], method["tags"]), f"    {_signature(method)};"])
        body.append("}")
        files.append(unit(repository_interface(info), uses, body))
    uses = PhpUses(ns).add(entity_class)
    methods = repository_methods(context, info, uses)
    init = orm["init"](context, info, uses)
    bodies = [_block(method, orm["body"](context, info, method, uses), not interfaces) for method in methods]
    helpers = orm["helpers"](context, info, uses)
    members = [
        *(["", *init] if init else []),
        *(line for block in bodies for line in block),
        *(["", *helpers] if helpers else []),
    ]
    how = (
        "Writes run in the transaction of whoever holds the connection, when there is one."
        if context["settings"]["transactions"] == "caller"
        else "A write joins the transaction already open, or is committed at once."
    )
    files.append(
        unit(
            sql_repository_class(info),
            uses,
            [
                f"/** Keeps {info['name']} rows in the database, {orm['doc'](context)} {how} */",
                f"{'final ' if interfaces else ''}class {sql_repository_class(info)}"
                + (f" implements {repository_interface(info)}" if interfaces else ""),
                "{",
                *members[1:],
                "}",
            ],
        )
    )
    if context["settings"]["memoryRepositories"]:
        uses = PhpUses(ns).add(entity_class)
        methods = repository_methods(context, info, uses)
        fills = [line for column in info["columns"] for line in memory_fill(context, info, column, uses)]
        bodies = []
        for method in methods:
            body = _memory_body(context, info, method)
            bodies.append(_block(method, [*fills, *body] if method["query"]["kind"] == "insert" else body, False))
        identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
        key_values = ", ".join(access("$row", column["prop"]) for column in info["key"])
        entity = info["entity"]
        no_connection = not interfaces and len(orm["init"](context, info, PhpUses(ns))) > 0
        files.append(
            unit(
                memory_repository_class(info),
                uses,
                [
                    f"/** Keeps {info['name']} rows in memory, for tests and for trying the services without a database. */",
                    f"final class {memory_repository_class(info)} implements {repository_interface(info)}"
                    if interfaces
                    else f"final class {memory_repository_class(info)} extends {sql_repository_class(info)}",
                    "{",
                    f"    /** @var array<string, {entity}> */",
                    "    private array $rows = [];",
                    *(["", "    private int $nextId = 1;"] if identity else []),
                    # The database class needs a connection; memory does not
                    *(["", "    public function __construct()", "    {", "    }"] if no_connection else []),
                    "",
                    "    /**",
                    "     * The key of a row, as a list of its key values.",
                    "     *",
                    "     * @return list<mixed>",
                    "     */",
                    f"    private static function keyOf({entity} $row): array",
                    "    {",
                    f"        return [{key_values}];",
                    "    }",
                    "",
                    f"    private static function keyText({entity} $row): string",
                    "    {",
                    "        return serialize(array_map(fn (mixed $value) => $value instanceof \\DateTimeInterface ? "
                    "$value->format('Y-m-d H:i:s.u P') : $value, self::keyOf($row)));",
                    "    }",
                    "",
                    "    /**",
                    "     * The rows reads can see, by primary key.",
                    "     *",
                    f"     * @return list<{entity}>",
                    "     */",
                    "    private function visible(): array",
                    "    {",
                    f"        $rows = array_values(array_filter($this->rows, fn ({entity} $row) => {_memory_visible(info)}));",
                    f"        usort($rows, fn ({entity} $a, {entity} $b) => self::keyOf($a) <=> self::keyOf($b));",
                    "        return $rows;",
                    "    }",
                    *(line for block in bodies for line in block),
                    "}",
                ],
            )
        )
    return files
