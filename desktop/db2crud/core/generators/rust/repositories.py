"""The repositories of each table: the trait services depend on (when the settings want one), its database implementation
(its bodies are the strategy's), and its in-memory one, with the same methods. Repositories decide nothing. Mirrors
web/src/core/generators/rust/repositories.ts."""

from .context import (
    column_of,
    file_of,
    key_type,
    memory_repository,
    module_of,
    path_in,
    query_name,
    repository_trait,
    rs_file,
    sql_repository,
    stored,
)
from .documents import identified_lists, list_of
from .rust import RsUses
from .support import COMMON, DOMAIN_ERROR
from .values import now_of, rs_literal


def repository_methods(context: dict, info: dict, uses: RsUses) -> list[dict]:
    """The methods of a table's repository, with their Rust signatures (the result type without Result):
    {"query", "name", "params", "returns", "doc"}."""
    entity = info["entity"]
    paging = context["settings"]["paging"]
    methods: list[dict] = []
    for query_design in info["queries"]:
        name = query_name(context, query_design)
        by_columns = [
            {"name": column_of(info, column)["field"], "type": column_of(info, column)["rs"]}
            for column in query_design["columns"]
        ]

        def add(params: list[dict], returns: str, doc: str, query_design=query_design, name=name) -> None:
            methods.append({"query": query_design, "name": name, "params": params, "returns": returns, "doc": doc})

        kind = query_design["kind"]
        joined = " and ".join(query_design["columns"])
        if kind == "getByKey":
            add(by_columns, f"Option<{entity}>", "The row with this primary key, or None.")
        elif kind == "findByUnique":
            add(by_columns, f"Option<{entity}>", f"The row with this {joined}, or None.")
        elif kind in ("listByParent", "findAllBy"):
            add(by_columns, f"Vec<{entity}>", f"Rows with this {joined}, by primary key.")
        elif kind == "list":
            if paging == "offset":
                uses.add(f"{COMMON}::Page")
                add(
                    [{"name": "offset", "type": "u64"}, {"name": "limit", "type": "u64"}],
                    f"Page<{entity}>",
                    "At most limit rows from offset, by primary key, and how many there are.",
                )
            elif paging == "cursor":
                uses.add(f"{COMMON}::CursorPage")
                add(
                    [{"name": "after", "type": f"Option<{key_type(info)}>"}, {"name": "limit", "type": "u64"}],
                    f"CursorPage<{entity}, {key_type(info)}>",
                    "At most limit rows after the key after (None for the first page), by primary key, and the key to read the next page from.",
                )
            else:
                add([], f"Vec<{entity}>", "Every row, by primary key.")
        elif kind == "insert":
            add(
                [{"name": "entity", "type": entity}],
                entity,
                "Stores a new row; the values the database fills are read back.",
            )
        elif kind == "update":
            add([{"name": "entity", "type": entity}], entity, "Stores the changes made to a row.")
        elif kind in ("addItem", "removeItem"):
            items = list_of(info, query_design)
            adds = kind == "addItem"
            # Told apart by its position, it is only removed from a list of the size it was seen in
            size = [{"name": "size", "type": "usize"}] if not adds and items["by"] == "position" else []
            given = (
                [{"name": items["item"], "type": items["rs"]}]
                if adds
                else [{"name": item["name"], "type": item["type"]} for item in items["params"]]
            )
            kept = query_design["columns"][0]
            add(
                [*({"name": column["field"], "type": column["rs"]} for column in info["key"]), *given, *size],
                f"Option<{entity}>",
                f"Adds an item to {kept}, and gives the row as it is then, if there is one."
                if adds
                else f"Removes an item from {kept}{' that has this size' if size else ''}, and gives the row as it is then, if there is one.",
            )
        elif kind == "delete":
            add([{"name": "entity", "type": f"&{entity}"}], "()", "Removes a row.")
    return methods


def _signature(method: dict) -> str:
    params = "".join(f", {param['name']}: {param['type']}" for param in method["params"])
    return f"async fn {method['name']}(&self{params}) -> Result<{method['returns']}, DomainError>"


def key_value(info: dict, variable: str) -> str:
    """The key of an entity known to be stored: last.id.expect(…), or a tuple."""
    values = [stored(f"{variable}.{column['field']}", column) for column in info["key"]]
    return values[0] if len(values) == 1 else f"({', '.join(values)})"


# In memory


def memory_fill(column: dict) -> str | None:
    db = column["column"]
    target = f"entity.{column['field']}"
    generated = db.get("generated")
    default = db.get("default")
    if generated == "identity":
        value = "*next" if column["rs"] == "i64" else f"*next as {column['rs']}"
        return f"{target} = {target}.or_else(|| {{\n    let mut next = self.next_id.lock().unwrap();\n    *next += 1;\n    Some({value})\n}});"
    if generated == "uuid" and db["type"].get("objectId"):
        return f"{target} = {target}.or_else(|| Some(mongodb::bson::oid::ObjectId::new().to_hex()));"
    if generated == "uuid":
        return f"{target} = {target}.or_else(|| Some(uuid::Uuid::new_v4()));"
    if generated in ("now", "onUpdateNow"):
        now = now_of(column)
        return f"{target} = {target}.or_else(|| Some({now}));" if now else None
    if default is not None and default["kind"] == "literal" and default.get("value") is not None:
        return f"{target} = {target}.or_else(|| Some({rs_literal(column, default['value'])}));"
    return None


