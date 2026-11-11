/**
 * Storage of each resource in the Axum project: the repository trait the service depends on, the typed filters of
 * its lists, and the implementation of the chosen persistence:
 * - `memory`: a map behind a mutex, to run the API without a database
 * - `none`: every method answers 501, with a TODO where the storage goes
 * - `seaOrm`: a SeaORM entity and a repository with filters and sorting written for each field
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines, type Lines } from '../../common/text.ts'
import { RsUses, rsDoc, rsHeader, rsPascal, rsString, rsType } from '../../languages/rust/rust.ts'
import { field as fieldName, keyField, keyType, modulePath, names, type AxumContext } from './context.ts'
import { fieldType, storedAsJson } from './model.ts'

/** Whether a field can be filtered and sorted: plain values, enums and single references. */
export function queryable(field: SpecField): boolean {
  return !storedAsJson(field) && (field.type.kind === 'scalar' || field.type.kind === 'enum')
}

/** The fields the lists of a resource filter by. */
export function filterFields(resource: SpecResource): SpecField[] {
  const wires = new Set(resource.endpoints.flatMap((endpoint) => (endpoint.operation === 'list' ? endpoint.filters : [])))
  return resource.fields.filter((field) => wires.has(field.wire) && queryable(field))
}

/** The fields the lists of a resource sort by. */
export function sortFields(resource: SpecResource): SpecField[] {
  const wires = new Set(resource.endpoints.flatMap((endpoint) => (endpoint.operation === 'list' ? endpoint.sort : [])))
  return resource.fields.filter((field) => wires.has(field.wire) && queryable(field))
}

/** The column of a field in its entity: its Rust type and SeaORM attributes, and how values go in and out. */
function columnOf(context: AxumContext, resource: SpecResource, field: SpecField) {
  const mysql = context.settings.database === 'mysql' || context.settings.database === 'mariadb'
  const plain = (type: string, attribute: string | null = null) => ({
    type,
    attribute,
    write: (value: string) => `${value}.clone()`,
    read: (value: string) => value,
    match: (value: string) => `${value}.clone()`,
  })
  const text = (length?: number) => (length !== undefined && length <= 255 ? `String(StringLen::N(${length}))` : 'Text')
  const keyColumn = (target: SpecResource) => {
    if (target.key.type.scalar === 'integer') return { type: 'i64', attribute: null }
    if (target.key.type.scalar === 'uuid') return { type: 'Uuid', attribute: null }
    return { type: 'String', attribute: `column_type = "${text(keyField(target).constraints.maxLength ?? 191)}"` }
  }
  if (field.name === resource.key.field) {
    const key = keyColumn(resource)
    return plain(key.type, key.attribute)
  }
  if (storedAsJson(field))
    return {
      type: 'Option<String>',
      attribute: 'column_type = "Text"',
      write: (value: string) => `${value}.as_ref().map(|value| serde_json::to_string(value).unwrap_or_default())`,
      read: (value: string) => `${value}.and_then(|text| serde_json::from_str(&text).ok())`,
      match: (value: string) => value,
    }
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    const key = keyColumn(target)
    return plain(`Option<${key.type}>`, key.attribute)
  }
  const type = field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    const enumType = rsType(type.name)
    if (item.valueType === 'integer')
      return {
        type: 'Option<i64>',
        attribute: null,
        write: (value: string) => `${value}.map(|value| value.value())`,
        read: (value: string) => `${value}.and_then(${enumType}::from_value)`,
        match: (value: string) => `${value}.value()`,
      }
    return {
      type: 'Option<String>',
      attribute: 'column_type = "String(StringLen::N(64))"',
      write: (value: string) => `${value}.map(|value| value.value().to_string())`,
      read: (value: string) => `${value}.as_deref().and_then(${enumType}::from_value)`,
      match: (value: string) => `${value}.value()`,
    }
  }
  if (type.kind !== 'scalar') return plain('Option<String>', 'column_type = "Text"')
  switch (type.scalar) {
    case 'integer':
      return plain(`Option<${type.bits === 64 ? 'i64' : 'i32'}>`)
    case 'float':
      return plain('Option<f64>')
    case 'decimal':
      return plain('Option<Decimal>', 'column_type = "Decimal(Some((18, 4)))"')
    case 'boolean':
      return plain('Option<bool>')
    case 'date':
      return plain('Option<Date>')
    case 'datetime':
      // MySQL keeps date-times without a zone: they are stored in UTC
      return mysql
        ? {
            type: 'Option<DateTime>',
            attribute: 'column_type = "DateTime"',
            write: (value: string) => `${value}.map(|value| value.naive_utc())`,
            read: (value: string) => `${value}.map(|value| value.and_utc())`,
            match: (value: string) => `${value}.naive_utc()`,
          }
        : plain('Option<DateTimeUtc>')
    case 'uuid':
      return plain('Option<Uuid>')
    default:
      return plain('Option<String>', `column_type = "${text(field.constraints.maxLength)}"`)
  }
}

