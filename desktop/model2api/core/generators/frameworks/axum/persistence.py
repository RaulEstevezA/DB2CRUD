"""Storage of each resource in the Axum project: the repository trait the service depends on, the typed filters of
its lists, and the implementation of the chosen persistence:
- memory: a map behind a mutex, to run the API without a database
- none: every method answers 501, with a TODO where the storage goes
- seaOrm: a SeaORM entity and a repository with filters and sorting written for each field
Mirrors web/src/core/generators/frameworks/axum/persistence.ts.
"""

from collections.abc import Callable
from dataclasses import dataclass

from ....js import number_text
from ...common.text import file_text, lines
from ...languages.rust.rust import RsUses, rs_doc, rs_header, rs_pascal, rs_string, rs_type
from .context import AxumContext, field_name, key_field, key_type, module_path, names
from .model import field_type, stored_as_json


def queryable(field: dict) -> bool:
    """Whether a field can be filtered and sorted: plain values, enums and single references."""
    return not stored_as_json(field) and field["type"]["kind"] in ("scalar", "enum")


def filter_fields(resource: dict) -> list[dict]:
    """The fields the lists of a resource filter by."""
    wires = {
        wire for endpoint in resource["endpoints"] if endpoint["operation"] == "list" for wire in endpoint["filters"]
    }
    return [field for field in resource["fields"] if field["wire"] in wires and queryable(field)]


def sort_fields(resource: dict) -> list[dict]:
    """The fields the lists of a resource sort by."""
    wires = {wire for endpoint in resource["endpoints"] if endpoint["operation"] == "list" for wire in endpoint["sort"]}
    return [field for field in resource["fields"] if field["wire"] in wires and queryable(field)]


@dataclass
class _Column:
    """The column of a field in its entity: its Rust type and SeaORM attributes, and how values go in and out."""

    type: str
    attribute: str | None
    write: Callable[[str], str]
    read: Callable[[str], str]
    match: Callable[[str], str]


def _plain(type_name: str, attribute: str | None = None) -> _Column:
    return _Column(
        type_name, attribute, lambda value: f"{value}.clone()", lambda value: value, lambda value: f"{value}.clone()"
    )


def _text(length) -> str:
    return f"String(StringLen::N({number_text(length)}))" if length is not None and length <= 255 else "Text"


def _key_column(target: dict) -> tuple[str, str | None]:
    scalar = target["key"]["type"].get("scalar")
    if scalar == "integer":
        return ("i64", None)
    if scalar == "uuid":
        return ("Uuid", None)
    length = key_field(target)["constraints"].get("maxLength")
    return ("String", f'column_type = "{_text(length if length is not None else 191)}"')


def _column_of(context: AxumContext, resource: dict, field: dict) -> _Column:
    mysql = context.settings.get("database") in ("mysql", "mariadb")
    if field["name"] == resource["key"]["field"]:
        return _plain(*_key_column(resource))
    if stored_as_json(field):
        return _Column(
            "Option<String>",
            'column_type = "Text"',
            lambda value: f"{value}.as_ref().map(|value| serde_json::to_string(value).unwrap_or_default())",
            lambda value: f"{value}.and_then(|text| serde_json::from_str(&text).ok())",
            lambda value: value,
        )
    if field.get("reference"):
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        type_name, attribute = _key_column(target)
        return _plain(f"Option<{type_name}>", attribute)
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        enum_type = rs_type(type_ref["name"])
        if item["valueType"] == "integer":
            return _Column(
                "Option<i64>",
                None,
                lambda value: f"{value}.map(|value| value.value())",
                lambda value: f"{value}.and_then({enum_type}::from_value)",
                lambda value: f"{value}.value()",
            )
        return _Column(
            "Option<String>",
            'column_type = "String(StringLen::N(64))"',
            lambda value: f"{value}.map(|value| value.value().to_string())",
            lambda value: f"{value}.as_deref().and_then({enum_type}::from_value)",
            lambda value: f"{value}.value()",
        )
    if type_ref["kind"] != "scalar":
        return _plain("Option<String>", 'column_type = "Text"')
    scalar = type_ref["scalar"]
    if scalar == "integer":
        return _plain(f"Option<{'i64' if type_ref.get('bits') == 64 else 'i32'}>")
    if scalar == "float":
        return _plain("Option<f64>")
    if scalar == "decimal":
        return _plain("Option<Decimal>", 'column_type = "Decimal(Some((18, 4)))"')
    if scalar == "boolean":
        return _plain("Option<bool>")
    if scalar == "date":
        return _plain("Option<Date>")
    if scalar == "datetime":
        # MySQL keeps date-times without a zone: they are stored in UTC
        if mysql:
            return _Column(
                "Option<DateTime>",
                'column_type = "DateTime"',
                lambda value: f"{value}.map(|value| value.naive_utc())",
                lambda value: f"{value}.map(|value| value.and_utc())",
                lambda value: f"{value}.naive_utc()",
            )
        return _plain("Option<DateTimeUtc>")
    if scalar == "uuid":
        return _plain("Option<Uuid>")
    return _plain("Option<String>", f'column_type = "{_text(field["constraints"].get("maxLength"))}"')


