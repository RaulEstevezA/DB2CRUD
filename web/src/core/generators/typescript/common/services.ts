/**
 * The service of each table: its operations and what each one checks before it writes, in the order of the
 * design (docs/design.md, section 3): the values against the database's rules, the rows they point to, unique
 * values, the version; then children and soft deletes. Every write runs in `uow.transaction(...)`. Services take
 * and return entities or DTOs, as the settings say, and throw domain errors without HTTP codes.
 */
import type { OperationDesign } from '../../../crud/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbCheck } from '../../../schema/types.ts'
import { indent, lines, type Line } from '../../types.ts'
import { TsImports } from '../typescript.ts'
import {
  columnOf,
  findInfo,
  moduleOf,
  operationName,
  pathOf,
  query,
  queryName,
  serviceClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, readColumns, readDto, updateDto } from './dtos.ts'

type Block = (Line | Line[])[]

interface Writer {
  context: Context
  info: TableInfo
  imports: TsImports
  dtos: boolean
}

const repo = (info: TableInfo, uow = 'uow') => `${uow}.${info.attr}`

/** The body inside `this.uow.transaction(async (uow) => { … })`. */
function inTransaction(body: Block): Block {
  return ['return this.uow.transaction(async (uow) => {', indent(lines(...body), 2), '})']
}

const keyParams = (info: TableInfo) => info.key.map((column) => `${column.prop}: ${column.ts}`).join(', ')
const keyArgs = (info: TableInfo, target?: string) =>
  info.key.map((column) => (target ? `${target}.${column.prop}` : column.prop)).join(', ')
const keyValue = (info: TableInfo) => (info.key.length === 1 ? info.key[0].prop : `[${keyArgs(info)}]`)

/** True when `other` is another row than `current`, compared by key: ORMs return a new object for each read. */
const otherRow = (info: TableInfo) => info.key.map((column) => `other.${column.prop} !== current.${column.prop}`).join(' || ')

// Checks

/** The rules a value must follow, from the column's type and the CHECK constraints the rules understand. */
function valueRules(column: ColumnInfo, checks: DbCheck[]): string[] {
  const rules: string[] = []
  const name = column.column.name
  const type = column.column.type
  if (type.kind === 'text' && type.length !== undefined)
    rules.push(
      `if (typeof value === 'string' && value.length > ${type.length}) errors.push({ field: '${name}', message: 'is longer than ${type.length} characters' })`,
    )
  for (const check of checks) {
    const parsed = check.parsed
    if (!parsed || parsed.column !== name) continue
    if (parsed.kind === 'in')
      rules.push(
        `if (![${parsed.values.map((item) => JSON.stringify(item).replace(/"/g, "'")).join(', ')}].includes(value as never)) errors.push({ field: '${name}', message: 'must be one of: ${parsed.values.join(', ')}' })`,
      )
    if (parsed.kind === 'compare')
      rules.push(
        `if (!(Number(value) ${parsed.op} ${parsed.value})) errors.push({ field: '${name}', message: 'must be ${parsed.op} ${parsed.value}' })`,
      )
    if (parsed.kind === 'length')
      rules.push(
        `if (!(String(value).length ${parsed.op} ${parsed.value})) errors.push({ field: '${name}', message: 'must have ${parsed.op} ${parsed.value} characters' })`,
      )
  }
  return rules
}

function validateMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  imports.from('src/errors', 'ValidationFailedError').type('src/errors', 'FieldError').type('src/unit-of-work', 'UnitOfWork')
  const blocks: string[] = []
  for (const column of createColumns(info)) {
    const name = column.column.name
    const prop = column.prop
    const missing = column.required
      ? `if (creating || '${prop}' in values) errors.push({ field: '${name}', message: 'is required' })`
      : !column.column.nullable
        ? `if ('${prop}' in values && !creating) errors.push({ field: '${name}', message: 'cannot be empty' })`
        : null
    const rules = valueRules(column, info.table.checks)
    if (!missing && rules.length === 0) continue
    blocks.push(
      lines(
        '{',
        `  const value = values.${prop}`,
        missing
          ? [`  if (value == null) {`, `    ${missing}`, rules.length > 0 ? '  } else {' : '  }']
          : rules.length > 0 && '  if (value != null) {',
        ...rules.map((rule) => `    ${rule}`),
        rules.length > 0 && '  }',
        '}',
      ),
    )
  }
  // Parents
  for (const key of info.table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    const read = parent ? query(parent, 'getByKey') : undefined
    const sameKey = parent && parent.key.map((column) => column.column.name).join(',') === key.references.columns.join(',')
    if (!parent || !read || !sameKey) {
      blocks.push(
        `// TODO: ${key.columns.join(', ')} must point to a row of ${key.references.table}; that table has no read by key to check it`,
      )
      continue
    }
    const props = key.columns.map((name) => columnOf(info, name).prop)
    const types = parent.key.map((column) => column.ts)
    blocks.push(
      lines(
        '{',
        ...props.map((prop) => `  const ${prop} = '${prop}' in values ? values.${prop} : current?.${prop}`),
        `  if (${props.map((prop) => `${prop} != null`).join(' && ')} && (await ${repo(parent)}.${queryName(context, read)}(${props.map((prop, index) => `${prop} as ${types[index]}`).join(', ')})) === null)`,
        `    errors.push({ field: '${key.columns.join(', ')}', message: 'no ${parent.entity} has this key' })`,
        '}',
      ),
    )
  }
  // The key, what the database fills, and what the service itself keeps (the version, the soft-delete mark)
  const unchangeable = info.columns.filter(
    (column) => column.generated || info.key.includes(column) || column === info.version || column === info.soft,
  )
  return [
    `/** Checks the values against the rules of the "${info.name}" table, and the rows they point to; throws ValidationFailedError with every problem. */`,
    `private async validate(uow: UnitOfWork, values: Partial<Record<string, unknown>>, current: ${info.entity} | null): Promise<void> {`,
    '  const creating = current === null',
    '  const errors: FieldError[] = []',
    `  for (const name of Object.keys(values)) if (!FIELDS.has(name)) errors.push({ field: name, message: 'is not a field of ${info.entity}' })`,
    unchangeable.length > 0 &&
      `  if (!creating) for (const name of Object.keys(values)) if ([${unchangeable.map((column) => `'${column.prop}'`).join(', ')}].includes(name)) errors.push({ field: name, message: 'cannot be changed' })`,
    ...blocks.map((block) => indent(block, 2)),
    `  if (errors.length > 0) throw new ValidationFailedError('${info.entity}', errors)`,
    '}',
  ]
}

function uniqueMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const checks: string[] = []
  for (const unique of info.table.uniques) {
    const read = query(info, 'findByUnique', unique.columns)
    if (!read) {
      checks.push(`// ${unique.columns.join(', ')} must be unique: the database refuses repeated values (ConflictError)`)
      continue
    }
    imports.from('src/errors', 'ConflictError')
    const columns = unique.columns.map((name) => columnOf(info, name))
    checks.push(
      lines(
        '{',
        ...columns.map(
          (column) =>
            `  const ${column.prop} = ('${column.prop}' in values ? values.${column.prop} : current?.${column.prop}) as ${column.ts} | null | undefined`,
        ),
        `  if (${columns.map((column) => `${column.prop} != null`).join(' && ')}) {`,
        `    const other = await ${repo(info)}.${queryName(context, read)}(${columns.map((column) => column.prop).join(', ')})`,
        `    if (other !== null && (current === null || ${otherRow(info)}))`,
        `      throw new ConflictError('${info.entity}', '${unique.columns.join(', ')} is already taken', [${columns.map((column) => `'${column.prop}'`).join(', ')}])`,
        '  }',
        '}',
      ),
    )
  }
  if (checks.length === 0) return []
  return [
    '/** Values that must be unique are not taken by another row. */',
    `private async checkUnique(uow: UnitOfWork, values: Partial<Record<string, unknown>>, current: ${info.entity} | null): Promise<void> {`,
    ...checks.map((check) => indent(check, 2)),
    '}',
  ]
}

function checkMethod(writer: Writer): Block {
  const { info } = writer
  return [
    '/** Every check before a write: the values, the rows they point to, the unique values. */',
    `private async check(uow: UnitOfWork, values: Partial<Record<string, unknown>>, current: ${info.entity} | null): Promise<void> {`,
    '  await this.validate(uow, values, current)',
    info.table.uniques.length > 0 && '  await this.checkUnique(uow, values, current)',
    '}',
  ]
}

function findMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const read = query(info, 'getByKey')
  if (!read) return []
  imports.from('src/errors', 'NotFoundError').type('src/unit-of-work', 'UnitOfWork')
  return [
    `/** The ${info.entity} with this key; NotFoundError when there is none. */`,
    `private async find(uow: UnitOfWork, ${keyParams(info)}): Promise<${info.entity}> {`,
    `  const entity = await ${repo(info)}.${queryName(context, read)}(${keyArgs(info)})`,
    `  if (entity === null) throw new NotFoundError('${info.entity}', ${keyValue(info)})`,
    '  return entity',
    '}',
  ]
}

