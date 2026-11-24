/**
 * The service of each table: its operations and what each one checks before it writes, in the order of the design
 * (docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
 * version; then children and soft deletes. The values of a create or an update are gathered in a `Values` struct of
 * the fields given (None when not given, Some(None) when given empty), so every way an update can come is checked and
 * applied the same way. Writes run in a transaction of the unit of work when the settings say so; errors are
 * DomainError values without HTTP codes. Rust refuses private code nobody calls, so only the helpers the operations use
 * are written.
 */
import type { OperationDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { DbCheck } from '../../schema/types.ts'
import {
  columnOf,
  fileOf,
  findInfo,
  keyType,
  moduleOf,
  operationName,
  pathIn,
  query,
  queryName,
  rsFile,
  serviceType,
  stored,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, readColumns, readDto, updateColumns, updatePath, updateStruct, updateType } from './dtos.ts'
import { nowOf } from './values.ts'
import { RsUses, rsString, snakeName } from './rust.ts'
import { COMMON, DOMAIN_ERROR, ERRORS, UNIT_OF_WORK } from './support.ts'

type Helper = 'find' | 'read' | 'checkValues' | 'apply' | 'given'

interface Writer {
  context: Context
  info: TableInfo
  uses: RsUses
  dtos: boolean
  used: Set<Helper>
}

const ind = (items: string[], spaces = 4) => items.map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
const repo = (info: TableInfo) => `uow.${info.attr}()`
/** A value passed on, cloned when it is not Copy so it can be used again. */
const pass = (column: ColumnInfo) => (column.copy ? column.field : `${column.field}.clone()`)
const keyParams = (info: TableInfo) => info.key.map((column) => `${column.field}: ${column.rs}`).join(', ')
const keyArgs = (info: TableInfo) => info.key.map((column) => column.field).join(', ')
const keyValue = (info: TableInfo) => (info.key.length === 1 ? info.key[0].field : `(${keyArgs(info)})`)

/** The variables the checks already use: a column with one of these names gets `_value` after it. */
const TAKEN = new Set([
  'values',
  'errors',
  'creating',
  'current',
  'uow',
  'value',
  'other',
  'entity',
  'changes',
  'data',
  'link',
  'row',
  'transaction',
])
const local = (column: ColumnInfo) => (TAKEN.has(column.key) ? `${column.key}_value` : column.field)

const numericKinds = new Set(['integer', 'decimal', 'float'])

/** The value a check uses: as the values give it, or as the row has it. */
function givenOrCurrent(info: TableInfo, column: ColumnInfo): string {
  const current = `current.and_then(|current| current.${column.field}${column.copy ? '' : '.clone()'})`
  // A column the client never sends is only as the row has it
  if (!createColumns(info).includes(column)) return `let ${local(column)} = ${current};`
  return `let ${local(column)} = values.${column.field}.clone().unwrap_or_else(|| ${current});`
}

const number = (value: number | string) => {
  const text = String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

/** The value of a field being checked (`value`, a reference), as an f64. */
const asNumber = (column: ColumnInfo) =>
  column.rs === 'rust_decimal::Decimal' ? 'f64::try_from(*value).unwrap_or(f64::NAN)' : '(*value as f64)'
/** The value of a field being checked, as text. */
const asText = (column: ColumnInfo) => (column.rs === 'String' ? 'value.as_str()' : 'value.to_string().as_str()')

function valueRules(column: ColumnInfo, checks: DbCheck[]): string[] {
  const rules: string[] = []
  const name = column.column.name
  const type = column.column.type
  const rule = (condition: string, message: string) => [
    `if ${condition} {`,
    `    errors.push(FieldError::new(${rsString(name)}, ${rsString(message)}));`,
    '}',
  ]
  if (type.kind === 'text' && type.length !== undefined)
    rules.push(...rule(`value.chars().count() > ${type.length}`, `is longer than ${type.length} characters`))
  for (const check of checks) {
    const parsed = check.parsed
    if (!parsed || parsed.column !== name) continue
    if (parsed.kind === 'in') {
      const message = `must be one of: ${parsed.values.join(', ')}`
      if (numericKinds.has(type.kind))
        rules.push(...rule(`![${parsed.values.map(number).join(', ')}].contains(&${asNumber(column)})`, message))
      else rules.push(...rule(`![${parsed.values.map((item) => rsString(String(item))).join(', ')}].contains(&${asText(column)})`, message))
    }
    if (parsed.kind === 'compare')
      rules.push(...rule(`!(${asNumber(column)} ${parsed.op} ${number(parsed.value)})`, `must be ${parsed.op} ${parsed.value}`))
    if (parsed.kind === 'length')
      rules.push(
        ...rule(`!(${asText(column)}.chars().count() ${parsed.op} ${parsed.value})`, `must have ${parsed.op} ${parsed.value} characters`),
      )
  }
  return rules
}

/** The checks of validate(), and what they use. */
function validateBlocks(writer: Writer): { blocks: string[][]; creating: boolean; current: boolean; uow: boolean } {
  const { context, info } = writer
  const blocks: string[][] = []
  let creating = false
  let current = false
  let uow = false
  for (const column of createColumns(info)) {
    const name = column.column.name
    const missing = column.required
      ? { condition: `creating || values.${column.field}.is_some()`, message: 'is required' }
      : !column.column.nullable
        ? { condition: `!creating && values.${column.field}.is_some()`, message: 'cannot be empty' }
        : null
    const rules = valueRules(column, info.table.checks)
    if (!missing && rules.length === 0) continue
    const value = `values.${column.field}.as_ref().and_then(|value| value.as_ref())`
    if (missing) {
      creating = true
      blocks.push([
        `match ${value} {`,
        `    None => {`,
        `        if ${missing.condition} {`,
        `            errors.push(FieldError::new(${rsString(name)}, ${rsString(missing.message)}));`,
        '        }',
        '    }',
        rules.length > 0 ? '    Some(value) => {' : '    Some(_) => {}',
        ...(rules.length > 0 ? [...ind(rules, 8), '    }'] : []),
        '}',
      ])
    } else blocks.push([`if let Some(value) = ${value} {`, ...ind(rules), '}'])
  }
  // Parents
  for (const key of info.table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    const read = parent ? query(parent, 'getByKey') : undefined
    const sameKey = parent && parent.key.map((column) => column.column.name).join(',') === key.references.columns.join(',')
    if (!parent || !read || !sameKey) {
      blocks.push([
        `// TODO: ${key.columns.join(', ')} must point to a row of ${key.references.table}; that table has no read by key to check it`,
      ])
      continue
    }
    current = true
    uow = true
    const columns = key.columns.map((name) => columnOf(info, name))
    const pattern =
      columns.length === 1 ? `Some(${local(columns[0])})` : `(${columns.map((column) => `Some(${local(column)})`).join(', ')})`
    const source = columns.length === 1 ? local(columns[0]) : `(${columns.map(local).join(', ')})`
    blocks.push([
      '{',
      ...columns.map((column) => `    ${givenOrCurrent(info, column)}`),
      `    if let ${pattern} = ${source} {`,
      `        if ${repo(parent)}.${queryName(context, read)}(${columns.map(local).join(', ')}).await?.is_none() {`,
      `            errors.push(FieldError::new(${rsString(key.columns.join(', '))}, ${rsString(`no ${parent.entity} has this key`)}));`,
      '        }',
      '    }',
      '}',
    ])
  }
  return { blocks, creating, current: current || creating, uow }
}

const param = (name: string, used: boolean) => (used ? name : `_${name}`)

function validateFunction(writer: Writer): string[] {
  const { info, uses } = writer
  const { blocks, creating, current, uow } = validateBlocks(writer)
  if (blocks.every((block) => block.length === 1 && block[0].startsWith('//'))) return blocks.flat()
  uses.add(`${ERRORS}::FieldError`)
  return [
    `/// Checks the values against the rules of the "${info.name}" table, and the rows they point to; ValidationFailed lists every problem.`,
    `async fn validate(${param('uow', uow)}: &dyn UnitOfWork, values: &Values, ${param('current', current)}: Option<&${info.entity}>) -> Result<(), DomainError> {`,
    ...(creating ? ['    let creating = current.is_none();'] : []),
    '    let mut errors = Vec::new();',
    ...blocks.flatMap((block) => ind(block)),
    '    if errors.is_empty() {',
    '        Ok(())',
    '    } else {',
    `        Err(DomainError::ValidationFailed { entity: ${rsString(info.entity)}.to_string(), errors })`,
    '    }',
    '}',
  ]
}

/** The checks of the unique values that have a read, and notes for those that have none. */
function uniqueChecks(writer: Writer): { checks: string[][]; notes: string[] } {
  const { context, info } = writer
  const checks: string[][] = []
  const notes: string[] = []
  for (const unique of info.table.uniques) {
    const read = query(info, 'findByUnique', unique.columns)
    if (!read) {
      notes.push(`// ${unique.columns.join(', ')} must be unique: the database refuses repeated values (Conflict)`)
      continue
    }
    const columns = unique.columns.map((name) => columnOf(info, name))
    const other = info.key.map((column) => `other.${column.field} != current.${column.field}`).join(' || ')
    const pattern =
      columns.length === 1 ? `Some(${local(columns[0])})` : `(${columns.map((column) => `Some(${local(column)})`).join(', ')})`
    const source = columns.length === 1 ? local(columns[0]) : `(${columns.map(local).join(', ')})`
    checks.push([
      '{',
      ...columns.map((column) => `    ${givenOrCurrent(info, column)}`),
      `    if let ${pattern} = ${source} {`,
      `        if let Some(other) = ${repo(info)}.${queryName(context, read)}(${columns.map(local).join(', ')}).await? {`,
      `            if current.is_none_or(|current| ${other}) {`,
      `                return Err(DomainError::conflict(${rsString(info.entity)}, ${rsString(`${unique.columns.join(', ')} is already taken`)}, &[${columns.map((column) => rsString(column.key)).join(', ')}]));`,
      '            }',
      '        }',
      '    }',
      '}',
    ])
  }
  return { checks, notes }
}

/** validate, check_unique and check_values: every check before a write. */
function checkFunctions(writer: Writer): string[] {
  const { info } = writer
  const validate = validateFunction(writer)
  const validates = validate.some((line) => line.startsWith('async fn validate'))
  const { checks, notes } = uniqueChecks(writer)
  const unique =
    checks.length > 0
      ? [
          '/// Values that must be unique are not taken by another row.',
          `async fn check_unique(uow: &dyn UnitOfWork, values: &Values, current: Option<&${info.entity}>) -> Result<(), DomainError> {`,
          ...checks.flatMap((block) => ind(block)),
          '    Ok(())',
          '}',
        ]
      : []
  const used = validates || checks.length > 0
  const calls = [
    ...(validates ? ['validate(uow, values, current).await?;'] : validate.filter((line) => line.startsWith('//'))),
    ...notes,
    ...(checks.length > 0 ? ['check_unique(uow, values, current).await'] : ['Ok(())']),
  ]
  return [
    ...(validates ? [...validate, ''] : []),
    ...(unique.length > 0 ? [...unique, ''] : []),
    '/// Every check before a write: the values, the rows they point to, the unique values.',
    `async fn check_values(${param('uow', used)}: &dyn UnitOfWork, ${param('values', used)}: &Values, ${param('current', used)}: Option<&${info.entity}>) -> Result<(), DomainError> {`,
    ...ind(calls),
    '}',
  ]
}

function valuesStruct(info: TableInfo): string[] {
  const columns = createColumns(info)
  return [
    '/// The values a create or an update gives, by field: None when not given, Some(None) when given empty.',
    '#[derive(Default)]',
    columns.length > 0 ? 'struct Values {' : 'struct Values {}',
    ...columns.map((column) => `    ${column.field}: Option<Option<${column.rs}>>,`),
    ...(columns.length > 0 ? ['}'] : []),
  ]
}

function applyFunction(info: TableInfo): string[] {
  const columns = createColumns(info)
  const used = columns.length > 0
  return [
    '/// Sets the given values on the entity.',
    `fn apply_values(${param('entity', used)}: &mut ${info.entity}, ${param('values', used)}: &Values) {`,
    ...columns.flatMap((column) => [
      `    if let Some(value) = &values.${column.field} {`,
      `        entity.${column.field} = ${column.copy ? '*value' : 'value.clone()'};`,
      '    }',
    ]),
    '}',
  ]
}

function findFunction(writer: Writer): string[] {
  const { context, info } = writer
  const read = query(info, 'getByKey')!
  const args = info.key.map(pass).join(', ')
  return [
    `/// The ${info.entity} with this key; NotFound when there is none.`,
    `async fn find(uow: &dyn UnitOfWork, ${keyParams(info)}) -> Result<${info.entity}, DomainError> {`,
    `    ${repo(info)}.${queryName(context, read)}(${args}).await?.ok_or_else(|| DomainError::not_found(${rsString(info.entity)}, ${keyValue(info)}))`,
    '}',
  ]
}

function readFunction(info: TableInfo): string[] {
  return [
    `/// The ${info.entity} as services return it.`,
    `fn read(entity: ${info.entity}) -> ${readDto(info)} {`,
    `    ${readDto(info)} {`,
    ...readColumns(info).map(
      (column) =>
        `        ${column.field}: ${column.column.nullable ? `entity.${column.field}` : `entity.${column.field}.expect(${rsString(`${column.key} is set`)})`},`,
    ),
    '    }',
    '}',
  ]
}

function givenFunction(writer: Writer): string[] {
  const { context, info } = writer
  const mode = context.settings.updates
  const columns = updateColumns(info)
  const value = (column: ColumnInfo) =>
    mode === 'patch'
      ? `changes.${column.field}.given()`
      : mode === 'optional'
        ? `changes.${column.field}`
        : column.column.nullable
          ? `Some(changes.${column.field})`
          : `Some(Some(changes.${column.field}))`
  const all = columns.length === createColumns(info).length
  return [
    '/// The values an update gives, by field.',
    `fn given(${param('changes', columns.length > 0)}: ${updateType(context, info)}) -> Values {`,
    columns.length === 0
      ? '    Values::default()'
      : `    Values { ${columns.map((column) => `${column.field}: ${value(column)}`).join(', ')}${all ? '' : ', ..Default::default()'} }`,
    '}',
  ]
}

const out = (writer: Writer, expression: string) => {
  if (!writer.dtos) return expression
  writer.used.add('read')
  return `read(${expression})`
}
/** `read`, the function that turns an entity into what the service returns */
const reader = (writer: Writer) => {
  writer.used.add('read')
  return 'read'
}
const resultType = (writer: Writer) => (writer.dtos ? readDto(writer.info) : writer.info.entity)

function versionCheck(writer: Writer): string[] {
  const version = writer.info.version
  if (!version) return []
  return [
    `if current.${version.field} != Some(version) {`,
    `    return Err(DomainError::conflict(${rsString(writer.info.entity)}, "was changed by someone else since it was read", &[${rsString(version.key)}]));`,
    '}',
  ]
}

function childrenLines(writer: Writer): string[] {
  const { context, info } = writer
  if (!info.children) return []
  const result: string[] = []
  for (const link of info.children.links) {
    const child = findInfo(context, link.table)
    const list = child ? query(child, 'listByParent', link.columns) : undefined
    if (!child || !list) {
      result.push(`// TODO: rows of ${link.table} may point here; that table has no list by ${link.columns.join(', ')} to look for them`)
      continue
    }
    const args = link.references.map((name) => stored(`current.${columnOf(info, name).field}`, columnOf(info, name))).join(', ')
    const rows = `${repo(child)}.${queryName(context, list)}(${args}).await?`
    if (info.children.policy === 'block')
      result.push(
        `if !${rows}.is_empty() {`,
        `    return Err(DomainError::conflict(${rsString(info.entity)}, ${rsString(`rows of ${link.table} still point to it`)}, &[${rsString(link.table)}]));`,
        '}',
      )
    else {
      const remove = query(child, 'delete')
      if (!remove) result.push(`// TODO: rows of ${link.table} must be deleted first, and that table has no delete`)
      else result.push(`for row in ${rows} {`, `    ${repo(child)}.${queryName(context, remove)}(&row).await?;`, '}')
    }
  }
  return result
}

/** The lines of a write: in a transaction of its own when each operation has one. */
function inTransaction(writer: Writer, items: string[], result: string): string[] {
  if (writer.context.settings.transactions !== 'operation') return ['let uow = self.unit_of_work.as_ref();', ...items, result]
  return [
    'let transaction = self.unit_of_work.begin().await?;',
    'let uow = transaction.as_ref();',
    ...items,
    'transaction.commit().await?;',
    result,
  ]
}

function operationLines(writer: Writer, operation: OperationDesign): string[] {
  const { context, info, uses } = writer
  const name = operationName(context, operation)
  const entity = info.entity
  const fn = (signature: string, body: string[]) => [`pub async fn ${signature} {`, ...ind(body), '}']
  switch (operation.kind) {
    case 'create': {
      const insert = query(info, 'insert')
      if (!insert) return []
      if (writer.dtos) uses.add(pathIn(moduleOf(context, info, 'dtos'), createDto(info)))
      writer.used.add('checkValues').add('apply')
      const variable = writer.dtos ? 'data' : snakeName(entity)
      const columns = createColumns(info)
      return [
        `/// Stores a new ${entity} after checking it.`,
        ...fn(`${name}(&self, ${variable}: ${writer.dtos ? createDto(info) : entity}) -> Result<${resultType(writer)}, DomainError>`, [
          columns.length > 0
            ? `let values = Values { ${columns.map((column) => `${column.field}: ${variable}.${column.field}.map(Some)`).join(', ')} };`
            : 'let values = Values {};',
          ...(columns.length === 0 ? [`let _ = ${variable};`] : []),
          ...inTransaction(
            writer,
            [
              'check_values(uow, &values, None).await?;',
              `let mut entity = ${entity}::default();`,
              'apply_values(&mut entity, &values);',
              `let created = ${repo(info)}.${queryName(context, insert)}(entity).await?;`,
            ],
            `Ok(${out(writer, 'created')})`,
          ),
        ]),
      ]
    }
    case 'get':
      if (!query(info, 'getByKey')) return []
      writer.used.add('find')
      return [
        `/// The ${entity} with this key; NotFound when there is none.`,
        ...fn(`${name}(&self, ${keyParams(info)}) -> Result<${resultType(writer)}, DomainError>`, [
          `find(self.unit_of_work.as_ref(), ${keyArgs(info)}).await${writer.dtos ? `.map(${reader(writer)})` : ''}`,
        ]),
      ]
    case 'list': {
      const list = query(info, 'list')
      if (!list) return []
      const method = `self.unit_of_work.${info.attr}().${queryName(context, list)}`
      const result = resultType(writer)
      if (context.settings.paging === 'offset') {
        uses.add(`${COMMON}::Page`)
        return [
          `/// A page of ${info.name}, by primary key.`,
          ...fn(`${name}(&self, offset: u64, limit: u64) -> Result<Page<${result}>, DomainError>`, [
            `${method}(offset, limit).await${writer.dtos ? `.map(|page| page.map(${reader(writer)}))` : ''}`,
          ]),
        ]
      }
      if (context.settings.paging === 'cursor') {
        uses.add(`${COMMON}::CursorPage`)
        return [
          `/// A page of ${info.name} after the key after (None for the first page), by primary key.`,
          ...fn(
            `${name}(&self, after: Option<${keyType(info)}>, limit: u64) -> Result<CursorPage<${result}, ${keyType(info)}>, DomainError>`,
            [`${method}(after, limit).await${writer.dtos ? `.map(|page| page.map(${reader(writer)}))` : ''}`],
          ),
        ]
      }
      return [
        `/// Every ${entity}, by primary key.`,
        ...fn(`${name}(&self) -> Result<Vec<${result}>, DomainError>`, [
          `${method}().await${writer.dtos ? `.map(|rows| rows.into_iter().map(${reader(writer)}).collect())` : ''}`,
        ]),
      ]
    }
    case 'update': {
      const update = query(info, 'update')
      if (!update || !query(info, 'getByKey')) return []
      if (writer.dtos) uses.add(updatePath(context, info))
      writer.used.add('given').add('find').add('checkValues').add('apply')
      const version = info.version ? `, version: ${info.version.rs}` : ''
      return [
        `/// Changes the given values of a ${entity}${info.version ? ', read at version' : ''}.`,
        ...fn(
          `${name}(&self, ${keyParams(info)}, changes: ${updateType(context, info)}${version}) -> Result<${resultType(writer)}, DomainError>`,
          [
            'let values = given(changes);',
            ...inTransaction(
              writer,
              [
                `let mut current = find(uow, ${keyArgs(info)}).await?;`,
                ...versionCheck(writer),
                'check_values(uow, &values, Some(&current)).await?;',
                'apply_values(&mut current, &values);',
                ...(info.version ? [`current.${info.version.field} = Some(version + 1);`] : []),
                `let updated = ${repo(info)}.${queryName(context, update)}(current).await?;`,
              ],
              `Ok(${out(writer, 'updated')})`,
            ),
          ],
        ),
      ]
    }
    case 'delete': {
      const remove = query(info, 'delete')
      const update = query(info, 'update')
      if (!query(info, 'getByKey') || (!info.soft && !remove) || (info.soft && !update)) return []
      writer.used.add('find')
      const version = info.version ? `, version: ${info.version.rs}` : ''
      const soft = info.soft
      const mark = soft ? (soft.column.type.kind === 'boolean' ? 'true' : (nowOf(soft) ?? 'Default::default()')) : ''
      const action = soft
        ? [`current.${soft.field} = Some(${mark});`, `${repo(info)}.${queryName(context, update!)}(current).await?;`]
        : [`${repo(info)}.${queryName(context, remove!)}(&current).await?;`]
      return [
        soft ? `/// Marks a ${entity} as deleted (${soft.column.name}); reads leave it out from then on.` : `/// Deletes a ${entity}.`,
        ...fn(`${name}(&self, ${keyParams(info)}${version}) -> Result<(), DomainError>`, [
          ...inTransaction(
            writer,
            [
              `let ${soft ? 'mut ' : ''}current = find(uow, ${keyArgs(info)}).await?;`,
              ...versionCheck(writer),
              ...childrenLines(writer),
              ...action,
            ],
            'Ok(())',
          ),
        ]),
      ]
    }
    case 'find':
    case 'listByParent': {
      const read = query(info, operation.kind === 'find' ? 'findByUnique' : 'listByParent', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => columnOf(info, column))
      const params = columns.map((column) => `${column.field}: ${column.rs}`).join(', ')
      const rows = `self.unit_of_work.${info.attr}().${queryName(context, read)}(${columns.map((column) => column.field).join(', ')}).await`
      const mapper = writer.dtos ? reader(writer) : ''
      if (operation.kind === 'find')
        return [
          `/// The ${entity} with this ${operation.columns.join(' and ')}, or None.`,
          ...fn(`${name}(&self, ${params}) -> Result<Option<${resultType(writer)}>, DomainError>`, [
            writer.dtos ? `${rows}.map(|row| row.map(${mapper}))` : rows,
          ]),
        ]
      return [
        `/// The ${info.name} with this ${operation.columns.join(' and ')}.`,
        ...fn(`${name}(&self, ${params}) -> Result<Vec<${resultType(writer)}>, DomainError>`, [
          writer.dtos ? `${rows}.map(|rows| rows.into_iter().map(${mapper}).collect())` : rows,
        ]),
      ]
    }
    case 'link':
    case 'unlink':
      return linkLines(writer, operation, name)
    // One item of a list: only document databases have them
    case 'addItem':
    case 'removeItem':
      return []
  }
}

function linkLines(writer: Writer, operation: OperationDesign, name: string): string[] {
  const { context, info, uses } = writer
  const join = operation.through ? findInfo(context, operation.through) : undefined
  if (!join) return []
  const own = join.table.foreignKeys.find((key) => key.references.table === info.name)
  const far = join.table.foreignKeys.find((key) => key !== own)
  const farInfo = far ? findInfo(context, far.references.table) : undefined
  const read = query(join, 'getByKey')
  if (!own || !far || !farInfo || !read || !query(info, 'getByKey')) return []
  const ownCols = own.columns.map((column) => columnOf(join, column))
  const farCols = far.columns.map((column) => columnOf(join, column))
  const every = [...ownCols, ...farCols]
  const params = every.map((column) => `${column.field}: ${column.rs}`).join(', ')
  const joinKey = join.key.map(pass).join(', ')
  const found = `${repo(join)}.${queryName(context, read)}(${joinKey}).await?`
  const tuple = (columns: ColumnInfo[]) => (columns.length === 1 ? pass(columns[0]) : `(${columns.map(pass).join(', ')})`)
  writer.used.add('find')
  if (operation.kind === 'link') {
    const insert = query(join, 'insert')
    const farRead = query(farInfo, 'getByKey')
    if (!insert || !farRead) return []
    uses.add(pathIn(moduleOf(context, join, 'entity'), join.entity))
    const values = every.map((column) => `${column.field}: Some(${column.field})`).join(', ')
    return [
      `/// Links a ${info.entity} and a ${farInfo.entity} (${join.name}).`,
      `pub async fn ${name}(&self, ${params}) -> Result<(), DomainError> {`,
      ...ind(
        inTransaction(
          writer,
          [
            `find(uow, ${ownCols.map(pass).join(', ')}).await?;`,
            `if ${repo(farInfo)}.${queryName(context, farRead)}(${farCols.map(pass).join(', ')}).await?.is_none() {`,
            `    return Err(DomainError::not_found(${rsString(farInfo.entity)}, ${tuple(farCols)}));`,
            '}',
            `if ${found}.is_some() {`,
            `    return Err(DomainError::conflict(${rsString(info.entity)}, ${rsString(`is already linked to this ${farInfo.entity}`)}, &[${farCols.map((column) => rsString(column.key)).join(', ')}]));`,
            '}',
            `${repo(join)}.${queryName(context, insert)}(${join.entity} { ${values}${every.length === join.columns.length ? '' : ', ..Default::default()'} }).await?;`,
          ],
          'Ok(())',
        ),
      ),
      '}',
    ]
  }
  const remove = query(join, 'delete')
  if (!remove) return []
  return [
    `/// Removes the link between a ${info.entity} and a ${farInfo.entity} (${join.name}).`,
    `pub async fn ${name}(&self, ${params}) -> Result<(), DomainError> {`,
    ...ind(
      inTransaction(
        writer,
        [
          `let link = ${found}.ok_or_else(|| DomainError::not_found(${rsString(join.entity)}, ${tuple(join.key)}))?;`,
          `${repo(join)}.${queryName(context, remove)}(&link).await?;`,
        ],
        'Ok(())',
      ),
    ),
    '}',
  ]
}

const TRANSACTIONS = {
  operation: 'Each write runs in a transaction of its own.',
  caller: 'It never commits: the caller owns the transaction.',
  repository: 'Repositories commit every write.',
}

export function serviceFile(context: Context, info: TableInfo): GeneratedFile | null {
  if (!info.service) return null
  const module = moduleOf(context, info, 'service')
  const uses = new RsUses().add('std::sync::Arc', UNIT_OF_WORK, DOMAIN_ERROR)
  const dtos = context.settings.serviceTypes === 'dtos'
  const writer: Writer = { context, info, uses, dtos, used: new Set() }
  const operations = info.operations.map((operation) => operationLines(writer, operation)).filter((block) => block.length > 0)
  if (operations.length > 0) uses.add(pathIn(moduleOf(context, info, 'entity'), info.entity))
  if (dtos && writer.used.has('read')) uses.add(pathIn(moduleOf(context, info, 'dtos'), readDto(info)))
  const helpers: string[][] = []
  const values = writer.used.has('checkValues') || writer.used.has('apply') || writer.used.has('given')
  if (values) helpers.push(valuesStruct(info))
  if (writer.used.has('checkValues')) helpers.push(checkFunctions(writer))
  if (writer.used.has('apply')) helpers.push(applyFunction(info))
  if (writer.used.has('given')) helpers.push(givenFunction(writer))
  if (writer.used.has('find')) helpers.push(findFunction(writer))
  if (writer.used.has('read')) helpers.push(readFunction(info))
  const hidden = info.hidden.length > 0 && !dtos
  // The changes of an update, when services take entities
  const changes = info.role === 'entity' && !dtos ? updateStruct(context, info) : []
  return rsFile(
    fileOf(module),
    uses.write(),
    [
      ...(changes.length > 0 ? [...changes, ''] : []),
      `/// Operations on ${info.name}. ${TRANSACTIONS[context.settings.transactions]}`,
      `pub struct ${serviceType(info)} {`,
      '    unit_of_work: Arc<dyn UnitOfWork>,',
      '}',
      '',
      `impl ${serviceType(info)} {`,
      ...(hidden
        ? [
            `    // TODO: ${info.hidden.join(', ')} ${info.hidden.length === 1 ? 'is' : 'are'} returned with the entity; use DTOs to leave ${info.hidden.length === 1 ? 'it' : 'them'} out`,
          ]
        : []),
      '    pub fn new(unit_of_work: Arc<dyn UnitOfWork>) -> Self {',
      '        Self { unit_of_work }',
      '    }',
      ...operations.flatMap((block) => ['', ...ind(block)]),
      '}',
      ...helpers.flatMap((block) => ['', ...block]),
    ],
    [`The service of the "${info.name}" table.`],
  )
}
