/**
 * The service of each table: its operations and what each one checks before it writes, in the order of the design
 * (docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
 * version; then children and soft deletes. The values of a create or an update are gathered in a map of the fields
 * given, so every way an update can come is checked and applied the same way. Every write runs in
 * unitOfWork.transaction { ... }; errors are domain exceptions without HTTP codes. Mirrors php/common/services.ts.
 */
import type { OperationDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { DbCheck } from '../../schema/types.ts'
import {
  columnOf,
  commonPackage,
  errorsPackage,
  findInfo,
  ktFile,
  operationName,
  packageOf,
  pathOf,
  qualified,
  query,
  queryName,
  serviceClass,
  stored,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, readColumns, readDto, updateClass, updateColumns, updateType } from './dtos.ts'
import { KtImports, ktString } from './kotlin.ts'

interface Writer {
  context: Context
  info: TableInfo
  imports: KtImports
  dtos: boolean
}

type Block = string[]

const repo = (info: TableInfo, uow = 'uow') => `${uow}.${info.attr}`
const keyParams = (info: TableInfo) => info.key.map((column) => `${column.prop}: ${column.kt}`).join(', ')
const keyArgs = (info: TableInfo) => info.key.map((column) => column.prop).join(', ')
const keyValue = (info: TableInfo) => (info.key.length === 1 ? info.key[0].prop : `listOf(${keyArgs(info)})`)
const ind = (items: string[], spaces = 4) => items.map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))

/** The variables the checks already use: a column with one of these names gets `Value` after it. */
const TAKEN = new Set(['values', 'errors', 'creating', 'current', 'uow', 'value', 'other', 'entity', 'changes', 'data', 'link', 'row'])
const local = (column: ColumnInfo) => (TAKEN.has(column.key) ? `${column.key}Value` : column.prop)

const numericKinds = new Set(['integer', 'decimal', 'float'])

/** The value of a field as the change gives it, or as the row has it. */
const givenOrCurrent = (column: ColumnInfo) =>
  `val ${local(column)} = if (${ktString(column.key)} in values) values[${ktString(column.key)}] as ${column.kt}? else current?.${column.prop}`

const number = (value: number | string) => {
  const text = String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

function valueRules(column: ColumnInfo, checks: DbCheck[]): string[] {
  const rules: string[] = []
  const name = column.column.name
  const type = column.column.type
  const rule = (condition: string, message: string) => `if (${condition}) errors += FieldError(${ktString(name)}, ${ktString(message)})`
  if (type.kind === 'text' && type.length !== undefined)
    rules.push(rule(`value is String && value.length > ${type.length}`, `is longer than ${type.length} characters`))
  for (const check of checks) {
    const parsed = check.parsed
    if (!parsed || parsed.column !== name) continue
    if (parsed.kind === 'in') {
      const message = `must be one of: ${parsed.values.join(', ')}`
      if (numericKinds.has(type.kind))
        rules.push(rule(`(value as Number).toDouble() !in listOf(${parsed.values.map(number).join(', ')})`, message))
      else rules.push(rule(`value.toString() !in listOf(${parsed.values.map((item) => ktString(String(item))).join(', ')})`, message))
    }
    if (parsed.kind === 'compare')
      rules.push(rule(`!((value as Number).toDouble() ${parsed.op} ${number(parsed.value)})`, `must be ${parsed.op} ${parsed.value}`))
    if (parsed.kind === 'length')
      rules.push(rule(`!(value.toString().length ${parsed.op} ${parsed.value})`, `must have ${parsed.op} ${parsed.value} characters`))
  }
  return rules
}

function validateMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  imports.add(
    qualified(errorsPackage(context), 'FieldError'),
    qualified(errorsPackage(context), 'ValidationFailedException'),
    qualified(context.base, 'UnitOfWork'),
  )
  const blocks: string[][] = []
  for (const column of createColumns(info)) {
    const name = column.column.name
    const key = ktString(column.key)
    const missing = column.required
      ? { condition: `creating || ${key} in values`, message: 'is required' }
      : !column.column.nullable
        ? { condition: `!creating && ${key} in values`, message: 'cannot be empty' }
        : null
    const rules = valueRules(column, info.table.checks)
    if (!missing && rules.length === 0) continue
    const report = missing && `if (${missing.condition}) errors += FieldError(${ktString(name)}, ${ktString(missing.message)})`
    blocks.push([
      'run {',
      `    val value = values[${key}]`,
      ...(missing
        ? ['    if (value == null) {', `        ${report}`, ...(rules.length > 0 ? ['    } else {', ...ind(rules, 8)] : []), '    }']
        : ['    if (value != null) {', ...ind(rules, 8), '    }']),
      '}',
    ])
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
      'run {',
      ...columns.map((column) => `    ${givenOrCurrent(column)}`),
      `    if (${columns.map((column) => `${local(column)} != null`).join(' && ')} && ${repo(parent)}.${queryName(context, read)}(${columns.map(local).join(', ')}) == null)`,
      `        errors += FieldError(${ktString(key.columns.join(', '))}, ${ktString(`no ${parent.entity} has this key`)})`,
      '}',
    ])
  }
  return [
    `/** Checks the values against the rules of the "${info.name}" table, and the rows they point to; throws ValidationFailedException with every problem. */`,
    `private fun validate(uow: UnitOfWork, values: Map<String, Any?>, current: ${info.entity}?) {`,
    '    val creating = current == null',
    '    val errors = mutableListOf<FieldError>()',
    ...blocks.flatMap((block) => ind(block)),
    `    if (errors.isNotEmpty()) throw ValidationFailedException(${ktString(info.entity)}, errors)`,
    '}',
  ]
}

function uniqueMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const checks: string[][] = []
  for (const unique of info.table.uniques) {
    const read = query(info, 'findByUnique', unique.columns)
    if (!read) {
      checks.push([`// ${unique.columns.join(', ')} must be unique: the database refuses repeated values (ConflictException)`])
      continue
    }
    imports.add(qualified(errorsPackage(context), 'ConflictException'))
    const columns = unique.columns.map((name) => columnOf(info, name))
    const other = info.key.map((column) => `other.${column.prop} != current.${column.prop}`).join(' || ')
    checks.push([
      'run {',
      ...columns.map((column) => `    ${givenOrCurrent(column)}`),
      `    if (${columns.map((column) => `${local(column)} != null`).join(' && ')}) {`,
      `        val other = ${repo(info)}.${queryName(context, read)}(${columns.map(local).join(', ')})`,
      `        if (other != null && (current == null || ${other}))`,
      `            throw ConflictException(${ktString(info.entity)}, ${ktString(`${unique.columns.join(', ')} is already taken`)}, listOf(${columns.map((column) => ktString(column.key)).join(', ')}))`,
      '    }',
      '}',
    ])
  }
  if (checks.length === 0) return []
  return [
    '/** Values that must be unique are not taken by another row. */',
    `private fun checkUnique(uow: UnitOfWork, values: Map<String, Any?>, current: ${info.entity}?) {`,
    ...checks.flatMap((block) => ind(block)),
    '}',
  ]
}

function checkMethod(writer: Writer): Block {
  const { info } = writer
  return [
    '/** Every check before a write: the values, the rows they point to, the unique values. */',
    `private fun checkValues(uow: UnitOfWork, values: Map<String, Any?>, current: ${info.entity}?) {`,
    '    validate(uow, values, current)',
    ...(info.table.uniques.length > 0 ? ['    checkUnique(uow, values, current)'] : []),
    '}',
  ]
}

function applyMethod(writer: Writer): Block {
  const { info } = writer
  return [
    '/** Sets the given values on the entity. */',
    `private fun applyValues(entity: ${info.entity}, values: Map<String, Any?>) {`,
    ...createColumns(info).map(
      (column) => `    if (${ktString(column.key)} in values) entity.${column.prop} = values[${ktString(column.key)}] as ${column.kt}?`,
    ),
    '}',
  ]
}

function findMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const read = query(info, 'getByKey')
  if (!read) return []
  imports.add(qualified(errorsPackage(context), 'NotFoundException'), qualified(context.base, 'UnitOfWork'))
  return [
    `/** The ${info.entity} with this key; NotFoundException when there is none. */`,
    `private fun find(uow: UnitOfWork, ${keyParams(info)}): ${info.entity} =`,
    `    ${repo(info)}.${queryName(context, read)}(${keyArgs(info)}) ?: throw NotFoundException(${ktString(info.entity)}, ${keyValue(info)})`,
  ]
}

function readMethod(writer: Writer): Block {
  if (!writer.dtos) return []
  const { info } = writer
  return [
    `/** The ${info.entity} as services return it. */`,
    `private fun read(entity: ${info.entity}): ${readDto(info)} =`,
    `    ${readDto(info)}(`,
    ...readColumns(info).map((column) => `        ${column.prop} = ${stored(`entity.${column.prop}`, column)},`),
    '    )',
  ]
}

function givenMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const type = updateType(context, info)
  imports.add(updateClass(context, info))
  const mode = context.settings.updates
  return [
    '/** The values an update gives, by field. */',
    `private fun given(changes: ${type}): Map<String, Any?> {`,
    '    val values = mutableMapOf<String, Any?>()',
    ...updateColumns(info).map((column) =>
      mode === 'patch'
        ? `    if (changes.${column.prop}.isPresent) values[${ktString(column.key)}] = changes.${column.prop}.value`
        : mode === 'optional'
          ? `    changes.${column.prop}?.let { values[${ktString(column.key)}] = it.orElse(null) }`
          : `    values[${ktString(column.key)}] = changes.${column.prop}`,
    ),
    '    return values',
    '}',
  ]
}

const out = (writer: Writer, expression: string) => (writer.dtos ? `read(${expression})` : expression)
const resultType = (writer: Writer) => (writer.dtos ? readDto(writer.info) : writer.info.entity)

function versionCheck(writer: Writer): string[] {
  const version = writer.info.version
  if (!version) return []
  writer.imports.add(qualified(errorsPackage(writer.context), 'ConflictException'))
  return [
    `if (current.${version.prop} != version)`,
    `    throw ConflictException(${ktString(writer.info.entity)}, "was changed by someone else since it was read", listOf(${ktString(version.key)}))`,
  ]
}

function childrenLines(writer: Writer): string[] {
  const { context, info, imports } = writer
  if (!info.children) return []
  const result: string[] = []
  for (const link of info.children.links) {
    const child = findInfo(context, link.table)
    const list = child ? query(child, 'listByParent', link.columns) : undefined
    if (!child || !list) {
      result.push(`// TODO: rows of ${link.table} may point here; that table has no list by ${link.columns.join(', ')} to look for them`)
      continue
    }
    const args = link.references.map((name) => `current.${columnOf(info, name).prop}!!`).join(', ')
    const rows = `${repo(child)}.${queryName(context, list)}(${args})`
    if (info.children.policy === 'block') {
      imports.add(qualified(errorsPackage(context), 'ConflictException'))
      result.push(
        `if (${rows}.isNotEmpty())`,
        `    throw ConflictException(${ktString(info.entity)}, ${ktString(`rows of ${link.table} still point to it`)}, listOf(${ktString(link.table)}))`,
      )
    } else {
      const remove = query(child, 'delete')
      if (!remove) result.push(`// TODO: rows of ${link.table} must be deleted first, and that table has no delete`)
      else result.push(`${rows}.forEach { ${repo(child)}.${queryName(context, remove)}(it) }`)
    }
  }
  return result
}

const inTransaction = (items: string[]) => ['unitOfWork.transaction { uow ->', ...ind(items), '}']