def entity_file(context: AxumContext, resource: dict) -> dict | None:
    """The SeaORM entity of a resource: its table."""
    if not context.sea_orm:
        return None
    name = names(resource)
    uses = RsUses().add("sea_orm::entity::prelude::*")
    columns = []
    for field in resource["fields"]:
        column = _column_of(context, resource, field)
        is_key = field["name"] == resource["key"]["field"]
        attributes = [
            item
            for item in (
                is_key and "primary_key",
                is_key and resource["key"]["generated"] != "increment" and "auto_increment = false",
                column.attribute,
            )
            if item
        ]
        columns.append(
            lines(
                attributes and f"    #[sea_orm({', '.join(attributes)})]",
                f"    pub {field_name(field)}: {column.type},",
            )
        )
    content = lines(
        *rs_header(f"The {name['table']} table.", uses),
        rs_doc(f"A row of the {name['table']} table."),
        "#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]",
        f"#[sea_orm(table_name = {rs_string(name['table'])})]",
        "pub struct Model {",
        columns,
        "}",
        "",
        "#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]",
        "pub enum Relation {}",
        "",
        "impl ActiveModelBehavior for ActiveModel {}",
    )
    return {"path": module_path(context.layout.resource(resource, "entity")), "content": file_text(content)}


def repository_file(context: AxumContext, resource: dict) -> dict:
    name = names(resource)
    model = f"crate::{context.layout.resource(resource, 'model')}::{name['type']}"
    key = key_type(resource)
    key_name = field_name(key_field(resource))
    generated = resource["key"]["generated"]
    uses = RsUses().add(
        "async_trait::async_trait",
        model,
        "crate::common::error::ApiError",
        "crate::common::list::{ListQuery, ListResult}",
    )
    if key == "Uuid":
        uses.add("uuid::Uuid")
    filters = filter_fields(resource)
    filter_struct = [
        rs_doc(f"What a list of {resource['plural']} can filter by: a field that has a value must be equal to it."),
        "#[derive(Clone, Debug, Default)]",
        [
            f"pub struct {name['filters']} {{",
            [
                f"    pub {field_name(field)}: Option<{field_type(context, field, uses, resource)}>,"
                for field in filters
            ],
            "}",
        ]
        if filters
        else f"pub struct {name['filters']} {{}}",
    ]
    trait = [
        rs_doc(f"Where {resource['plural']} are kept. The service depends only on this trait."),
        "#[async_trait]",
        f"pub trait {name['repository']}: Send + Sync {{",
        "    /// Items equal to every filter, in order, within the window; and how many match.",
        f"    async fn list(&self, query: &ListQuery<{name['filters']}>) -> Result<ListResult<{name['type']}>, ApiError>;",
        "",
        "    /// The item with this key, or None when there is none.",
        f"    async fn get(&self, key: {key}) -> Result<Option<{name['type']}>, ApiError>;",
        "",
        f"    /// Stores a new item{' and assigns its key' if generated else ''}; returns it as stored.",
        f"    async fn add(&self, item: {name['type']}) -> Result<{name['type']}, ApiError>;",
        "",
        "    /// Stores the new state of an existing item and returns it.",
        f"    async fn update(&self, item: {name['type']}) -> Result<{name['type']}, ApiError>;",
        "",
        "    /// Removes an existing item.",
        f"    async fn delete(&self, key: {key}) -> Result<(), ApiError>;",
        "}",
    ]
    if context.pending:
        implementation = _pending(resource, name, key)
    elif not context.sea_orm:
        implementation = _memory(resource, name, key, key_name, generated, filters, uses)
    else:
        implementation = _sea_orm(context, resource, name, key, key_name, generated, filters, uses)
    content = lines(
        *rs_header(f"Where {resource['plural']} are kept.", uses), filter_struct, "", trait, "", implementation
    )
    return {"path": module_path(context.layout.resource(resource, "repository")), "content": file_text(content)}


