/**
 * The SeaORM repositories: queries on the table's entity, run on the connection or the transaction of the unit of work,
 * models turned into entities, a database refusal turned into a Conflict, what the database fills read back after an insert.
 */
import { columnOf, stored, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { keyValue, type Method } from '../repositories.ts'
import { rsString, type RsUses } from '../rust.ts'

const col = (column: ColumnInfo) => `table::Column::${column.variant}`

/** The filter that leaves out rows marked as deleted. */
function softFilter(info: TableInfo, uses: RsUses): string {
  if (!info.soft) return ''
  if (info.soft.column.type.kind !== 'boolean') return `.filter(${col(info.soft)}.is_null())`
  uses.add('sea_orm::Condition')
  return `.filter(Condition::any().add(${col(info.soft)}.eq(false)).add(${col(info.soft)}.is_null()))`
}

/** The columns written by an insert: not those the database fills (uuids are made first). */
const insertColumns = (info: TableInfo) =>
  info.columns.filter((column) => column.column.generated === undefined || column.column.generated === 'uuid')

/** The columns written by an update: not the key, nor those the database fills. */
const updateColumns = (info: TableInfo) =>
  info.columns.filter((column) => column.column.generated === undefined && !info.key.includes(column))

/** The filters of a row, by the key of an entity. */
const keyFilter = (info: TableInfo) =>
  info.key.map((column) => `.filter(${col(column)}.eq(${stored(`entity.${column.field}`, column)}))`).join('')

function orderBy(info: TableInfo, uses: RsUses): string {
  uses.add('sea_orm::QueryOrder')
  return info.key.map((column) => `.order_by_asc(${col(column)})`).join('')
}

const toEntities = '.into_iter().map(to_entity).collect()'

export function seaBody(context: Context, info: TableInfo, method: Method, uses: RsUses): string[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softFilter(info, uses)
  const byColumns = () => {
    uses.add('sea_orm::QueryFilter', 'sea_orm::ColumnTrait')
    return columns.map((column) => `.filter(${col(column)}.eq(${column.field}))`).join('')
  }
  const db = 'let db = self.db.executor();'
  if (soft) uses.add('sea_orm::QueryFilter', 'sea_orm::ColumnTrait')
  // Every query but an update starts from the table's entity
  if (method.query.kind !== 'update') uses.add('sea_orm::EntityTrait')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [db, `Ok(table::Entity::find()${byColumns()}${soft}.one(&db).await?.map(to_entity))`]
    case 'listByParent':
    case 'findAllBy':
      return [db, `Ok(table::Entity::find()${byColumns()}${soft}${orderBy(info, uses)}.all(&db).await?${toEntities})`]
    case 'list': {
      if (context.settings.paging === 'offset') {
        uses.add('sea_orm::PaginatorTrait', 'sea_orm::QuerySelect')
        return [
          db,
          `let total = table::Entity::find()${soft}.count(&db).await?;`,
          `let rows = table::Entity::find()${soft}${orderBy(info, uses)}.offset(offset).limit(limit).all(&db).await?;`,
          `Ok(Page { items: rows${toEntities}, total, offset, limit })`,
        ]
      }
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        uses.add('sea_orm::QuerySelect', 'sea_orm::QueryFilter', 'sea_orm::ColumnTrait')
        const multi = info.key.length > 1
        const after = (index: number) => (multi ? `after${index}.clone()` : 'after')
        let condition: string
        if (!multi) condition = `${col(info.key[0])}.gt(after)`
        else {
          uses.add('sea_orm::Condition')
          const terms = info.key.map((column, index) => {
            const parts = [
              ...info.key.slice(0, index).map((before, position) => `.add(${col(before)}.eq(${after(position)}))`),
              `.add(${col(column)}.gt(${after(index)}))`,
            ]
            return index === 0 ? `${col(column)}.gt(${after(index)})` : `Condition::all()${parts.join('')}`
          })
          condition = `Condition::any()${terms.map((term) => `.add(${term})`).join('')}`
        }
        return [
          db,
          `let mut query = table::Entity::find()${soft};`,
          'if let Some(after) = after {',
          ...(multi ? [`    let (${info.key.map((_, index) => `after${index}`).join(', ')}) = after;`] : []),
          `    query = query.filter(${condition});`,
          '}',
          `let rows = query${orderBy(info, uses)}.limit(limit + 1).all(&db).await?;`,
          'let more = rows.len() as u64 > limit;',
          `let items: Vec<${info.entity}> = rows.into_iter().take(limit as usize).map(to_entity).collect();`,
          `let next = if more { items.last().map(|last| ${keyValue(info, 'last')}) } else { None };`,
          'Ok(CursorPage { items, next })',
        ]
      }
      return [db, `Ok(table::Entity::find()${soft}${orderBy(info, uses)}.all(&db).await?${toEntities})`]
    }
    case 'insert': {
      uses.add('sea_orm::ActiveValue')
      const uuids = info.columns.filter((column) => column.column.generated === 'uuid')
      return [
        ...(uuids.length > 0 ? ['let mut entity = entity;'] : []),
        ...uuids.map((column) => `entity.${column.field} = entity.${column.field}.or_else(|| Some(uuid::Uuid::new_v4()));`),
        db,
        'let model = table::ActiveModel {',
        ...insertColumns(info).map((column) =>
          column.column.nullable
            ? `    ${column.field}: entity.${column.field}.map_or(ActiveValue::NotSet, |value| ActiveValue::Set(Some(value))),`
            : `    ${column.field}: entity.${column.field}.map_or(ActiveValue::NotSet, ActiveValue::Set),`,
        ),
        '    ..Default::default()',
        '};',
        // What the database filled is read back with the row
        'let stored = table::Entity::insert(model).exec_with_returning(&db).await.map_err(refused)?;',
        'Ok(to_entity(stored))',
      ]
    }
    case 'update': {
      const changing = updateColumns(info)
      if (changing.length === 0) return ['// Nothing of it can change', 'Ok(entity)']
      uses.add('sea_orm::ActiveValue', 'sea_orm::ActiveModelTrait')
      return [
        db,
        'let model = table::ActiveModel {',
        ...info.key.map((column) => `    ${column.field}: ActiveValue::Unchanged(${stored(`entity.${column.field}`, column)}),`),
        ...changing.map((column) =>
          column.column.nullable
            ? `    ${column.field}: ActiveValue::Set(${column.copy ? `entity.${column.field}` : `entity.${column.field}.clone()`}),`
            : `    ${column.field}: ${column.copy ? `entity.${column.field}` : `entity.${column.field}.clone()`}.map_or(ActiveValue::NotSet, ActiveValue::Set),`,
        ),
        '    ..Default::default()',
        '};',
        'let stored = model.update(&db).await.map_err(refused)?;',
        'Ok(to_entity(stored))',
      ]
    }
    case 'delete':
      uses.add('sea_orm::QueryFilter', 'sea_orm::ColumnTrait')
      return [db, `table::Entity::delete_many()${keyFilter(info)}.exec(&db).await.map_err(refused)?;`, 'Ok(())']
    default:
      return ['unimplemented!()']
  }
}

/** to_entity and refused: how models become entities, and how a refusal of the database becomes a Conflict. */
export function seaHelpers(_context: Context, info: TableInfo, methods: Method[], uses: RsUses): string[] {
  const reads = methods.some((method) => method.query.kind !== 'delete')
  const writes = methods.some((method) => ['insert', 'update', 'delete'].includes(method.query.kind))
  if (writes) uses.add('sea_orm::DbErr')
  return [
    ...(reads
      ? [
          '',
          `fn to_entity(model: table::Model) -> ${info.entity} {`,
          `    ${info.entity} {`,
          ...info.columns.map(
            (column) => `        ${column.field}: ${column.column.nullable ? `model.${column.field}` : `Some(model.${column.field})`},`,
          ),
          '    }',
          '}',
        ]
      : []),
    ...(writes
      ? [
          '',
          '/// A refusal of the database (a unique value, a row still pointed to) becomes a Conflict.',
          'fn refused(error: DbErr) -> DomainError {',
          '    if error.sql_err().is_some() {',
          `        DomainError::conflict(${rsString(info.entity)}, &format!("the database refused the change: {error}"), &[])`,
          '    } else {',
          '        error.into()',
          '    }',
          '}',
        ]
      : []),
  ]
}