/** The SeaORM entity of a resource: its table. */
export function entityFile(context: AxumContext, resource: SpecResource): GeneratedFile | null {
  if (!context.seaOrm) return null
  const name = names(resource)
  const uses = new RsUses().add('sea_orm::entity::prelude::*')
  const columns = resource.fields.map((field) => {
    const column = columnOf(context, resource, field)
    const isKey = field.name === resource.key.field
    const attributes = [
      isKey && 'primary_key',
      isKey && resource.key.generated !== 'increment' && 'auto_increment = false',
      column.attribute,
    ].filter(Boolean)
    return lines(attributes.length > 0 && `    #[sea_orm(${attributes.join(', ')})]`, `    pub ${fieldName(field)}: ${column.type},`)
  })
  const content = lines(
    ...rsHeader(`The ${name.table} table.`, uses),
    rsDoc(`A row of the ${name.table} table.`),
    '#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]',
    `#[sea_orm(table_name = ${rsString(name.table)})]`,
    'pub struct Model {',
    columns,
    '}',
    '',
    '#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]',
    'pub enum Relation {}',
    '',
    'impl ActiveModelBehavior for ActiveModel {}',
  )
  return { path: modulePath(context.layout.resource(resource, 'entity')), content: fileText(content) }
}

export function repositoryFile(context: AxumContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const model = `crate::${context.layout.resource(resource, 'model')}::${name.type}`
  const key = keyType(resource)
  const keyName = fieldName(keyField(resource))
  const generated = resource.key.generated
  const uses = new RsUses().add(
    'async_trait::async_trait',
    model,
    'crate::common::error::ApiError',
    'crate::common::list::{ListQuery, ListResult}',
  )
  if (key === 'Uuid') uses.add('uuid::Uuid')
  const filters = filterFields(resource)
  const filterStruct = [
    rsDoc(`What a list of ${resource.plural} can filter by: a field that has a value must be equal to it.`),
    '#[derive(Clone, Debug, Default)]',
    filters.length > 0
      ? [
          `pub struct ${name.filters} {`,
          filters.map((field) => `    pub ${fieldName(field)}: Option<${fieldType(context, field, uses, resource)}>,`),
          '}',
        ]
      : `pub struct ${name.filters} {}`,
  ]
  const trait = [
    rsDoc(`Where ${resource.plural} are kept. The service depends only on this trait.`),
    '#[async_trait]',
    `pub trait ${name.repository}: Send + Sync {`,
    '    /// Items equal to every filter, in order, within the window; and how many match.',
    `    async fn list(&self, query: &ListQuery<${name.filters}>) -> Result<ListResult<${name.type}>, ApiError>;`,
    '',
    '    /// The item with this key, or None when there is none.',
    `    async fn get(&self, key: ${key}) -> Result<Option<${name.type}>, ApiError>;`,
    '',
    `    /// Stores a new item${generated ? ' and assigns its key' : ''}; returns it as stored.`,
    `    async fn add(&self, item: ${name.type}) -> Result<${name.type}, ApiError>;`,
    '',
    '    /// Stores the new state of an existing item and returns it.',
    `    async fn update(&self, item: ${name.type}) -> Result<${name.type}, ApiError>;`,
    '',
    '    /// Removes an existing item.',
    `    async fn delete(&self, key: ${key}) -> Result<(), ApiError>;`,
    '}',
  ]
  let implementation: Lines[]
  if (context.pending) {
    const message = rsString(`The storage of ${resource.plural} is not written yet`)
    const method = (signature: string) => [
      `    async fn ${signature} {`,
      `        // TODO: store ${resource.plural} in your database`,
      `        Err(ApiError::not_implemented(${message}))`,
      '    }',
    ]
    implementation = [
      rsDoc(`Storage of ${resource.plural} to write: every method answers 501 until it is implemented.`),
      '#[derive(Default)]',
      `pub struct ${name.pendingRepository};`,
      '',
      '#[async_trait]',
      `impl ${name.repository} for ${name.pendingRepository} {`,
      method(`list(&self, _query: &ListQuery<${name.filters}>) -> Result<ListResult<${name.type}>, ApiError>`),
      '',
      method(`get(&self, _key: ${key}) -> Result<Option<${name.type}>, ApiError>`),
      '',
      method(`add(&self, _item: ${name.type}) -> Result<${name.type}, ApiError>`),
      '',
      method(`update(&self, _item: ${name.type}) -> Result<${name.type}, ApiError>`),
      '',
      method(`delete(&self, _key: ${key}) -> Result<(), ApiError>`),
      '}',
    ]
  } else if (!context.seaOrm) {
    uses.add('std::collections::BTreeMap', 'std::sync::Mutex')
    if (generated === 'increment') uses.add('std::sync::atomic::{AtomicI64, Ordering}')
    const sorts = sortFields(resource)
    if (sorts.length > 0) uses.add('crate::common::list::order_values')
    const value = (field: SpecField, item: string) =>
      field.name === resource.key.field ? `&Some(${item}.${fieldName(field)}.clone())` : `&${item}.${fieldName(field)}`
    const conditions = filters.map((field) =>
      field.name === resource.key.field
        ? `filters.${fieldName(field)}.as_ref().is_none_or(|value| &item.${fieldName(field)} == value)`
        : `filters.${fieldName(field)}.as_ref().is_none_or(|value| item.${fieldName(field)}.as_ref() == Some(value))`,
    )
    const assign =
      generated === 'increment'
        ? `        item.${keyName} = self.last_key.fetch_add(1, Ordering::SeqCst) + 1;`
        : generated === 'uuid'
          ? `        item.${keyName} = ${key === 'Uuid' ? 'Uuid::new_v4()' : 'uuid::Uuid::new_v4().to_string()'};`
          : false
    implementation = [
      rsDoc(`Keeps ${resource.plural} in memory: they are lost when the application stops. Use it to try the API.`),
      '#[derive(Default)]',
      `pub struct ${name.memory} {`,
      `    items: Mutex<BTreeMap<${key}, ${name.type}>>,`,
      generated === 'increment' && '    last_key: AtomicI64,',
      '}',
      '',
      `impl ${name.memory} {`,
      `    fn items(&self) -> std::sync::MutexGuard<'_, BTreeMap<${key}, ${name.type}>> {`,
      '        self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner())',
      '    }',
      '}',
      '',
      rsDoc('Whether an item is equal to every filter that has a value.'),
      conditions.length > 0
        ? [`fn matches(item: &${name.type}, filters: &${name.filters}) -> bool {`, `    ${conditions.join('\n        && ')}`, '}']
        : `fn matches(_item: &${name.type}, _filters: &${name.filters}) -> bool {\n    true\n}`,
      '',
      '#[async_trait]',
      `impl ${name.repository} for ${name.memory} {`,
      `    async fn list(&self, query: &ListQuery<${name.filters}>) -> Result<ListResult<${name.type}>, ApiError> {`,
      `        let ${sorts.length > 0 ? 'mut ' : ''}found: Vec<${name.type}> = self.items().values().filter(|item| matches(item, &query.filters)).cloned().collect();`,
      sorts.length > 0 && [
        '        // Items without a value go last, whatever the order; equal ones keep the order of their keys',
        '        match query.sort_field.as_deref() {',
        sorts.map(
          (field) =>
            `            Some(${rsString(field.wire)}) => found.sort_by(|a, b| order_values(${value(field, 'a')}, ${value(field, 'b')}, query.descending)),`,
        ),
        '            _ => {}',
        '        }',
      ],
      '        let total = found.len() as u64;',
      '        let window = found.into_iter().skip(query.offset as usize).take(query.limit.map_or(usize::MAX, |limit| limit as usize)).collect();',
      '        Ok(ListResult { items: window, total })',
      '    }',
      '',
      `    async fn get(&self, key: ${key}) -> Result<Option<${name.type}>, ApiError> {`,
      '        Ok(self.items().get(&key).cloned())',
      '    }',
      '',
      `    async fn add(&self, ${assign ? 'mut ' : ''}item: ${name.type}) -> Result<${name.type}, ApiError> {`,
      assign,
      `        self.items().insert(item.${keyName}.clone(), item.clone());`,
      '        Ok(item)',
      '    }',
      '',
      `    async fn update(&self, item: ${name.type}) -> Result<${name.type}, ApiError> {`,
      `        self.items().insert(item.${keyName}.clone(), item.clone());`,
      '        Ok(item)',
      '    }',
      '',
      `    async fn delete(&self, key: ${key}) -> Result<(), ApiError> {`,
      '        self.items().remove(&key);',
      '        Ok(())',
      '    }',
      '}',
    ]
  } else {
    const entity = `crate::${context.layout.resource(resource, 'entity')}`
    uses.add(
      `${entity} as entity`,
      'sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryOrder, QuerySelect, Set}',
    )
    const sorts = sortFields(resource)
    if (filters.length > 0) uses.add('sea_orm::QueryFilter')
    // Comparisons and null checks on a column
    if (filters.length > 0 || sorts.some((field) => field.name !== resource.key.field)) uses.add('sea_orm::ColumnTrait')
    if (sorts.length > 0) uses.add('sea_orm::Order')
    if (generated === 'increment') uses.add('sea_orm::NotSet')
    const columns = resource.fields.map((field) => ({ field, ...columnOf(context, resource, field) }))
    const column = (field: SpecField) => `entity::Column::${rsPascal(field.wire)}`
    for (const field of resource.fields) {
      if (field.type.kind === 'enum' && !field.reference)
        uses.add(`crate::${context.layout.shared(field.type.name)}::${rsType(field.type.name)}`)
    }
    const filterLines = columns
      .filter(({ field }) => filters.includes(field))
      .map(({ field, match }) => [
        `        if let Some(value) = &query.filters.${fieldName(field)} {`,
        `            select = select.filter(${column(field)}.eq(${match('value')}));`,
        '        }',
      ])
    const assign =
      generated === 'uuid' ? `        item.${keyName} = ${key === 'Uuid' ? 'Uuid::new_v4()' : 'uuid::Uuid::new_v4().to_string()'};` : false
    implementation = [
      rsDoc(`Keeps ${resource.plural} in the database with SeaORM.`),
      `pub struct ${name.seaOrmRepository} {`,
      '    database: DatabaseConnection,',
      '}',
      '',
      `impl ${name.seaOrmRepository} {`,
      '    pub fn new(database: DatabaseConnection) -> Self {',
      '        Self { database }',
      '    }',
      '}',
      '',
      rsDoc('The row of an item: every field in its column.'),
      `fn to_row(item: &${name.type}) -> entity::ActiveModel {`,
      '    entity::ActiveModel {',
      columns.map(({ field, write }) => `        ${fieldName(field)}: Set(${write(`item.${fieldName(field)}`)}),`),
      '    }',
      '}',
      '',
      `fn to_item(row: entity::Model) -> ${name.type} {`,
      `    ${name.type} {`,
      columns.map(({ field, read }) => `        ${fieldName(field)}: ${read(`row.${fieldName(field)}`)},`),
      '    }',
      '}',
      '',
      '#[async_trait]',
      `impl ${name.repository} for ${name.seaOrmRepository} {`,
      `    async fn list(&self, query: &ListQuery<${name.filters}>) -> Result<ListResult<${name.type}>, ApiError> {`,
      '        let mut select = entity::Entity::find();',
      filterLines,
      '        let total = select.clone().count(&self.database).await?;',
      sorts.length > 0 && [
        '        let order = if query.descending { Order::Desc } else { Order::Asc };',
        '        // Items without a value go last, whatever the order; the key breaks ties',
        '        select = match query.sort_field.as_deref() {',
        sorts.map((field) =>
          field.name === resource.key.field
            ? `            Some(${rsString(field.wire)}) => select.order_by(${column(field)}, order),`
            : `            Some(${rsString(field.wire)}) => select.order_by(${column(field)}.is_null(), Order::Asc).order_by(${column(field)}, order),`,
        ),
        '            _ => select,',
        '        };',
      ],
      `        select = select.order_by_asc(${column(keyField(resource))}).offset(query.offset);`,
      '        if let Some(limit) = query.limit {',
      '            select = select.limit(limit);',
      '        }',
      '        let items = select.all(&self.database).await?.into_iter().map(to_item).collect();',
      '        Ok(ListResult { items, total })',
      '    }',
      '',
      `    async fn get(&self, key: ${key}) -> Result<Option<${name.type}>, ApiError> {`,
      '        Ok(entity::Entity::find_by_id(key).one(&self.database).await?.map(to_item))',
      '    }',
      '',
      `    async fn add(&self, ${assign ? 'mut ' : ''}item: ${name.type}) -> Result<${name.type}, ApiError> {`,
      assign,
      generated === 'increment'
        ? [
            '        let mut row = to_row(&item);',
            `        row.${keyName} = NotSet;`,
            '        Ok(to_item(row.insert(&self.database).await?))',
          ]
        : '        Ok(to_item(to_row(&item).insert(&self.database).await?))',
      '    }',
      '',
      `    async fn update(&self, item: ${name.type}) -> Result<${name.type}, ApiError> {`,
      '        Ok(to_item(to_row(&item).update(&self.database).await?))',
      '    }',
      '',
      `    async fn delete(&self, key: ${key}) -> Result<(), ApiError> {`,
      '        entity::Entity::delete_by_id(key).exec(&self.database).await?;',
      '        Ok(())',
      '    }',
      '}',
    ]
  }
  const content = lines(...rsHeader(`Where ${resource.plural} are kept.`, uses), filterStruct, '', trait, '', implementation)
  return { path: modulePath(context.layout.resource(resource, 'repository')), content: fileText(content) }
}