def _pending(resource: dict, name: dict, key: str) -> list:
    message = rs_string(f"The storage of {resource['plural']} is not written yet")

    def method(signature: str) -> list[str]:
        return [
            f"    async fn {signature} {{",
            f"        // TODO: store {resource['plural']} in your database",
            f"        Err(ApiError::not_implemented({message}))",
            "    }",
        ]

    return [
        rs_doc(f"Storage of {resource['plural']} to write: every method answers 501 until it is implemented."),
        "#[derive(Default)]",
        f"pub struct {name['pendingRepository']};",
        "",
        "#[async_trait]",
        f"impl {name['repository']} for {name['pendingRepository']} {{",
        method(f"list(&self, _query: &ListQuery<{name['filters']}>) -> Result<ListResult<{name['type']}>, ApiError>"),
        "",
        method(f"get(&self, _key: {key}) -> Result<Option<{name['type']}>, ApiError>"),
        "",
        method(f"add(&self, _item: {name['type']}) -> Result<{name['type']}, ApiError>"),
        "",
        method(f"update(&self, _item: {name['type']}) -> Result<{name['type']}, ApiError>"),
        "",
        method(f"delete(&self, _key: {key}) -> Result<(), ApiError>"),
        "}",
    ]


def _new_key(key: str, key_name: str) -> str:
    return f"        item.{key_name} = {'Uuid::new_v4()' if key == 'Uuid' else 'uuid::Uuid::new_v4().to_string()'};"