def _memory_visible(info: dict) -> str:
    soft = info["soft"]
    if not soft:
        return ""
    if soft["column"]["type"]["kind"] == "boolean":
        return f".filter(|row| row.{soft['field']} != Some(true))"
    return f".filter(|row| row.{soft['field']}.is_none())"


def _memory_body(context: dict, info: dict, method: dict) -> list[str]:
    fields = [column_of(info, name)["field"] for name in method["query"]["columns"]]
    conditions = " && ".join(f"row.{field}.as_ref() == Some(&{field})" for field in fields)
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [f"Ok(self.visible().into_iter().find(|row| {conditions}))"]
    if kind in ("listByParent", "findAllBy"):
        return [f"Ok(self.visible().into_iter().filter(|row| {conditions}).collect())"]
    if kind == "list":
        if paging == "offset":
            return [
                "let rows = self.visible();",
                "let total = rows.len() as u64;",
                "Ok(Page { items: rows.into_iter().skip(offset as usize).take(limit as usize).collect(), total, offset, limit })",
            ]
        if paging == "cursor":
            names = [f"after{index}" for index in range(len(info["key"]))]
            if len(info["key"]) == 1:
                wrap = "after.map(|after| (Some(after),))"
            else:
                wrap = f"after.map(|({', '.join(names)})| ({', '.join(f'Some({name})' for name in names)}))"
            return [
                f"let after = {wrap};",
                "let rows: Vec<_> = self",
                "    .visible()",
                "    .into_iter()",
                "    .filter(|row| after.as_ref().is_none_or(|after| key_of(row).partial_cmp(after) == Some(Ordering::Greater)))",
                "    .collect();",
                "let more = rows.len() as u64 > limit;",
                f"let items: Vec<{info['entity']}> = rows.into_iter().take(limit as usize).collect();",
                f"let next = if more {{ items.last().map(|last| {key_value(info, 'last')}) }} else {{ None }};",
                "Ok(CursorPage { items, next })",
            ]
        return ["Ok(self.visible())"]
    if kind in ("insert", "update"):
        identified = ["let mut entity = entity;", "entity.identify_items();"] if identified_lists(info) else []
        return [*identified, "self.store(&entity);", "Ok(entity)"]
    if kind in ("addItem", "removeItem"):
        return _memory_item(info, method)
    if kind == "delete":
        return ["self.rows.lock().unwrap().retain(|row| key_of(row) != key_of(entity));", "Ok(())"]
    return ["unimplemented!()"]


def _memory_item(info: dict, method: dict) -> list[str]:
    """One item of a list added or removed in memory."""
    items = list_of(info, method["query"])
    name = items["params"][0]["name"]
    held = f"found.{items['column']['field']}"
    item = items["item"]
    keys = " && ".join(f"row.{column['field']}.as_ref() == Some(&{column['field']})" for column in info["key"])
    touched = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
    change = []
    if method["query"]["kind"] == "addItem":
        if items["by"] == "id":
            change += [
                f"let mut {item} = {item};",
                f"{item}.id = {item}.id.or_else(|| Some(mongodb::bson::oid::ObjectId::new().to_hex()));",
            ]
        change.append(f"{held}.get_or_insert_default().push({item});")
    elif items["by"] == "position":
        change += [
            f"let items = {held}.get_or_insert_default();",
            "if items.len() != size || position >= size {",
            "    return Ok(None);",
            "}",
            "items.remove(position);",
        ]
    else:
        other = f"item.id.as_ref() != Some(&{name})" if items["by"] == "id" else f"*item != {name}"
        change.append(f"{held}.get_or_insert_default().retain(|item| {other});")
    version = info["version"]["field"] if info["version"] else None
    return [
        f"let Some(mut found) = self.visible().into_iter().find(|row| {keys}) else {{",
        "    return Ok(None);",
        "};",
        *change,
        *([f"found.{version} = Some(found.{version}.unwrap_or(0) + 1);"] if version else []),
        *(f"found.{column['field']} = Some(chrono::Utc::now());" for column in touched),
        "self.store(&found);",
        "Ok(Some(found))",
    ]


def _block(method: dict, body: list[str], prefix: str, doc: bool) -> list[str]:
    return [
        "",
        *([f"    /// {method['doc']}"] if doc else []),
        f"    {prefix}{_signature(method)} {{",
        *(f"        {part}" for line in body for part in line.split("\n")),
        "    }",
    ]


