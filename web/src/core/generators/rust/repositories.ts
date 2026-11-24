/**
 * The repositories of each table: the trait services depend on (when the settings want one), its database implementation
 * (its bodies are the strategy's, orm.ts), and its in-memory one, with the same methods. Repositories decide nothing.
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
import { nowOf, rsLiteral } from './values.ts'
import { RsUses } from './rust.ts'
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

/** The key of an entity known to be stored: `last.id.expect(…)`, or a tuple. */
export function keyValue(info: TableInfo, variable: string): string {
  const values = info.key.map((column) => stored(`${variable}.${column.field}`, column))
  return values.length === 1 ? values[0] : `(${values.join(', ')})`
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
  const { repository, label } = context.orm
  const uses = new RsUses().add(entityPath, DOMAIN_ERROR, 'crate::database::Db', ...repository.uses(context, info))
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
  const sqlBodies = methods.flatMap((item) =>
    block(item, repository.body(context, info, item, uses), interfaces ? '' : 'pub ', !interfaces),
  )
  body.push(
    `/// Keeps ${info.name} rows in the database, through ${label}: on the connection of the unit of work, or in its transaction.`,
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
    ...repository.helpers(context, info, methods, uses),
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
