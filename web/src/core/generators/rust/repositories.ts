/**
 * The repositories of each table: the trait services depend on (when the settings want one), its SeaORM
 * implementation (queries on the table's entity, run on the connection or the transaction of the unit of work, models
 * turned into entities, a database refusal turned into a Conflict, what the database fills read back after an
 * insert), and its in-memory one, with the same methods. Repositories decide nothing.
 */
import type { QueryDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import {
  columnOf,
  fileOf,
  keyType,
  memoryRepository,
  moduleOf,
  pathIn,
  queryName,
  repositoryTrait,
  rsFile,
  sqlRepository,
  stored,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { nowOf, rsLiteral } from './entities.ts'
import { RsUses, rsString } from './rust.ts'
import { COMMON, DOMAIN_ERROR } from './support.ts'

export interface Method {
  query: QueryDesign
  name: string
  params: { name: string; type: string }[]
  returns: string
  doc: string
}

/** The methods of a table's repository, with their Rust signatures (the result type without `Result`). */
export function repositoryMethods(context: Context, info: TableInfo, uses: RsUses): Method[] {
  const entity = info.entity
  const methods: Method[] = []
  for (const query of info.queries) {
    const name = queryName(context, query)
    const byColumns = query.columns.map((column) => {
      const item = columnOf(info, column)
      return { name: item.field, type: item.rs }
    })
    const add = (params: Method['params'], returns: string, doc: string) => methods.push({ query, name, params, returns, doc })
    switch (query.kind) {
      case 'getByKey':
        add(byColumns, `Option<${entity}>`, 'The row with this primary key, or None.')
        break
      case 'findByUnique':
        add(byColumns, `Option<${entity}>`, `The row with this ${query.columns.join(' and ')}, or None.`)
        break
      case 'listByParent':
      case 'findAllBy':
        add(byColumns, `Vec<${entity}>`, `Rows with this ${query.columns.join(' and ')}, by primary key.`)
        break
      case 'list':
        if (context.settings.paging === 'offset') {
          uses.add(`${COMMON}::Page`)
          add(
            [
              { name: 'offset', type: 'u64' },
              { name: 'limit', type: 'u64' },
            ],
            `Page<${entity}>`,
            'At most limit rows from offset, by primary key, and how many there are.',
          )
        } else if (context.settings.paging === 'cursor') {
          uses.add(`${COMMON}::CursorPage`)
          add(
            [
              { name: 'after', type: `Option<${keyType(info)}>` },
              { name: 'limit', type: 'u64' },
            ],
            `CursorPage<${entity}, ${keyType(info)}>`,
            'At most limit rows after the key after (None for the first page), by primary key, and the key to read the next page from.',
          )
        } else add([], `Vec<${entity}>`, 'Every row, by primary key.')
        break
      case 'insert':
        add([{ name: 'entity', type: entity }], entity, 'Stores a new row; the values the database fills are read back.')
        break
      case 'update':
        add([{ name: 'entity', type: entity }], entity, 'Stores the changes made to a row.')
        break
      case 'delete':
        add([{ name: 'entity', type: `&${entity}` }], '()', 'Removes a row.')
        break
    }
  }
  return methods
}

const signature = (method: Method) =>
  `async fn ${method.name}(&self${method.params.map((param) => `, ${param.name}: ${param.type}`).join('')}) -> Result<${method.returns}, DomainError>`

// SeaORM

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

/** The key of an entity known to be stored: `last.id.expect(…)`, or a tuple. */
function keyValue(info: TableInfo, variable: string): string {
  const values = info.key.map((column) => stored(`${variable}.${column.field}`, column))
  return values.length === 1 ? values[0] : `(${values.join(', ')})`
}

const toEntities = '.into_iter().map(to_entity).collect()'

function seaBody(context: Context, info: TableInfo, method: Method, uses: RsUses): string[] {
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
function seaHelpers(info: TableInfo, methods: Method[], uses: RsUses): string[] {
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

// In memory

function memoryFill(column: ColumnInfo): string | null {
  const db = column.column
  const target = `entity.${column.field}`
  if (db.generated === 'identity') {
    const value = column.rs === 'i64' ? '*next' : `*next as ${column.rs}`
    return `${target} = ${target}.or_else(|| {\n    let mut next = self.next_id.lock().unwrap();\n    *next += 1;\n    Some(${value})\n});`
  }
  if (db.generated === 'uuid') return `${target} = ${target}.or_else(|| Some(uuid::Uuid::new_v4()));`
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    const now = nowOf(column)
    return now ? `${target} = ${target}.or_else(|| Some(${now}));` : null
  }
  if (db.default?.kind === 'literal' && db.default.value !== null)
    return `${target} = ${target}.or_else(|| Some(${rsLiteral(column, db.default.value)}));`
  return null
}

function memoryVisible(info: TableInfo): string {
  if (!info.soft) return ''
  return info.soft.column.type.kind === 'boolean'
    ? `.filter(|row| row.${info.soft.field} != Some(true))`
    : `.filter(|row| row.${info.soft.field}.is_none())`
}

function memoryBody(context: Context, info: TableInfo, method: Method): string[] {
  const conditions = method.query.columns
    .map((name) => columnOf(info, name).field)
    .map((field) => `row.${field}.as_ref() == Some(&${field})`)
    .join(' && ')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`Ok(self.visible().into_iter().find(|row| ${conditions}))`]
    case 'listByParent':
    case 'findAllBy':
      return [`Ok(self.visible().into_iter().filter(|row| ${conditions}).collect())`]
    case 'list':
      if (context.settings.paging === 'offset')
        return [
          'let rows = self.visible();',
          'let total = rows.len() as u64;',
          'Ok(Page { items: rows.into_iter().skip(offset as usize).take(limit as usize).collect(), total, offset, limit })',
        ]
      if (context.settings.paging === 'cursor') {
        const names = info.key.map((_, index) => `after${index}`)
        const wrap =
          info.key.length === 1
            ? 'after.map(|after| (Some(after),))'
            : `after.map(|(${names.join(', ')})| (${names.map((name) => `Some(${name})`).join(', ')}))`
        return [
          `let after = ${wrap};`,
          'let rows: Vec<_> = self',
          '    .visible()',
          '    .into_iter()',
          '    .filter(|row| after.as_ref().is_none_or(|after| key_of(row).partial_cmp(after) == Some(Ordering::Greater)))',
          '    .collect();',
          'let more = rows.len() as u64 > limit;',
          `let items: Vec<${info.entity}> = rows.into_iter().take(limit as usize).collect();`,
          `let next = if more { items.last().map(|last| ${keyValue(info, 'last')}) } else { None };`,
          'Ok(CursorPage { items, next })',
        ]
      }
      return ['Ok(self.visible())']
    case 'insert':
    case 'update':
      return ['self.store(&entity);', 'Ok(entity)']
    case 'delete':
      return ['self.rows.lock().unwrap().retain(|row| key_of(row) != key_of(entity));', 'Ok(())']
    default:
      return ['unimplemented!()']
  }
}

function block(method: Method, body: string[], prefix: string, doc: boolean): string[] {
  return [
    '',
    ...(doc ? [`    /// ${method.doc}`] : []),
    `    ${prefix}${signature(method)} {`,
    ...body.flatMap((line) => line.split('\n')).map((line) => `        ${line}`),
    '    }',
  ]
}

export function repositoryFile(context: Context, info: TableInfo): GeneratedFile {
  const module = moduleOf(context, info, 'repository')
  const entityPath = pathIn(moduleOf(context, info, 'entity'), info.entity)
  const interfaces = context.settings.repositoryInterfaces
  const uses = new RsUses().add(entityPath, DOMAIN_ERROR, 'crate::database::Db', `${moduleOf(context, info, 'table')} as table`)
  const methods = repositoryMethods(context, info, uses)
  if (interfaces) uses.add('async_trait::async_trait')
  const body: string[] = []
  if (interfaces)
    body.push(
      `/// Where ${info.name} rows are kept. Services depend only on this trait.`,
      '#[async_trait]',
      `pub trait ${repositoryTrait(info)}: Send + Sync {`,
      ...methods.flatMap((item, index) => [...(index > 0 ? [''] : []), `    /// ${item.doc}`, `    ${signature(item)};`]),
      '}',
      '',
    )
  const sqlBodies = methods.flatMap((item) => block(item, seaBody(context, info, item, uses), interfaces ? '' : 'pub ', !interfaces))
  body.push(
    `/// Keeps ${info.name} rows in the database, through SeaORM: on the connection of the unit of work, or in its transaction.`,
    `pub struct ${sqlRepository(info)}<'a> {`,
    "    db: &'a Db,",
    '}',
    '',
    `impl<'a> ${sqlRepository(info)}<'a> {`,
    "    pub fn new(db: &'a Db) -> Self {",
    '        Self { db }',
    '    }',
    ...(interfaces
      ? ['}', '', '#[async_trait]', `impl ${repositoryTrait(info)} for ${sqlRepository(info)}<'_> {`, ...sqlBodies.slice(1)]
      : sqlBodies),
    '}',
    ...seaHelpers(info, methods, uses),
  )
  if (context.settings.memoryRepositories) {
    uses.add('std::sync::Arc', 'std::sync::Mutex')
    const fills = info.columns.map(memoryFill).filter((line): line is string => line !== null)
    const kinds = new Set(methods.map((method) => method.query.kind))
    const reads = ['getByKey', 'findByUnique', 'listByParent', 'findAllBy', 'list'].some((kind) => kinds.has(kind as never))
    const stores = kinds.has('insert') || kinds.has('update')
    const cursor = kinds.has('list') && context.settings.paging === 'cursor'
    if (reads || cursor) uses.add('std::cmp::Ordering')
    const identity = info.columns.some((column) => column.column.generated === 'identity')
    const memoryBodies = methods.flatMap((item) => {
      const lines = memoryBody(context, info, item)
      return block(
        item,
        item.query.kind === 'insert' && fills.length > 0 ? ['let mut entity = entity;', ...fills, ...lines] : lines,
        '',
        false,
      )
    })
    const keyTypes = info.key.map((column) => `Option<${column.rs}>`)
    body.push(
      '',
      `/// Keeps ${info.name} rows in memory, for tests and for trying the services without a database. Its copies share the rows.`,
      '#[derive(Clone, Default)]',
      `pub struct ${memoryRepository(info)} {`,
      `    rows: Arc<Mutex<Vec<${info.entity}>>>,`,
      ...(identity ? ['    next_id: Arc<Mutex<i64>>,'] : []),
      '}',
      '',
      `impl ${memoryRepository(info)} {`,
      ...(reads
        ? [
            '    /// The rows reads see, by primary key.',
            `    fn visible(&self) -> Vec<${info.entity}> {`,
            `        let mut rows: Vec<${info.entity}> = self.rows.lock().unwrap().iter()${memoryVisible(info)}.cloned().collect();`,
            '        rows.sort_by(|a, b| key_of(a).partial_cmp(&key_of(b)).unwrap_or(Ordering::Equal));',
            '        rows',
            '    }',
          ]
        : []),
      ...(stores
        ? [
            ...(reads ? [''] : []),
            '    /// Keeps a row, in place of the one with its key.',
            `    fn store(&self, entity: &${info.entity}) {`,
            '        let mut rows = self.rows.lock().unwrap();',
            '        rows.retain(|row| key_of(row) != key_of(entity));',
            '        rows.push(entity.clone());',
            '    }',
          ]
        : []),
      '}',
      '',
      '/// The key of a row, as a tuple of its key values.',
      `fn key_of(row: &${info.entity}) -> (${keyTypes.join(', ')}${keyTypes.length === 1 ? ',' : ''}) {`,
      `    (${info.key.map((column) => (column.copy ? `row.${column.field}` : `row.${column.field}.clone()`)).join(', ')}${info.key.length === 1 ? ',' : ''})`,
      '}',
      '',
      '#[async_trait]',
      `impl ${repositoryTrait(info)} for ${memoryRepository(info)} {`,
      ...memoryBodies.slice(1),
      '}',
    )
  }
  return rsFile(fileOf(module), uses.write(), body, [`The repositories of the "${info.name}" table. Repositories decide nothing.`])
}