function readMethod(writer: Writer): Block {
  if (!writer.dtos) return []
  const { info } = writer
  return [
    `/** The ${info.entity} as services return it. */`,
    `private static read(entity: ${info.entity}): ${readDto(info)} {`,
    `  return { ${readColumns(info)
      .map((column) => `${column.prop}: entity.${column.prop}`)
      .join(', ')} }`,
    '}',
  ]
}

const out = (writer: Writer, expression: string) => (writer.dtos ? `${serviceClass(writer.info)}.read(${expression})` : expression)
const resultType = (writer: Writer) => (writer.dtos ? readDto(writer.info) : writer.info.entity)

/** The values an object sets, leaving out what is undefined. */
const defined = (variable: string) => `Object.fromEntries(Object.entries(${variable}).filter(([, value]) => value !== undefined))`

// Operations

function versionCheck(writer: Writer): Line[] {
  const version = writer.info.version
  if (!version) return []
  writer.imports.from('src/errors', 'ConflictError')
  return [
    `if (current.${version.prop} !== version)`,
    `  throw new ConflictError('${writer.info.entity}', 'was changed by someone else since it was read', ['${version.prop}'])`,
  ]
}

function childrenLines(writer: Writer): Line[] {
  const { context, info, imports } = writer
  if (!info.children) return []
  const result: Line[] = []
  for (const link of info.children.links) {
    const child = findInfo(context, link.table)
    const list = child ? query(child, 'listByParent', link.columns) : undefined
    if (!child || !list) {
      result.push(`// TODO: rows of ${link.table} may point here; that table has no list by ${link.columns.join(', ')} to look for them`)
      continue
    }
    const args = link.references.map((name) => `current.${columnOf(info, name).prop}`).join(', ')
    const rows = `await ${repo(child)}.${queryName(context, list)}(${args})`
    if (info.children.policy === 'block') {
      imports.from('src/errors', 'ConflictError')
      result.push(
        `if ((${rows}).length > 0) throw new ConflictError('${info.entity}', 'rows of ${link.table} still point to it', ['${link.table}'])`,
      )
    } else {
      const remove = query(child, 'delete')
      if (!remove) result.push(`// TODO: rows of ${link.table} must be deleted first, and that table has no delete`)
      else result.push(`for (const row of ${rows}) await ${repo(child)}.${queryName(context, remove)}(row)`)
    }
  }
  return result
}

