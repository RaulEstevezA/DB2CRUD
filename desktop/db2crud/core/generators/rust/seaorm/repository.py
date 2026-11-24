"""* The SeaORM repositories: queries on the table's entity, run on the connection or the transaction of the unit of work,
models turned into entities, a database refusal turned into a Conflict, what the database fills read back after an insert. Mirrors
web/src/core/generators/rust/seaorm/repository.ts."""

from ..context import column_of, is_in, stored
from ..repositories import key_value
from ..rust import RsUses, rs_string


def _col(column: dict):
    return f"table::Column::{column['variant']}"


def _soft_filter(info: dict, uses: RsUses) -> str:
    """The filter that leaves out rows marked as deleted."""
    if not info["soft"]:
        return ""
    if info["soft"]["column"]["type"]["kind"] != "boolean":
        return f".filter({_col(info['soft'])}.is_null())"
    uses.add("sea_orm::Condition")
    return f".filter(Condition::any().add({_col(info['soft'])}.eq(false)).add({_col(info['soft'])}.is_null()))"


def _insert_columns(info: dict):
    """The columns written by an insert: not those the database fills (uuids are made first)."""
    return [
        column
        for column in info["columns"]
        if column["column"].get("generated") is None or column["column"].get("generated") == "uuid"
    ]


def _update_columns(info: dict):
    """The columns written by an update: not the key, nor those the database fills."""
    return [
        column
        for column in info["columns"]
        if column["column"].get("generated") is None and not is_in(column, info["key"])
    ]


def _key_filter(info: dict):
    """The filters of a row, by the key of an entity."""
    return "".join(
        (f".filter({_col(column)}.eq(" + stored(f"entity.{column['field']}", column) + "))") for column in info["key"]
    )


def _order_by(info: dict, uses: RsUses) -> str:
    uses.add("sea_orm::QueryOrder")
    return "".join(f".order_by_asc({_col(column)})" for column in info["key"])


_to_entities = ".into_iter().map(to_entity).collect()"