def repository_file(context: dict, info: dict) -> dict:
    module = module_of(context, info, "repository")
    entity_path = path_in(module_of(context, info, "entity"), info["entity"])
    interfaces = context["settings"]["repositoryInterfaces"]
    entity = info["entity"]
    repository, label = context["orm"]["repository"], context["orm"]["label"]
    uses = RsUses().add(entity_path, DOMAIN_ERROR, "crate::database::Db", *repository["uses"](context, info))
    methods = repository_methods(context, info, uses)
    if interfaces:
        uses.add("async_trait::async_trait")
    body: list[str] = []
    if interfaces:
        declarations: list[str] = []
        for index, item in enumerate(methods):
            if index > 0:
                declarations.append("")
            declarations += [f"    /// {item['doc']}", f"    {_signature(item)};"]
        body += [
            f"/// Where {info['name']} rows are kept. Services depend only on this trait.",
            "#[async_trait]",
            f"pub trait {repository_trait(info)}: Send + Sync {{",
            *declarations,
            "}",
            "",
        ]
    sql_bodies: list[str] = []
    for item in methods:
        sql_bodies += _block(
            item, repository["body"](context, info, item, uses), "" if interfaces else "pub ", not interfaces
        )
    body += [
        f"/// Keeps {info['name']} rows in the database, through {label}: on the connection of the unit of work, or in its transaction.",
        f"pub struct {sql_repository(info)}<'a> {{",
        "    db: &'a Db,",
        "}",
        "",
        f"impl<'a> {sql_repository(info)}<'a> {{",
        "    pub fn new(db: &'a Db) -> Self {",
        "        Self { db }",
        "    }",
        *(
            [
                "}",
                "",
                "#[async_trait]",
                f"impl {repository_trait(info)} for {sql_repository(info)}<'_> {{",
                *sql_bodies[1:],
            ]
            if interfaces
            else sql_bodies
        ),
        "}",
        *repository["helpers"](context, info, methods, uses),
    ]
    if context["settings"]["memoryRepositories"]:
        uses.add("std::sync::Arc", "std::sync::Mutex")
        fills = [line for line in (memory_fill(column) for column in info["columns"]) if line is not None]
        kinds = {method["query"]["kind"] for method in methods}
        items = {"addItem", "removeItem"}
        reads = bool(kinds & {"getByKey", "findByUnique", "listByParent", "findAllBy", "list", *items})
        stores = bool(kinds & {"insert", "update", *items})
        cursor = "list" in kinds and context["settings"]["paging"] == "cursor"
        if reads or cursor:
            uses.add("std::cmp::Ordering")
        identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
        memory_bodies: list[str] = []
        for item in methods:
            lines = _memory_body(context, info, item)
            if item["query"]["kind"] == "insert" and fills:
                taken = "let mut entity = entity;"
                lines = [taken, *fills, *(line for line in lines if line != taken)]
            memory_bodies += _block(item, lines, "", False)
        key_types = [f"Option<{column['rs']}>" for column in info["key"]]
        single = "," if len(key_types) == 1 else ""
        key_values = ", ".join(
            f"row.{column['field']}" if column["copy"] else f"row.{column['field']}.clone()" for column in info["key"]
        )
        body += [
            "",
            f"/// Keeps {info['name']} rows in memory, for tests and for trying the services without a database. Its copies share the rows.",
            "#[derive(Clone, Default)]",
            f"pub struct {memory_repository(info)} {{",
            f"    rows: Arc<Mutex<Vec<{entity}>>>,",
            *(["    next_id: Arc<Mutex<i64>>,"] if identity else []),
            "}",
            "",
            f"impl {memory_repository(info)} {{",
            *(
                [
                    "    /// The rows reads see, by primary key.",
                    f"    fn visible(&self) -> Vec<{entity}> {{",
                    f"        let mut rows: Vec<{entity}> = self.rows.lock().unwrap().iter(){_memory_visible(info)}.cloned().collect();",
                    "        rows.sort_by(|a, b| key_of(a).partial_cmp(&key_of(b)).unwrap_or(Ordering::Equal));",
                    "        rows",
                    "    }",
                ]
                if reads
                else []
            ),
            *(
                [
                    *([""] if reads else []),
                    "    /// Keeps a row, in place of the one with its key.",
                    f"    fn store(&self, entity: &{entity}) {{",
                    "        let mut rows = self.rows.lock().unwrap();",
                    "        rows.retain(|row| key_of(row) != key_of(entity));",
                    "        rows.push(entity.clone());",
                    "    }",
                ]
                if stores
                else []
            ),
            "}",
            "",
            "/// The key of a row, as a tuple of its key values.",
            f"fn key_of(row: &{entity}) -> ({', '.join(key_types)}{single}) {{",
            f"    ({key_values}{single})",
            "}",
            "",
            "#[async_trait]",
            f"impl {repository_trait(info)} for {memory_repository(info)} {{",
            *memory_bodies[1:],
            "}",
        ]
    return rs_file(
        file_of(module),
        uses.write(),
        body,
        [f'The repositories of the "{info["name"]}" table. Repositories decide nothing.'],
    )