function operationLines(writer: Writer, operation: OperationDesign): Block {
  const { context, info, imports } = writer
  const name = operationName(context, operation)
  const entity = info.entity
  switch (operation.kind) {
    case 'create': {
      const insert = query(info, 'insert')
      if (!insert) return []
      if (writer.dtos) imports.type(moduleOf(context, info, 'dtos'), createDto(info))
      const variable = entity.charAt(0).toLowerCase() + entity.slice(1)
      const param = writer.dtos ? `data: ${createDto(info)}` : `${variable}: ${entity}`
      const values = writer.dtos
        ? defined('data')
        : `Object.fromEntries([...FIELDS].map((field) => [field, (${variable} as unknown as Record<string, unknown>)[field]]))`
      const stored = writer.dtos ? `Object.assign(new ${entity}(), values)` : variable
      return [
        `/** Stores a new ${entity} after checking it. */`,
        `async ${name}(${param}): Promise<${resultType(writer)}> {`,
        `  const values: Partial<Record<string, unknown>> = ${values}`,
        indent(
          lines(
            ...inTransaction([
              'await this.check(uow, values, null)',
              `const created = await ${repo(info)}.${queryName(context, insert)}(${stored})`,
              `return ${out(writer, 'created')}`,
            ]),
          ),
          2,
        ),
        '}',
      ]
    }
    case 'get':
      if (!query(info, 'getByKey')) return []
      return [
        `/** The ${entity} with this key; NotFoundError when there is none. */`,
        `async ${name}(${keyParams(info)}): Promise<${resultType(writer)}> {`,
        `  return ${out(writer, `await this.find(this.uow, ${keyArgs(info)})`)}`,
        '}',
      ]
    case 'list': {
      const list = query(info, 'list')
      if (!list) return []
      const method = `this.uow.${info.attr}.${queryName(context, list)}`
      if (context.settings.paging === 'offset') {
        imports.type('src/paging', 'Page')
        return [
          `/** A page of ${info.name}, by primary key. */`,
          `async ${name}(offset = 0, limit = 50): Promise<Page<${resultType(writer)}>> {`,
          writer.dtos
            ? [
                `  const page = await ${method}(offset, limit)`,
                `  return { ...page, items: page.items.map((entity) => ${serviceClass(info)}.read(entity)) }`,
              ]
            : `  return ${method}(offset, limit)`,
          '}',
        ]
      }
      if (context.settings.paging === 'cursor') {
        imports.type('src/paging', 'CursorPage')
        return [
          `/** A page of ${info.name} after the key \`after\`, by primary key. */`,
          `async ${name}(after: unknown[] | null = null, limit = 50): Promise<CursorPage<${resultType(writer)}>> {`,
          writer.dtos
            ? [
                `  const page = await ${method}(after, limit)`,
                `  return { ...page, items: page.items.map((entity) => ${serviceClass(info)}.read(entity)) }`,
              ]
            : `  return ${method}(after, limit)`,
          '}',
        ]
      }
      return [
        `/** Every ${entity}, by primary key. */`,
        `async ${name}(): Promise<${resultType(writer)}[]> {`,
        writer.dtos ? `  return (await ${method}()).map((entity) => ${serviceClass(info)}.read(entity))` : `  return ${method}()`,
        '}',
      ]
    }
    case 'update': {
      const update = query(info, 'update')
      if (!update || !query(info, 'getByKey')) return []
      if (writer.dtos) imports.type(moduleOf(context, info, 'dtos'), updateDto(info))
      const param = writer.dtos ? `data: ${updateDto(info)}` : `changes: Partial<${entity}>`
      const version = info.version ? `, version: ${info.version.ts}` : ''
      return [
        `/** Changes the given values of a ${entity}${info.version ? ', read at `version`' : ''}. */`,
        `async ${name}(${keyParams(info)}, ${param}${version}): Promise<${resultType(writer)}> {`,
        `  const values: Partial<Record<string, unknown>> = ${defined(writer.dtos ? 'data' : 'changes')}`,
        indent(
          lines(
            ...inTransaction([
              `const current = await this.find(uow, ${keyArgs(info)})`,
              ...versionCheck(writer),
              'await this.check(uow, values, current)',
              'Object.assign(current, values)',
              info.version && `current.${info.version.prop} = version + 1`,
              `const updated = await ${repo(info)}.${queryName(context, update)}(current)`,
              `return ${out(writer, 'updated')}`,
            ]),
          ),
          2,
        ),
        '}',
      ]
    }
    case 'delete': {
      const remove = query(info, 'delete')
      const update = query(info, 'update')
      if (!query(info, 'getByKey') || (!info.soft && !remove) || (info.soft && !update)) return []
      const version = info.version ? `, version: ${info.version.ts}` : ''
      const action = info.soft
        ? [
            `current.${info.soft.prop} = ${info.soft.column.type.kind === 'boolean' ? 'true' : 'new Date()'}`,
            `await ${repo(info)}.${queryName(context, update!)}(current)`,
          ]
        : [`await ${repo(info)}.${queryName(context, remove!)}(current)`]
      return [
        info.soft
          ? `/** Marks a ${entity} as deleted (${info.soft.column.name}); reads leave it out from then on. */`
          : `/** Deletes a ${entity}. */`,
        `async ${name}(${keyParams(info)}${version}): Promise<void> {`,
        indent(
          lines(
            ...inTransaction([
              `const current = await this.find(uow, ${keyArgs(info)})`,
              ...versionCheck(writer),
              ...childrenLines(writer),
              ...action,
            ]),
          ),
          2,
        ),
        '}',
      ]
    }
    case 'find':
    case 'listByParent': {
      const read = query(info, operation.kind === 'find' ? 'findByUnique' : 'listByParent', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => columnOf(info, column))
      const params = columns.map((column) => `${column.prop}: ${column.ts}`).join(', ')
      const rows = `await this.uow.${info.attr}.${queryName(context, read)}(${columns.map((column) => column.prop).join(', ')})`
      if (operation.kind === 'find')
        return [
          `/** The ${entity} with this ${operation.columns.join(' and ')}, or null. */`,
          `async ${name}(${params}): Promise<${resultType(writer)} | null> {`,
          writer.dtos
            ? [`  const entity = ${rows}`, `  return entity === null ? null : ${serviceClass(info)}.read(entity)`]
            : `  return ${rows}`,
          '}',
        ]
      return [
        `/** The ${info.name} with this ${operation.columns.join(' and ')}. */`,
        `async ${name}(${params}): Promise<${resultType(writer)}[]> {`,
        writer.dtos ? `  return (${rows}).map((entity) => ${serviceClass(info)}.read(entity))` : `  return ${rows}`,
        '}',
      ]
    }
    case 'link':
    case 'unlink':
      return linkLines(writer, operation, name)
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
  const params = [...ownCols, ...farCols].map((column) => `${column.prop}: ${column.ts}`).join(', ')
  const joinKey = join.key.map((column) => column.prop).join(', ')
  const found = `await ${repo(join)}.${queryName(context, read)}(${joinKey})`
  imports.from('src/errors', 'NotFoundError').from(moduleOf(context, join, 'entity'), join.entity)
  if (operation.kind === 'link') {
    const insert = query(join, 'insert')
    const farRead = query(farInfo, 'getByKey')
    if (!insert || !farRead || !query(info, 'getByKey')) return []
    imports.from('src/errors', 'ConflictError')
    const farArgs = farCols.map((column) => column.prop).join(', ')
    return [
      `/** Links a ${info.entity} and a ${farInfo.entity} (${join.name}). */`,
      `async ${name}(${params}): Promise<void> {`,
      indent(
        lines(
          ...inTransaction([
            `await this.find(uow, ${ownCols.map((column) => column.prop).join(', ')})`,
            `if ((await ${repo(farInfo)}.${queryName(context, farRead)}(${farArgs})) === null) throw new NotFoundError('${farInfo.entity}', ${farCols.length === 1 ? farArgs : `[${farArgs}]`})`,
            `if (${found} !== null) throw new ConflictError('${info.entity}', 'is already linked to this ${farInfo.entity}', [${farCols.map((column) => `'${column.prop}'`).join(', ')}])`,
            `await ${repo(join)}.${queryName(context, insert)}(Object.assign(new ${join.entity}(), { ${[...ownCols, ...farCols].map((column) => column.prop).join(', ')} }))`,
          ]),
        ),
        2,
      ),
      '}',
    ]
  }
  const remove = query(join, 'delete')
  if (!remove) return []
  return [
    `/** Removes the link between a ${info.entity} and a ${farInfo.entity} (${join.name}). */`,
    `async ${name}(${params}): Promise<void> {`,
    indent(
      lines(
        ...inTransaction([
          `const link = ${found}`,
          `if (link === null) throw new NotFoundError('${join.entity}', [${joinKey}])`,
          `await ${repo(join)}.${queryName(context, remove)}(link)`,
        ]),
      ),
      2,
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
  const module = moduleOf(context, info, 'service')
  const imports = new TsImports(module).from(moduleOf(context, info, 'entity'), info.entity).type('src/unit-of-work', 'UnitOfWork')
  const dtos = context.settings.serviceTypes === 'dtos'
  const writer: Writer = { context, info, imports, dtos }
  if (dtos) imports.type(moduleOf(context, info, 'dtos'), readDto(info))
  const writes = info.role === 'entity'
  const operations = info.operations.map((operation) => operationLines(writer, operation)).filter((block) => block.length > 0)
  const helpers: Block[] = [findMethod(writer), readMethod(writer)]
  if (writes) helpers.unshift(validateMethod(writer), uniqueMethod(writer), checkMethod(writer))
  const hidden = info.hidden.length > 0 && !dtos
  const content = lines(
    `/** Operations on ${info.name}: what each one checks before it writes. */`,
    imports.write(),
    '',
    writes && [
      '/** Properties a client may send: the database fills the others */',
      `const FIELDS = new Set([${createColumns(info)
        .map((column) => `'${column.prop}'`)
        .join(', ')}])`,
      '',
    ],
    `/** Operations on ${info.name}. ${TRANSACTIONS[context.settings.transactions]} */`,
    `export class ${serviceClass(info)} {`,
    hidden &&
      `  // TODO: ${info.hidden.join(', ')} ${info.hidden.length === 1 ? 'is' : 'are'} returned with the entity; use DTOs to leave ${info.hidden.length === 1 ? 'it' : 'them'} out`,
    '  constructor(private readonly uow: UnitOfWork) {}',
    ...[...helpers, ...operations].filter((block) => block.length > 0).flatMap((block) => ['', indent(lines(...block), 2)]),
    '}',
    '',
  )
  return { path: pathOf(module), content }
}
