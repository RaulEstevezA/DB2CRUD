/**
 * The service of each table: its operations and what each one checks before it writes, in the order of the design
 * (docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
 * version; then children and soft deletes. The values of a create or an update are gathered in a `Values` struct of the
 * fields given (nil when not given, .some(nil) when given empty), so every way an update can come is checked and
 * applied the same way. Every write runs in unitOfWork.transaction { ... }; errors are DomainError values without
 * HTTP codes. Only the helpers the operations use are written.
 */
import type { OperationDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { DbCheck } from '../../schema/types.ts'
import {
  columnOf,
  fileOf,
  findInfo,
  keyType,
  operationName,
  query,
  queryName,
  serviceType,
  stored,
  swFile,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, readColumns, readDto, updateColumns, createDto, updateType } from './dtos.ts'
import { imports, memberName, swString } from './swift.ts'

type Helper = 'find' | 'read' | 'checkValues' | 'apply' | 'given'

interface Writer {
  context: Context
  info: TableInfo
  dtos: boolean
  used: Set<Helper>
}

const ind = (items: string[], spaces = 4) => items.map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
const repo = (info: TableInfo) => `uow.${info.attr}`
const keyParams = (info: TableInfo) => info.key.map((column) => `_ ${column.prop}: ${column.sw}`).join(', ')
const keyArgs = (info: TableInfo) => info.key.map((column) => column.prop).join(', ')
/** The key as text, for notFound: `"\\(orderId), \\(line)"` */
const keyText = (columns: ColumnInfo[]) => `"${columns.map((column) => `\\(${column.prop})`).join(', ')}"`

/** The variables the checks already use: a column with one of these names gets `Value` after it. */
const TAKEN = new Set(['values', 'errors', 'creating', 'current', 'uow', 'value', 'other', 'entity', 'changes', 'data', 'link', 'row'])
const local = (column: ColumnInfo) => (TAKEN.has(column.key) ? `${column.key}Value` : column.prop)

const numericKinds = new Set(['integer', 'decimal', 'float'])

/** The value a check uses: as the values give it, or as the row has it. */
const givenOrCurrent = (info: TableInfo, column: ColumnInfo) =>
  createColumns(info).includes(column) ? `values.${column.prop} ?? current?.${column.prop}` : `current?.${column.prop}`

const number = (value: number | string) => {
  const text = String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

/** The value of a field being checked (`value`), as a Double. */
const asNumber = (column: ColumnInfo) => (column.sw === 'Decimal' ? 'NSDecimalNumber(decimal: value).doubleValue' : 'Double(value)')
/** The value of a field being checked, as text. */
const asText = (column: ColumnInfo) => (column.sw === 'String' ? 'value' : '"\\(value)"')

function valueRules(column: ColumnInfo, checks: DbCheck[]): string[] {
  const rules: string[] = []
  const name = column.column.name
  const type = column.column.type
  const rule = (condition: string, message: string) => [
    `if ${condition} {`,
    `    errors.append(FieldError(${swString(name)}, ${swString(message)}))`,
    '}',
  ]
  if (type.kind === 'text' && type.length !== undefined)
    rules.push(...rule(`value.count > ${type.length}`, `is longer than ${type.length} characters`))
  for (const check of checks) {
    const parsed = check.parsed
    if (!parsed || parsed.column !== name) continue
    if (parsed.kind === 'in') {
      const message = `must be one of: ${parsed.values.join(', ')}`
      if (numericKinds.has(type.kind))
        rules.push(...rule(`![${parsed.values.map(number).join(', ')}].contains(${asNumber(column)})`, message))
      else rules.push(...rule(`![${parsed.values.map((item) => swString(String(item))).join(', ')}].contains(${asText(column)})`, message))
    }
    if (parsed.kind === 'compare')
      rules.push(...rule(`!(${asNumber(column)} ${parsed.op} ${number(parsed.value)})`, `must be ${parsed.op} ${parsed.value}`))
    if (parsed.kind === 'length')
      rules.push(...rule(`!(${asText(column)}.count ${parsed.op} ${parsed.value})`, `must have ${parsed.op} ${parsed.value} characters`))
  }
  return rules
}

/** validate(): the values against the rules of the table, and the rows they point to; nothing when there is nothing to check. */
function validateFunction(writer: Writer): string[] {
  const { context, info } = writer
  const blocks: string[][] = []
  let creating = false
  for (const column of createColumns(info)) {
    const name = column.column.name
    const missing = column.required
      ? { condition: `creating || values.${column.prop} != nil`, message: 'is required' }
      : !column.column.nullable
        ? { condition: `!creating && values.${column.prop} != nil`, message: 'cannot be empty' }
        : null
    const rules = valueRules(column, info.table.checks)
    if (!missing && rules.length === 0) continue
    const report = missing && [`    errors.append(FieldError(${swString(name)}, ${swString(missing.message)}))`, '}']
    if (missing) creating = true
    if (rules.length > 0)
      blocks.push([
        `if let value = values.${column.prop} ?? nil {`,
        ...ind(rules),
        ...(missing ? [`} else if ${missing.condition} {`, ...report!] : ['}']),
      ])
    else blocks.push([`if values.${column.prop} ?? nil == nil && (${missing!.condition}) {`, ...report!])
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
    const columns = key.columns.map((name) => columnOf(info, name))
    blocks.push([
      `if ${columns.map((column) => `let ${local(column)} = ${givenOrCurrent(info, column)}`).join(', ')} {`,
      `    if try await ${repo(parent)}.${queryName(context, read)}(${columns.map(local).join(', ')}) == nil {`,
      `        errors.append(FieldError(${swString(key.columns.join(', '))}, ${swString(`no ${parent.entity} has this key`)}))`,
      '    }',
      '}',
    ])
  }
  if (blocks.every((block) => block.length === 1 && block[0].startsWith('//'))) return blocks.flat()
  return [
    `/// Checks the values against the rules of the "${info.name}" table, and the rows they point to; throws validationFailed with every problem.`,
    `fileprivate func validate(_ uow: any UnitOfWork, _ values: Values, _ current: ${info.entity}?) async throws {`,
    ...(creating ? ['    let creating = current == nil'] : []),
    '    var errors: [FieldError] = []',
    ...blocks.flatMap((block) => ind(block)),
    `    if !errors.isEmpty { throw DomainError.validationFailed(entity: ${swString(info.entity)}, errors: errors) }`,
    '}',
  ]
}

/** checkUnique(): values that must be unique are not taken by another row, with notes for those it cannot read. */
function uniqueFunction(writer: Writer): { lines: string[]; notes: string[] } {
  const { context, info } = writer
  const checks: string[][] = []
  const notes: string[] = []
  for (const unique of info.table.uniques) {
    const read = query(info, 'findByUnique', unique.columns)
    if (!read) {
      notes.push(`// ${unique.columns.join(', ')} must be unique: the database refuses repeated values (conflict)`)
      continue
    }
    const columns = unique.columns.map((name) => columnOf(info, name))
    const other = info.key.map((column) => `other.${column.prop} != $0.${column.prop}`).join(' || ')
    checks.push([
      `if ${columns.map((column) => `let ${local(column)} = ${givenOrCurrent(info, column)}`).join(', ')},`,
      `   let other = try await ${repo(info)}.${queryName(context, read)}(${columns.map(local).join(', ')}),`,
      `   current.map({ ${other} }) ?? true {`,
      `    throw DomainError.conflict(entity: ${swString(info.entity)}, reason: ${swString(`${unique.columns.join(', ')} is already taken`)}, fields: [${columns.map((column) => swString(column.key)).join(', ')}])`,
      '}',
    ])
  }
  if (checks.length === 0) return { lines: [], notes }
  return {
    lines: [
      '/// Values that must be unique are not taken by another row.',
      `fileprivate func checkUnique(_ uow: any UnitOfWork, _ values: Values, _ current: ${info.entity}?) async throws {`,
      ...checks.flatMap((block) => ind(block)),
      '}',
    ],
    notes,
  }
}

function checkFunctions(writer: Writer): string[] {
  const { info } = writer
  const validate = validateFunction(writer)
  const validates = validate.some((line) => line.startsWith('fileprivate func validate'))
  const unique = uniqueFunction(writer)
  return [
    ...(validates ? [...validate, ''] : []),
    ...(unique.lines.length > 0 ? [...unique.lines, ''] : []),
    '/// Every check before a write: the values, the rows they point to, the unique values.',
    `fileprivate func checkValues(_ uow: any UnitOfWork, _ values: Values, _ current: ${info.entity}?) async throws {`,
    ...ind([
      ...(validates ? ['try await validate(uow, values, current)'] : validate),
      ...unique.notes,
      ...(unique.lines.length > 0 ? ['try await checkUnique(uow, values, current)'] : []),
    ]),
    '}',
  ]
}

function valuesStruct(info: TableInfo): string[] {
  return [
    '/// The values a create or an update gives, by field: nil when not given, .some(nil) when given empty.',
    'fileprivate struct Values: Sendable {',
    ...createColumns(info).map((column) => `    var ${column.prop}: ${column.sw}?? = nil`),
    '}',
  ]
}

function applyFunction(info: TableInfo): string[] {
  return [
    '/// Sets the given values on the entity.',
    `fileprivate func applyValues(_ entity: inout ${info.entity}, _ values: Values) {`,
    ...createColumns(info).map((column) => `    if let value = values.${column.prop} { entity.${column.prop} = value }`),
    '}',
  ]
}

function findFunction(writer: Writer): string[] {
  const { context, info } = writer
  const read = query(info, 'getByKey')!
  return [
    `/// The ${info.entity} with this key; notFound when there is none.`,
    `fileprivate func find(_ uow: any UnitOfWork, ${keyParams(info)}) async throws -> ${info.entity} {`,
    `    guard let row = try await ${repo(info)}.${queryName(context, read)}(${keyArgs(info)}) else {`,
    `        throw DomainError.notFound(entity: ${swString(info.entity)}, key: ${keyText(info.key)})`,
    '    }',
    '    return row',
    '}',
  ]
}

function readFunction(info: TableInfo): string[] {
  return [
    `/// The ${info.entity} as services return it.`,
    `fileprivate func read(_ entity: ${info.entity}) -> ${readDto(info)} {`,
    `    ${readDto(info)}(${readColumns(info)
      .map((column) => `${column.key}: ${stored(`entity.${column.prop}`, column)}`)
      .join(', ')})`,
    '}',
  ]
}

function givenFunction(writer: Writer): string[] {
  const { context, info } = writer
  const mode = context.settings.updates
  const value = (column: ColumnInfo) =>
    mode === 'patch' ? `changes.${column.prop}.given` : mode === 'optional' ? `changes.${column.prop}` : `.some(changes.${column.prop})`
  return [
    '/// The values an update gives, by field.',
    `fileprivate func given(_ changes: ${updateType(context, info)}) -> Values {`,
    `    Values(${updateColumns(info)
      .map((column) => `${column.key}: ${value(column)}`)
      .join(', ')})`,
    '}',
  ]
}

/** An async call, turned into what the service returns: `try await read(call)` when services return DTOs. */
const out = (writer: Writer, call: string) => {
  if (!writer.dtos) return `try await ${call}`
  writer.used.add('read')
  return `try await read(${call})`
}
const reader = (writer: Writer) => {
  writer.used.add('read')
  return 'read'
}
const resultType = (writer: Writer) => (writer.dtos ? readDto(writer.info) : writer.info.entity)

function versionCheck(writer: Writer): string[] {
  const version = writer.info.version
  if (!version) return []
  return [
    `if current.${version.prop} != version {`,
    `    throw DomainError.conflict(entity: ${swString(writer.info.entity)}, reason: "was changed by someone else since it was read", fields: [${swString(version.key)}])`,
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
    const args = link.references.map((name) => `current.${columnOf(info, name).prop}!`).join(', ')
    const rows = `try await ${repo(child)}.${queryName(context, list)}(${args})`
    if (info.children.policy === 'block')
      result.push(
        `if !(${rows}).isEmpty {`,
        `    throw DomainError.conflict(entity: ${swString(info.entity)}, reason: ${swString(`rows of ${link.table} still point to it`)}, fields: [${swString(link.table)}])`,
        '}',
      )
    else {
      const remove = query(child, 'delete')
      if (!remove) result.push(`// TODO: rows of ${link.table} must be deleted first, and that table has no delete`)
      else result.push(`for row in ${rows} {`, `    try await ${repo(child)}.${queryName(context, remove)}(row)`, '}')
    }
  }
  return result
}

/** The lines of a write, in the transaction of the unit of work. */
const inTransaction = (items: string[], returns: boolean) => [
  `${returns ? 'return ' : ''}try await unitOfWork.transaction { uow in`,
  ...ind(items),
  '}',
]

function operationLines(writer: Writer, operation: OperationDesign): string[] {
  const { context, info } = writer
  const name = operationName(context, operation)
  const entity = info.entity
  const fn = (attributes: string[], signature: string, body: string[]) => [...attributes, `public func ${signature} {`, ...ind(body), '}']
  switch (operation.kind) {
    case 'create': {
      const insert = query(info, 'insert')
      if (!insert) return []
      writer.used.add('checkValues').add('apply')
      const variable = writer.dtos ? 'data' : memberName(entity)
      return [
        `/// Stores a new ${entity} after checking it.`,
        ...fn(
          ['@discardableResult'],
          `${name}(_ ${variable}: ${writer.dtos ? createDto(info) : entity}) async throws -> ${resultType(writer)}`,
          [
            `let values = Values(${createColumns(info)
              .map((column) => `${column.key}: ${variable}.${column.prop}.map(Optional.some)`)
              .join(', ')})`,
            ...inTransaction(
              [
                'try await checkValues(uow, values, nil)',
                `var entity = ${entity}()`,
                'applyValues(&entity, values)',
                `return ${out(writer, `${repo(info)}.${queryName(context, insert)}(entity)`)}`,
              ],
              true,
            ),
          ],
        ),
      ]
    }
    case 'get':
      if (!query(info, 'getByKey')) return []
      writer.used.add('find')
      return [
        `/// The ${entity} with this key; notFound when there is none.`,
        ...fn([], `${name}(${keyParams(info)}) async throws -> ${resultType(writer)}`, [out(writer, `find(unitOfWork, ${keyArgs(info)})`)]),
      ]
    case 'list': {
      const list = query(info, 'list')
      if (!list) return []
      const method = `unitOfWork.${info.attr}.${queryName(context, list)}`
      const mapped = writer.dtos ? `.map(${reader(writer)})` : ''
      const result = resultType(writer)
      if (context.settings.paging === 'offset')
        return [
          `/// A page of ${info.name}, by primary key.`,
          ...fn([], `${name}(offset: Int, limit: Int) async throws -> Page<${result}>`, [
            `try await ${method}(offset: offset, limit: limit)${mapped}`,
          ]),
        ]
      if (context.settings.paging === 'cursor')
        return [
          `/// A page of ${info.name} after the key after (nil for the first page), by primary key.`,
          ...fn([], `${name}(after: ${keyType(info)}?, limit: Int) async throws -> CursorPage<${result}, ${keyType(info)}>`, [
            `try await ${method}(after: after, limit: limit)${mapped}`,
          ]),
        ]
      return [
        `/// Every ${entity}, by primary key.`,
        ...fn([], `${name}() async throws -> [${result}]`, [`try await ${method}()${mapped}`]),
      ]
    }
    case 'update': {
      const update = query(info, 'update')
      if (!update || !query(info, 'getByKey')) return []
      writer.used.add('given').add('find').add('checkValues').add('apply')
      const version = info.version ? `, version: ${info.version.sw}` : ''
      return [
        `/// Changes the given values of a ${entity}${info.version ? ', read at version' : ''}.`,
        ...fn(
          ['@discardableResult'],
          `${name}(${keyParams(info)}, _ changes: ${updateType(context, info)}${version}) async throws -> ${resultType(writer)}`,
          [
            'let values = given(changes)',
            ...inTransaction(
              [
                `var current = try await find(uow, ${keyArgs(info)})`,
                ...versionCheck(writer),
                'try await checkValues(uow, values, current)',
                'applyValues(&current, values)',
                ...(info.version ? [`current.${info.version.prop} = version + 1`] : []),
                `return ${out(writer, `${repo(info)}.${queryName(context, update)}(current)`)}`,
              ],
              true,
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
      const version = info.version ? `, version: ${info.version.sw}` : ''
      const soft = info.soft
      const action = soft
        ? [
            `current.${soft.prop} = ${soft.column.type.kind === 'boolean' ? 'true' : soft.sw === 'Date' ? 'Date()' : `current.${soft.prop}`}`,
            `try await ${repo(info)}.${queryName(context, update!)}(current)`,
          ]
        : [`try await ${repo(info)}.${queryName(context, remove!)}(current)`]
      return [
        soft ? `/// Marks a ${entity} as deleted (${soft.column.name}); reads leave it out from then on.` : `/// Deletes a ${entity}.`,
        ...fn([], `${name}(${keyParams(info)}${version}) async throws`, [
          ...inTransaction(
            [
              `${soft ? 'var' : 'let'} current = try await find(uow, ${keyArgs(info)})`,
              ...versionCheck(writer),
              ...childrenLines(writer),
              ...action,
            ],
            false,
          ),
        ]),
      ]
    }
    case 'find':
    case 'listByParent': {
      const read = query(info, operation.kind === 'find' ? 'findByUnique' : 'listByParent', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => columnOf(info, column))
      const params = columns.map((column) => `_ ${column.prop}: ${column.sw}`).join(', ')
      const rows = `try await unitOfWork.${info.attr}.${queryName(context, read)}(${columns.map((column) => column.prop).join(', ')})`
      const mapped = writer.dtos ? `.map(${reader(writer)})` : ''
      if (operation.kind === 'find')
        return [
          `/// The ${entity} with this ${operation.columns.join(' and ')}, or nil.`,
          ...fn([], `${name}(${params}) async throws -> ${resultType(writer)}?`, [`${rows}${mapped}`]),
        ]
      return [
        `/// The ${info.name} with this ${operation.columns.join(' and ')}.`,
        ...fn([], `${name}(${params}) async throws -> [${resultType(writer)}]`, [`${rows}${mapped}`]),
      ]
    }
    case 'link':
    case 'unlink':
      return linkLines(writer, operation, name)
  }
}

function linkLines(writer: Writer, operation: OperationDesign, name: string): string[] {
  const { context, info } = writer
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
  const params = every.map((column) => `_ ${column.prop}: ${column.sw}`).join(', ')
  const joinKey = join.key.map((column) => column.prop).join(', ')
  const found = `try await ${repo(join)}.${queryName(context, read)}(${joinKey})`
  writer.used.add('find')
  if (operation.kind === 'link') {
    const insert = query(join, 'insert')
    const farRead = query(farInfo, 'getByKey')
    if (!insert || !farRead) return []
    // The initializer takes its arguments in the order of the columns
    const values = join.columns
      .filter((column) => every.includes(column))
      .map((column) => `${column.key}: ${column.prop}`)
      .join(', ')
    return [
      `/// Links a ${info.entity} and a ${farInfo.entity} (${join.name}).`,
      `public func ${name}(${params}) async throws {`,
      ...ind(
        inTransaction(
          [
            `_ = try await find(uow, ${ownCols.map((column) => column.prop).join(', ')})`,
            `if try await ${repo(farInfo)}.${queryName(context, farRead)}(${farCols.map((column) => column.prop).join(', ')}) == nil {`,
            `    throw DomainError.notFound(entity: ${swString(farInfo.entity)}, key: ${keyText(farCols)})`,
            '}',
            `if ${found} != nil {`,
            `    throw DomainError.conflict(entity: ${swString(info.entity)}, reason: ${swString(`is already linked to this ${farInfo.entity}`)}, fields: [${farCols.map((column) => swString(column.key)).join(', ')}])`,
            '}',
            `try await ${repo(join)}.${queryName(context, insert)}(${join.entity}(${values}))`,
          ],
          false,
        ),
      ),
      '}',
    ]
  }
  const remove = query(join, 'delete')
  if (!remove) return []
  return [
    `/// Removes the link between a ${info.entity} and a ${farInfo.entity} (${join.name}).`,
    `public func ${name}(${params}) async throws {`,
    ...ind(
      inTransaction(
        [
          `guard let link = ${found} else {`,
          `    throw DomainError.notFound(entity: ${swString(join.entity)}, key: ${keyText(join.key)})`,
          '}',
          `try await ${repo(join)}.${queryName(context, remove)}(link)`,
        ],
        false,
      ),
    ),
    '}',
  ]
}

const TRANSACTIONS = {
  operation: 'Each write runs in its own transaction.',
  caller: 'It never commits: the caller owns the transaction.',
  repository: 'Repositories commit every write.',
}

export function serviceFile(context: Context, info: TableInfo): GeneratedFile | null {
  if (!info.service) return null
  const dtos = context.settings.serviceTypes === 'dtos'
  const writer: Writer = { context, info, dtos, used: new Set() }
  const operations = info.operations.map((operation) => operationLines(writer, operation)).filter((block) => block.length > 0)
  const helpers: string[][] = []
  const used = writer.used
  if (used.has('checkValues') || used.has('apply') || used.has('given')) helpers.push(valuesStruct(info))
  if (used.has('checkValues')) helpers.push(checkFunctions(writer))
  if (used.has('apply')) helpers.push(applyFunction(info))
  if (used.has('given')) helpers.push(givenFunction(writer))
  if (used.has('find')) helpers.push(findFunction(writer))
  if (used.has('read')) helpers.push(readFunction(info))
  const hidden = info.hidden.length > 0 && !dtos
  return swFile(fileOf(context, info, 'service', serviceType(info)), imports('Foundation'), [
    `/// Operations on ${info.name}. ${TRANSACTIONS[context.settings.transactions]}`,
    `public struct ${serviceType(info)}: Sendable {`,
    ...(hidden
      ? [
          `    // TODO: ${info.hidden.join(', ')} ${info.hidden.length === 1 ? 'is' : 'are'} returned with the entity; use DTOs to leave ${info.hidden.length === 1 ? 'it' : 'them'} out`,
        ]
      : []),
    '    private let unitOfWork: any UnitOfWork',
    '',
    '    public init(unitOfWork: any UnitOfWork) {',
    '        self.unitOfWork = unitOfWork',
    '    }',
    ...operations.flatMap((block) => ['', ...ind(block)]),
    '}',
    ...helpers.flatMap((block) => ['', ...block]),
  ])
}