def _memory(resource: dict, name: dict, key: str, key_name: str, generated, filters: list[dict], uses: RsUses) -> list:
    uses.add("std::collections::BTreeMap", "std::sync::Mutex")
    if generated == "increment":
        uses.add("std::sync::atomic::{AtomicI64, Ordering}")
    sorts = sort_fields(resource)
    if sorts:
        uses.add("crate::common::list::order_values")

    def value(field: dict, item: str) -> str:
        if field["name"] == resource["key"]["field"]:
            return f"&Some({item}.{field_name(field)}.clone())"
        return f"&{item}.{field_name(field)}"

    conditions = [
        f"filters.{field_name(field)}.as_ref().is_none_or(|value| &item.{field_name(field)} == value)"
        if field["name"] == resource["key"]["field"]
        else f"filters.{field_name(field)}.as_ref().is_none_or(|value| item.{field_name(field)}.as_ref() == Some(value))"
        for field in filters
    ]
    if generated == "increment":
        assign = f"        item.{key_name} = self.last_key.fetch_add(1, Ordering::SeqCst) + 1;"
    elif generated == "uuid":
        assign = _new_key(key, key_name)
    else:
        assign = False
    found = "mut " if sorts else ""
    return [
        rs_doc(
            f"Keeps {resource['plural']} in memory: they are lost when the application stops. Use it to try the API."
        ),
        "#[derive(Default)]",
        f"pub struct {name['memory']} {{",
        f"    items: Mutex<BTreeMap<{key}, {name['type']}>>,",
        generated == "increment" and "    last_key: AtomicI64,",
        "}",
        "",
        f"impl {name['memory']} {{",
        f"    fn items(&self) -> std::sync::MutexGuard<'_, BTreeMap<{key}, {name['type']}>> {{",
        "        self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner())",
        "    }",
        "}",
        "",
        rs_doc("Whether an item is equal to every filter that has a value."),
        [
            f"fn matches(item: &{name['type']}, filters: &{name['filters']}) -> bool {{",
            "    " + "\n        && ".join(conditions),
            "}",
        ]
        if conditions
        else f"fn matches(_item: &{name['type']}, _filters: &{name['filters']}) -> bool {{\n    true\n}}",
        "",
        "#[async_trait]",
        f"impl {name['repository']} for {name['memory']} {{",
        f"    async fn list(&self, query: &ListQuery<{name['filters']}>) -> Result<ListResult<{name['type']}>, ApiError> {{",
        f"        let {found}found: Vec<{name['type']}> = self.items().values().filter(|item| matches(item, &query.filters)).cloned().collect();",
        bool(sorts)
        and [
            "        // Items without a value go last, whatever the order; equal ones keep the order of their keys",
            "        match query.sort_field.as_deref() {",
            [
                f"            Some({rs_string(field['wire'])}) => found.sort_by(|a, b| order_values({value(field, 'a')}, {value(field, 'b')}, query.descending)),"
                for field in sorts
            ],
            "            _ => {}",
            "        }",
        ],
        "        let total = found.len() as u64;",
        "        let window = found.into_iter().skip(query.offset as usize).take(query.limit.map_or(usize::MAX, |limit| limit as usize)).collect();",
        "        Ok(ListResult { items: window, total })",
        "    }",
        "",
        f"    async fn get(&self, key: {key}) -> Result<Option<{name['type']}>, ApiError> {{",
        "        Ok(self.items().get(&key).cloned())",
        "    }",
        "",
        f"    async fn add(&self, {'mut ' if assign else ''}item: {name['type']}) -> Result<{name['type']}, ApiError> {{",
        assign,
        f"        self.items().insert(item.{key_name}.clone(), item.clone());",
        "        Ok(item)",
        "    }",
        "",
        f"    async fn update(&self, item: {name['type']}) -> Result<{name['type']}, ApiError> {{",
        f"        self.items().insert(item.{key_name}.clone(), item.clone());",
        "        Ok(item)",
        "    }",
        "",
        f"    async fn delete(&self, key: {key}) -> Result<(), ApiError> {{",
        "        self.items().remove(&key);",
        "        Ok(())",
        "    }",
        "}",
    ]