function operationLines(writer: Writer, operation: OperationDesign): Block {
  const { context, info, imports } = writer
  const name = operationName(context, operation)
  const entity = info.entity
  switch (operation.kind) {
    case 'create': {
      const insert = query(info, 'insert')
      if (!insert) return []
      if (writer.dtos) imports.add(qualified(packageOf(context, info, 'dtos'), createDto(info)))
      const variable = `${entity.charAt(0).toLowerCase()}${entity.slice(1)}`
      const source = writer.dtos ? 'data' : variable
      return [
        `/** Stores a new ${entity} after checking it. */`,
        `fun ${name}(${writer.dtos ? `data: ${createDto(info)}` : `${variable}: ${entity}`}): ${resultType(writer)} {`,
        '    val values = mapOf(',
        ...createColumns(info).map((column) => `        ${ktString(column.key)} to ${source}.${column.prop},`),
        '    ).filterValues { it != null }',
        `    return ${inTransaction([
          'checkValues(uow, values, null)',
          ...(writer.dtos ? [`val entity = ${entity}()`, 'applyValues(entity, values)'] : []),
          out(writer, `${repo(info)}.${queryName(context, insert)}(${writer.dtos ? 'entity' : variable})`),
        ]).join('\n    ')}`,
        '}',
      ]
    }
    case 'get':
      if (!query(info, 'getByKey')) return []
      return [
        `/** The ${entity} with this key; NotFoundException when there is none. */`,
        `fun ${name}(${keyParams(info)}): ${resultType(writer)} = ${out(writer, `find(unitOfWork, ${keyArgs(info)})`)}`,
      ]
    case 'list': {
      const list = query(info, 'list')
      if (!list) return []
      const method = `unitOfWork.${info.attr}.${queryName(context, list)}`
      const mapped = writer.dtos ? '.map { read(it) }' : ''
      if (context.settings.paging === 'offset') {
        imports.add(qualified(commonPackage(context), 'Page'))
        return [
          `/** A page of ${info.name}, by primary key. */`,
          `fun ${name}(offset: Int, limit: Int): Page<${resultType(writer)}> = ${method}(offset, limit)${mapped}`,
        ]
      }
      if (context.settings.paging === 'cursor') {
        imports.add(qualified(commonPackage(context), 'CursorPage'))
        return [
          `/** A page of ${info.name} after the key after (null for the first page), by primary key. */`,
          `fun ${name}(after: List<Any>?, limit: Int): CursorPage<${resultType(writer)}> = ${method}(after, limit)${mapped}`,
        ]
      }
      return [`/** Every ${entity}, by primary key. */`, `fun ${name}(): List<${resultType(writer)}> = ${method}()${mapped}`]
    }
    case 'update': {
      const update = query(info, 'update')
      if (!update || !query(info, 'getByKey')) return []
      const version = info.version ? `, version: ${info.version.kt}` : ''
      return [
        `/** Changes the given values of a ${entity}${info.version ? ', read at version' : ''}. */`,
        `fun ${name}(${keyParams(info)}, changes: ${updateType(context, info)}${version}): ${resultType(writer)} {`,
        '    val values = given(changes)',
        `    return ${inTransaction([
          `val current = find(uow, ${keyArgs(info)})`,
          ...versionCheck(writer),
          'checkValues(uow, values, current)',
          'applyValues(current, values)',
          ...(info.version
            ? [`current.${info.version.prop} = ${info.version.kt === 'Short' ? '(version + 1).toShort()' : 'version + 1'}`]
            : []),
          out(writer, `${repo(info)}.${queryName(context, update)}(current)`),
        ]).join('\n    ')}`,
        '}',
      ]
    }
    case 'delete': {
      const remove = query(info, 'delete')
      const update = query(info, 'update')
      if (!query(info, 'getByKey') || (!info.soft && !remove) || (info.soft && !update)) return []
      const version = info.version ? `, version: ${info.version.kt}` : ''
      let mark = ''
      if (info.soft) {
        if (info.soft.column.type.kind === 'boolean') mark = 'true'
        else {
          if (info.soft.ktImport) imports.add(info.soft.ktImport)
          mark = `${info.soft.kt}.now()`
        }
      }
      const action = info.soft
        ? [`current.${info.soft.prop} = ${mark}`, `${repo(info)}.${queryName(context, update!)}(current)`]
        : [`${repo(info)}.${queryName(context, remove!)}(current)`]
      return [
        info.soft
          ? `/** Marks a ${entity} as deleted (${info.soft.column.name}); reads leave it out from then on. */`
          : `/** Deletes a ${entity}. */`,
        `fun ${name}(${keyParams(info)}${version}) {`,
        ...ind(inTransaction([`val current = find(uow, ${keyArgs(info)})`, ...versionCheck(writer), ...childrenLines(writer), ...action])),
        '}',
      ]
    }
    case 'find':
    case 'listByParent': {
      const read = query(info, operation.kind === 'find' ? 'findByUnique' : 'listByParent', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => columnOf(info, column))
      for (const column of columns) if (column.ktImport) imports.add(column.ktImport)
      const params = columns.map((column) => `${column.prop}: ${column.kt}`).join(', ')
      const rows = `unitOfWork.${info.attr}.${queryName(context, read)}(${columns.map((column) => column.prop).join(', ')})`
      if (operation.kind === 'find')
        return [
          `/** The ${entity} with this ${operation.columns.join(' and ')}, or null. */`,
          `fun ${name}(${params}): ${resultType(writer)}? = ${rows}${writer.dtos ? '?.let { read(it) }' : ''}`,
        ]
      return [
        `/** The ${info.name} with this ${operation.columns.join(' and ')}. */`,
        `fun ${name}(${params}): List<${resultType(writer)}> = ${rows}${writer.dtos ? '.map { read(it) }' : ''}`,
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

function linkLines(writer: Writer, operation: OperationDesign, name: string): Block {
  const { context, info, imports } = writer
  const join = operation.through ? findInfo(context, operation.through) : undefined
  if (!join) return []
  const own = join.table.foreignKeys.find((key) => key.references.table === info.name)
  const far = join.table.foreignKeys.find((key) => key !== own)
  const farInfo = far ? findInfo(context, far.references.table) : undefined
  const read = query(join, 'getByKey')
  if (!own || !far || !farInfo || !read) return []
  const ownCols = own.columns.map((column) => columnOf(join, column))
  const farCols = far.columns.map((column) => columnOf(join, column))
  const all = [...ownCols, ...farCols]
  for (const column of all) if (column.ktImport) imports.add(column.ktImport)
  const params = all.map((column) => `${column.prop}: ${column.kt}`).join(', ')
  const joinKey = join.key.map((column) => column.prop).join(', ')
  const found = `${repo(join)}.${queryName(context, read)}(${joinKey})`
  imports.add(qualified(errorsPackage(context), 'NotFoundException'))
  if (operation.kind === 'link') {
    const insert = query(join, 'insert')
    const farRead = query(farInfo, 'getByKey')
    if (!insert || !farRead || !query(info, 'getByKey')) return []
    imports.add(qualified(errorsPackage(context), 'ConflictException'), qualified(packageOf(context, join, 'entity'), join.entity))
    const farArgs = farCols.map((column) => column.prop).join(', ')
    return [
      `/** Links a ${info.entity} and a ${farInfo.entity} (${join.name}). */`,
      `fun ${name}(${params}) {`,
      ...ind(
        inTransaction([
          `find(uow, ${ownCols.map((column) => column.prop).join(', ')})`,
          `if (${repo(farInfo)}.${queryName(context, farRead)}(${farArgs}) == null)`,
          `    throw NotFoundException(${ktString(farInfo.entity)}, ${farCols.length === 1 ? farArgs : `listOf(${farArgs})`})`,
          `if (${found} != null)`,
          `    throw ConflictException(${ktString(info.entity)}, ${ktString(`is already linked to this ${farInfo.entity}`)}, listOf(${farCols.map((column) => ktString(column.key)).join(', ')}))`,
          `${repo(join)}.${queryName(context, insert)}(${join.entity}(${all.map((column) => `${column.prop} = ${column.prop}`).join(', ')}))`,
        ]),
      ),
      '}',
    ]
  }
  const remove = query(join, 'delete')
  if (!remove) return []
  return [
    `/** Removes the link between a ${info.entity} and a ${farInfo.entity} (${join.name}). */`,
    `fun ${name}(${params}) {`,
    ...ind(
      inTransaction([
        `val link = ${found} ?: throw NotFoundException(${ktString(join.entity)}, listOf(${joinKey}))`,
        `${repo(join)}.${queryName(context, remove)}(link)`,
      ]),
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
  const pkg = packageOf(context, info, 'service')
  const imports = new KtImports(pkg).add(qualified(packageOf(context, info, 'entity'), info.entity), qualified(context.base, 'UnitOfWork'))
  // The types the services name: the key, the version, and the values a write casts
  for (const column of info.key) if (column.ktImport) imports.add(column.ktImport)
  if (info.role === 'entity') for (const column of createColumns(info)) if (column.ktImport) imports.add(column.ktImport)
  if (info.version?.ktImport) imports.add(info.version.ktImport)
  const dtos = context.settings.serviceTypes === 'dtos'
  const writer: Writer = { context, info, imports, dtos }
  if (dtos) imports.add(qualified(packageOf(context, info, 'dtos'), readDto(info)))
  const writes = info.role === 'entity'
  const operations = info.operations.map((operation) => operationLines(writer, operation)).filter((block) => block.length > 0)
  const updates = info.operations.some((operation) => operation.kind === 'update') && query(info, 'update') && query(info, 'getByKey')
  const helpers: Block[] = [findMethod(writer), readMethod(writer)]
  if (writes) helpers.unshift(validateMethod(writer), uniqueMethod(writer), checkMethod(writer), applyMethod(writer))
  if (writes && updates) helpers.push(givenMethod(writer))
  const hidden = info.hidden.length > 0 && !dtos
  const members = [...operations, ...helpers.filter((block) => block.length > 0)]
  return ktFile(pathOf(pkg, serviceClass(info)), pkg, imports.write(), [
    `/** Operations on ${info.name}. ${TRANSACTIONS[context.settings.transactions]} */`,
    `class ${serviceClass(info)}(private val unitOfWork: UnitOfWork) {`,
    hidden &&
      `    // TODO: ${info.hidden.join(', ')} ${info.hidden.length === 1 ? 'is' : 'are'} returned with the entity; use DTOs to leave ${info.hidden.length === 1 ? 'it' : 'them'} out`,
    ...members.flatMap((block, index) => [...(index > 0 || hidden ? [''] : []), ...ind(block.flatMap((line) => line.split('\n')))]),
    '}',
  ])
}