def sea_body(context: dict, info: dict, method: dict, uses: RsUses) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_filter(info, uses)

    def by_columns():
        uses.add("sea_orm::QueryFilter", "sea_orm::ColumnTrait")
        return "".join(f".filter({_col(column)}.eq({column['field']}))" for column in columns)

    db = "let db = self.db.executor();"
    if soft:
        uses.add("sea_orm::QueryFilter", "sea_orm::ColumnTrait")
    # Every query but an update starts from the table's entity
    if method["query"]["kind"] != "update":
        uses.add("sea_orm::EntityTrait")
    if method["query"]["kind"] in ("getByKey", "findByUnique"):
        return [db, f"Ok(table::Entity::find(){by_columns()}{soft}.one(&db).await?.map(to_entity))"]
    if method["query"]["kind"] in ("listByParent", "findAllBy"):
        return [
            db,
            f"Ok(table::Entity::find(){by_columns()}{soft}{_order_by(info, uses)}.all(&db).await?{_to_entities})",
        ]
    if method["query"]["kind"] == "list":
        if context["settings"]["paging"] == "offset":
            uses.add("sea_orm::PaginatorTrait", "sea_orm::QuerySelect")
            return [
                db,
                f"let total = table::Entity::find(){soft}.count(&db).await?;",
                f"let rows = table::Entity::find(){soft}{_order_by(info, uses)}.offset(offset).limit(limit).all(&db).await?;",
                f"Ok(Page {{ items: rows{_to_entities}, total, offset, limit }})",
            ]
        if context["settings"]["paging"] == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            uses.add("sea_orm::QuerySelect", "sea_orm::QueryFilter", "sea_orm::ColumnTrait")
            multi = len(info["key"]) > 1

            def after(index: int):
                return f"after{index}.clone()" if multi else "after"

            if not multi:
                condition = f"{_col(info['key'][0])}.gt(after)"
            else:
                uses.add("sea_orm::Condition")
                terms = []
                for index, column in enumerate(info["key"]):
                    parts = [
                        *(
                            f".add({_col(before)}.eq({after(position)}))"
                            for position, before in enumerate(info["key"][:index])
                        ),
                        f".add({_col(column)}.gt({after(index)}))",
                    ]
                    terms.append(
                        f"{_col(column)}.gt({after(index)})" if index == 0 else f"Condition::all(){''.join(parts)}"
                    )
                condition = "Condition::any()" + "".join(f".add({term})" for term in terms)
            return [
                db,
                f"let mut query = table::Entity::find(){soft};",
                "if let Some(after) = after {",
                *(
                    [("    let (" + ", ".join(f"after{index}" for index, _ in enumerate(info["key"])) + ") = after;")]
                    if multi
                    else []
                ),
                f"    query = query.filter({condition});",
                "}",
                f"let rows = query{_order_by(info, uses)}.limit(limit + 1).all(&db).await?;",
                "let more = rows.len() as u64 > limit;",
                f"let items: Vec<{info['entity']}> = rows.into_iter().take(limit as usize).map(to_entity).collect();",
                f"let next = if more {{ items.last().map(|last| {key_value(info, 'last')}) }} else {{ None }};",
                "Ok(CursorPage { items, next })",
            ]
        return [db, f"Ok(table::Entity::find(){soft}{_order_by(info, uses)}.all(&db).await?{_to_entities})"]
    if method["query"]["kind"] == "insert":
        uses.add("sea_orm::ActiveValue")
        uuids = [column for column in info["columns"] if column["column"].get("generated") == "uuid"]
        return [
            *(["let mut entity = entity;"] if len(uuids) > 0 else []),
            *(
                f"entity.{column['field']} = entity.{column['field']}.or_else(|| Some(uuid::Uuid::new_v4()));"
                for column in uuids
            ),
            db,
            "let model = table::ActiveModel {",
            *(
                (
                    f"    {column['field']}: entity.{column['field']}.map_or(ActiveValue::NotSet, |value| ActiveValue::Set(Some(value))),"
                    if column["column"]["nullable"]
                    else f"    {column['field']}: entity.{column['field']}.map_or(ActiveValue::NotSet, ActiveValue::Set),"
                )
                for column in _insert_columns(info)
            ),
            "    ..Default::default()",
            "};",
            "let stored = table::Entity::insert(model).exec_with_returning(&db).await.map_err(refused)?;",
            "Ok(to_entity(stored))",
        ]
    if method["query"]["kind"] == "update":
        changing = _update_columns(info)
        if len(changing) == 0:
            return ["// Nothing of it can change", "Ok(entity)"]
        uses.add("sea_orm::ActiveValue", "sea_orm::ActiveModelTrait")
        return [
            db,
            "let model = table::ActiveModel {",
            *(
                (f"    {column['field']}: ActiveValue::Unchanged(" + stored(f"entity.{column['field']}", column) + "),")
                for column in info["key"]
            ),
            *(
                (
                    (
                        f"    {column['field']}: ActiveValue::Set("
                        + (f"entity.{column['field']}" if column["copy"] else f"entity.{column['field']}.clone()")
                        + "),"
                    )
                    if column["column"]["nullable"]
                    else (
                        f"    {column['field']}: "
                        + (f"entity.{column['field']}" if column["copy"] else f"entity.{column['field']}.clone()")
                        + ".map_or(ActiveValue::NotSet, ActiveValue::Set),"
                    )
                )
                for column in changing
            ),
            "    ..Default::default()",
            "};",
            "let stored = model.update(&db).await.map_err(refused)?;",
            "Ok(to_entity(stored))",
        ]
    if method["query"]["kind"] == "delete":
        uses.add("sea_orm::QueryFilter", "sea_orm::ColumnTrait")
        return [db, f"table::Entity::delete_many(){_key_filter(info)}.exec(&db).await.map_err(refused)?;", "Ok(())"]
    return ["unimplemented!()"]


def sea_helpers(_context: dict, info: dict, methods: list, uses: RsUses) -> list[str]:
    """to_entity and refused: how models become entities, and how a refusal of the database becomes a Conflict."""
    reads = any(method["query"]["kind"] != "delete" for method in methods)
    writes = any(method["query"]["kind"] in ["insert", "update", "delete"] for method in methods)
    if writes:
        uses.add("sea_orm::DbErr")
    return [
        *(
            [
                "",
                f"fn to_entity(model: table::Model) -> {info['entity']} {{",
                f"    {info['entity']} {{",
                *(
                    (
                        f"        {column['field']}: "
                        + (
                            f"model.{column['field']}"
                            if column["column"]["nullable"]
                            else f"Some(model.{column['field']})"
                        )
                        + ","
                    )
                    for column in info["columns"]
                ),
                "    }",
                "}",
            ]
            if reads
            else []
        ),
        *(
            [
                "",
                "/// A refusal of the database (a unique value, a row still pointed to) becomes a Conflict.",
                "fn refused(error: DbErr) -> DomainError {",
                "    if error.sql_err().is_some() {",
                f'        DomainError::conflict({rs_string(info["entity"])}, &format!("the database refused the change: {{error}}"), &[])',
                "    } else {",
                "        error.into()",
                "    }",
                "}",
            ]
            if writes
            else []
        ),
    ]