def _sea_orm(
    context: AxumContext,
    resource: dict,
    name: dict,
    key: str,
    key_name: str,
    generated,
    filters: list[dict],
    uses: RsUses,
) -> list:
    entity = f"crate::{context.layout.resource(resource, 'entity')}"
    uses.add(
        f"{entity} as entity",
        "sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryOrder, QuerySelect, Set}",
    )
    sorts = sort_fields(resource)
    if filters:
        uses.add("sea_orm::QueryFilter")
    # Comparisons and null checks on a column
    if filters or any(field["name"] != resource["key"]["field"] for field in sorts):
        uses.add("sea_orm::ColumnTrait")
    if sorts:
        uses.add("sea_orm::Order")
    if generated == "increment":
        uses.add("sea_orm::NotSet")
    columns = [(field, _column_of(context, resource, field)) for field in resource["fields"]]

    def column(field: dict) -> str:
        return f"entity::Column::{rs_pascal(field['wire'])}"

    for field in resource["fields"]:
        if field["type"]["kind"] == "enum" and not field.get("reference"):
            uses.add(f"crate::{context.layout.shared(field['type']['name'])}::{rs_type(field['type']['name'])}")
    filter_lines = [
        [
            f"        if let Some(value) = &query.filters.{field_name(field)} {{",
            f"            select = select.filter({column(field)}.eq({spec.match('value')}));",
            "        }",
        ]
        for field, spec in columns
        if field in filters
    ]
    assign = _new_key(key, key_name) if generated == "uuid" else False

    def order(field: dict) -> str:
        if field["name"] == resource["key"]["field"]:
            return f"            Some({rs_string(field['wire'])}) => select.order_by({column(field)}, order),"
        return (
            f"            Some({rs_string(field['wire'])}) => "
            f"select.order_by({column(field)}.is_null(), Order::Asc).order_by({column(field)}, order),"
        )

    return [
        rs_doc(f"Keeps {resource['plural']} in the database with SeaORM."),
        f"pub struct {name['seaOrmRepository']} {{",
        "    database: DatabaseConnection,",
        "}",
        "",
        f"impl {name['seaOrmRepository']} {{",
        "    pub fn new(database: DatabaseConnection) -> Self {",
        "        Self { database }",
        "    }",
        "}",
        "",
        rs_doc("The row of an item: every field in its column."),
        f"fn to_row(item: &{name['type']}) -> entity::ActiveModel {{",
        "    entity::ActiveModel {",
        [f"        {field_name(field)}: Set({spec.write(f'item.{field_name(field)}')})," for field, spec in columns],
        "    }",
        "}",
        "",
        f"fn to_item(row: entity::Model) -> {name['type']} {{",
        f"    {name['type']} {{",
        [f"        {field_name(field)}: {spec.read(f'row.{field_name(field)}')}," for field, spec in columns],
        "    }",
        "}",
        "",
        "#[async_trait]",
        f"impl {name['repository']} for {name['seaOrmRepository']} {{",
        f"    async fn list(&self, query: &ListQuery<{name['filters']}>) -> Result<ListResult<{name['type']}>, ApiError> {{",
        "        let mut select = entity::Entity::find();",
        filter_lines,
        "        let total = select.clone().count(&self.database).await?;",
        bool(sorts)
        and [
            "        let order = if query.descending { Order::Desc } else { Order::Asc };",
            "        // Items without a value go last, whatever the order; the key breaks ties",
            "        select = match query.sort_field.as_deref() {",
            [order(field) for field in sorts],
            "            _ => select,",
            "        };",
        ],
        f"        select = select.order_by_asc({column(key_field(resource))}).offset(query.offset);",
        "        if let Some(limit) = query.limit {",
        "            select = select.limit(limit);",
        "        }",
        "        let items = select.all(&self.database).await?.into_iter().map(to_item).collect();",
        "        Ok(ListResult { items, total })",
        "    }",
        "",
        f"    async fn get(&self, key: {key}) -> Result<Option<{name['type']}>, ApiError> {{",
        "        Ok(entity::Entity::find_by_id(key).one(&self.database).await?.map(to_item))",
        "    }",
        "",
        f"    async fn add(&self, {'mut ' if assign else ''}item: {name['type']}) -> Result<{name['type']}, ApiError> {{",
        assign,
        [
            "        let mut row = to_row(&item);",
            f"        row.{key_name} = NotSet;",
            "        Ok(to_item(row.insert(&self.database).await?))",
        ]
        if generated == "increment"
        else "        Ok(to_item(to_row(&item).insert(&self.database).await?))",
        "    }",
        "",
        f"    async fn update(&self, item: {name['type']}) -> Result<{name['type']}, ApiError> {{",
        "        Ok(to_item(to_row(&item).update(&self.database).await?))",
        "    }",
        "",
        f"    async fn delete(&self, key: {key}) -> Result<(), ApiError> {{",
        "        entity::Entity::delete_by_id(key).exec(&self.database).await?;",
        "        Ok(())",
        "    }",
        "}",
    ]
