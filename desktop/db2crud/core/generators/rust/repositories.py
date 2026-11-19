"""The repositories of each table: the trait services depend on (when the settings want one), its SeaORM implementation
(queries on the table's entity, run on the connection or the transaction of the unit of work, models turned into
entities, a database refusal turned into a Conflict, what the database fills read back after an insert), and its
in-memory one, with the same methods. Repositories decide nothing. Mirrors web/src/core/generators/rust/repositories.ts."""

from .context import (
    column_of,
    file_of,
    is_in,
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
from .entities import now_of, rs_literal
from .rust import RsUses, rs_string
from .support import COMMON, DOMAIN_ERROR


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
        elif kind == "delete":
            add([{"name": "entity", "type": f"&{entity}"}], "()", "Removes a row.")
    return methods


def _signature(method: dict) -> str:
    params = "".join(f", {param['name']}: {param['type']}" for param in method["params"])
    return f"async fn {method['name']}(&self{params}) -> Result<{method['returns']}, DomainError>"


# SeaORM


def _col(column: dict) -> str:
    return f"table::Column::{column['variant']}"


def _soft_filter(info: dict, uses: RsUses) -> str:
    """The filter that leaves out rows marked as deleted."""
    soft = info["soft"]
    if not soft:
        return ""
    if soft["column"]["type"]["kind"] != "boolean":
        return f".filter({_col(soft)}.is_null())"
    uses.add("sea_orm::Condition")
    return f".filter(Condition::any().add({_col(soft)}.eq(false)).add({_col(soft)}.is_null()))"


def _insert_columns(info: dict) -> list[dict]:
    """The columns written by an insert: not those the database fills (uuids are made first)."""
    return [column for column in info["columns"] if column["column"].get("generated") in (None, "uuid")]


def _update_columns(info: dict) -> list[dict]:
    """The columns written by an update: not the key, nor those the database fills."""
    return [
        column
        for column in info["columns"]
        if column["column"].get("generated") is None and not is_in(column, info["key"])
    ]


def _key_filter(info: dict) -> str:
    """The filters of a row, by the key of an entity."""
    return "".join(
        f".filter({_col(column)}.eq({stored('entity.' + column['field'], column)}))" for column in info["key"]
    )


def _order_by(info: dict, uses: RsUses) -> str:
    uses.add("sea_orm::QueryOrder")
    return "".join(f".order_by_asc({_col(column)})" for column in info["key"])


def _key_value(info: dict, variable: str) -> str:
    """The key of an entity known to be stored: last.id.expect(…), or a tuple."""
    values = [stored(f"{variable}.{column['field']}", column) for column in info["key"]]
    return values[0] if len(values) == 1 else f"({', '.join(values)})"


TO_ENTITIES = ".into_iter().map(to_entity).collect()"


def _sea_body(context: dict, info: dict, method: dict, uses: RsUses) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_filter(info, uses)
    paging = context["settings"]["paging"]

    def by_columns() -> str:
        uses.add("sea_orm::QueryFilter", "sea_orm::ColumnTrait")
        return "".join(f".filter({_col(column)}.eq({column['field']}))" for column in columns)

    db = "let db = self.db.executor();"
    if soft:
        uses.add("sea_orm::QueryFilter", "sea_orm::ColumnTrait")
    kind = method["query"]["kind"]
    # Every query but an update starts from the table's entity
    if kind != "update":
        uses.add("sea_orm::EntityTrait")
    if kind in ("getByKey", "findByUnique"):
        return [db, f"Ok(table::Entity::find(){by_columns()}{soft}.one(&db).await?.map(to_entity))"]
    if kind in ("listByParent", "findAllBy"):
        return [
            db,
            f"Ok(table::Entity::find(){by_columns()}{soft}{_order_by(info, uses)}.all(&db).await?{TO_ENTITIES})",
        ]
    if kind == "list":
        if paging == "offset":
            uses.add("sea_orm::PaginatorTrait", "sea_orm::QuerySelect")
            return [
                db,
                f"let total = table::Entity::find(){soft}.count(&db).await?;",
                f"let rows = table::Entity::find(){soft}{_order_by(info, uses)}.offset(offset).limit(limit).all(&db).await?;",
                f"Ok(Page {{ items: rows{TO_ENTITIES}, total, offset, limit }})",
            ]
        if paging == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            uses.add("sea_orm::QuerySelect", "sea_orm::QueryFilter", "sea_orm::ColumnTrait")
            key = info["key"]
            multi = len(key) > 1

            def after(index: int) -> str:
                return f"after{index}.clone()" if multi else "after"

            if not multi:
                condition = f"{_col(key[0])}.gt(after)"
            else:
                uses.add("sea_orm::Condition")
                terms = []
                for index, column in enumerate(key):
                    parts = [
                        *(f".add({_col(before)}.eq({after(position)}))" for position, before in enumerate(key[:index])),
                        f".add({_col(column)}.gt({after(index)}))",
                    ]
                    terms.append(
                        f"{_col(column)}.gt({after(index)})" if index == 0 else f"Condition::all(){''.join(parts)}"
                    )
                condition = f"Condition::any(){''.join(f'.add({term})' for term in terms)}"
            names = ", ".join(f"after{index}" for index in range(len(key)))
            return [
                db,
                f"let mut query = table::Entity::find(){soft};",
                "if let Some(after) = after {",
                *([f"    let ({names}) = after;"] if multi else []),
                f"    query = query.filter({condition});",
                "}",
                f"let rows = query{_order_by(info, uses)}.limit(limit + 1).all(&db).await?;",
                "let more = rows.len() as u64 > limit;",
                f"let items: Vec<{info['entity']}> = rows.into_iter().take(limit as usize).map(to_entity).collect();",
                f"let next = if more {{ items.last().map(|last| {_key_value(info, 'last')}) }} else {{ None }};",
                "Ok(CursorPage { items, next })",
            ]
        return [db, f"Ok(table::Entity::find(){soft}{_order_by(info, uses)}.all(&db).await?{TO_ENTITIES})"]
    if kind == "insert":
        uses.add("sea_orm::ActiveValue")
        uuids = [column for column in info["columns"] if column["column"].get("generated") == "uuid"]
        values = [
            f"    {column['field']}: entity.{column['field']}.map_or(ActiveValue::NotSet, |value| ActiveValue::Set(Some(value))),"
            if column["column"]["nullable"]
            else f"    {column['field']}: entity.{column['field']}.map_or(ActiveValue::NotSet, ActiveValue::Set),"
            for column in _insert_columns(info)
        ]
        return [
            *(["let mut entity = entity;"] if uuids else []),
            *(
                f"entity.{column['field']} = entity.{column['field']}.or_else(|| Some(uuid::Uuid::new_v4()));"
                for column in uuids
            ),
            db,
            "let model = table::ActiveModel {",
            *values,
            "    ..Default::default()",
            "};",
            # What the database filled is read back with the row
            "let stored = table::Entity::insert(model).exec_with_returning(&db).await.map_err(refused)?;",
            "Ok(to_entity(stored))",
        ]
    if kind == "update":
        changing = _update_columns(info)
        if not changing:
            return ["// Nothing of it can change", "Ok(entity)"]
        uses.add("sea_orm::ActiveValue", "sea_orm::ActiveModelTrait")
        lines = []
        for column in changing:
            value = f"entity.{column['field']}" if column["copy"] else f"entity.{column['field']}.clone()"
            if column["column"]["nullable"]:
                lines.append(f"    {column['field']}: ActiveValue::Set({value}),")
            else:
                lines.append(f"    {column['field']}: {value}.map_or(ActiveValue::NotSet, ActiveValue::Set),")
        return [
            db,
            "let model = table::ActiveModel {",
            *(
                f"    {column['field']}: ActiveValue::Unchanged({stored('entity.' + column['field'], column)}),"
                for column in info["key"]
            ),
            *lines,
            "    ..Default::default()",
            "};",
            "let stored = model.update(&db).await.map_err(refused)?;",
            "Ok(to_entity(stored))",
        ]
    if kind == "delete":
        uses.add("sea_orm::QueryFilter", "sea_orm::ColumnTrait")
        return [db, f"table::Entity::delete_many(){_key_filter(info)}.exec(&db).await.map_err(refused)?;", "Ok(())"]
    return ["unimplemented!()"]


def _sea_helpers(info: dict, methods: list[dict], uses: RsUses) -> list[str]:
    """to_entity and refused: how models become entities, and how a refusal of the database becomes a Conflict."""
    reads = any(method["query"]["kind"] != "delete" for method in methods)
    writes = any(method["query"]["kind"] in ("insert", "update", "delete") for method in methods)
    if writes:
        uses.add("sea_orm::DbErr")
    entity = info["entity"]
    lines: list[str] = []
    if reads:
        lines += [
            "",
            f"fn to_entity(model: table::Model) -> {entity} {{",
            f"    {entity} {{",
            *(
                f"        {column['field']}: {'model.' + column['field'] if column['column']['nullable'] else 'Some(model.' + column['field'] + ')'},"
                for column in info["columns"]
            ),
            "    }",
            "}",
        ]
    if writes:
        lines += [
            "",
            "/// A refusal of the database (a unique value, a row still pointed to) becomes a Conflict.",
            "fn refused(error: DbErr) -> DomainError {",
            "    if error.sql_err().is_some() {",
            f'        DomainError::conflict({rs_string(entity)}, &format!("the database refused the change: {{error}}"), &[])',
            "    } else {",
            "        error.into()",
            "    }",
            "}",
        ]
    return lines


# In memory


def _memory_fill(column: dict) -> str | None:
    db = column["column"]
    target = f"entity.{column['field']}"
    generated = db.get("generated")
    default = db.get("default")
    if generated == "identity":
        value = "*next" if column["rs"] == "i64" else f"*next as {column['rs']}"
        return f"{target} = {target}.or_else(|| {{\n    let mut next = self.next_id.lock().unwrap();\n    *next += 1;\n    Some({value})\n}});"
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
                f"let next = if more {{ items.last().map(|last| {_key_value(info, 'last')}) }} else {{ None }};",
                "Ok(CursorPage { items, next })",
            ]
        return ["Ok(self.visible())"]
    if kind in ("insert", "update"):
        return ["self.store(&entity);", "Ok(entity)"]
    if kind == "delete":
        return ["self.rows.lock().unwrap().retain(|row| key_of(row) != key_of(entity));", "Ok(())"]
    return ["unimplemented!()"]


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
    uses = RsUses().add(
        entity_path, DOMAIN_ERROR, "crate::database::Db", f"{module_of(context, info, 'table')} as table"
    )
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
        sql_bodies += _block(item, _sea_body(context, info, item, uses), "" if interfaces else "pub ", not interfaces)
    body += [
        f"/// Keeps {info['name']} rows in the database, through SeaORM: on the connection of the unit of work, or in its transaction.",
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
        *_sea_helpers(info, methods, uses),
    ]
    if context["settings"]["memoryRepositories"]:
        uses.add("std::sync::Arc", "std::sync::Mutex")
        fills = [line for line in (_memory_fill(column) for column in info["columns"]) if line is not None]
        kinds = {method["query"]["kind"] for method in methods}
        reads = any(kind in kinds for kind in ("getByKey", "findByUnique", "listByParent", "findAllBy", "list"))
        stores = "insert" in kinds or "update" in kinds
        cursor = "list" in kinds and context["settings"]["paging"] == "cursor"
        if reads or cursor:
            uses.add("std::cmp::Ordering")
        identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
        memory_bodies: list[str] = []
        for item in methods:
            lines = _memory_body(context, info, item)
            if item["query"]["kind"] == "insert" and fills:
                lines = ["let mut entity = entity;", *fills, *lines]
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
