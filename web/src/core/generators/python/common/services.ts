/**
 * The service of each table: its operations and what each one checks before it writes, in the order of the
 * design (docs/design.md, section 3): the values against the database's rules, the rows they point to,
 * unique values, the version; then children and soft deletes. Services take and return entities or DTOs,
 * as the settings say, and raise domain errors without HTTP codes.
 */
import type { OperationDesign } from '../../../crud/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbCheck } from '../../../schema/types.ts'
import { indent, lines, type Line } from '../../types.ts'
import { Imports, snakeName } from '../python.ts'
import {
  aw,
  columnPyType,
  def,
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

/** Lines of a method, where a nested list is a group that applies or not as a whole. */
type Block = (Line | Line[])[]

interface Writer {
  context: Context
  info: TableInfo
  imports: Imports
  dtos: boolean
  a: string
  def: string
}

const call = (writer: Writer, expression: string) => `${writer.a}${expression}`

/** `with self._uow.transaction():` around the body, when operations own their transaction. */
function inTransaction(writer: Writer, body: Block): Block {
  if (writer.context.settings.transactions !== 'operation') return body
  return [`${writer.context.async ? 'async with' : 'with'} self._uow.transaction():`, indent(lines(...body))]
}

const repo = (info: TableInfo) => `self._uow.${info.attr}`

function keyParams(writer: Writer, info: TableInfo = writer.info): string {
  return info.key.map((column) => `${column.attr}: ${columnPyType(column, writer.imports, false)}`).join(', ')
}

const keyArgs = (info: TableInfo, target?: string) =>
  info.key.map((column) => (target ? `${target}.${column.attr}` : column.attr)).join(', ')
const keyValue = (info: TableInfo) => (info.key.length === 1 ? info.key[0].attr : `(${keyArgs(info)})`)

// Checks

/** The rules a value must follow, from the column's type and the CHECK constraints the rules understand. */
function valueRules(column: ColumnInfo, checks: DbCheck[]): string[] {
  const rules: string[] = []
  const name = column.column.name
  const type = column.column.type
  if (type.kind === 'text' && type.length !== undefined)
    rules.push(
      `if isinstance(value, str) and len(value) > ${type.length}:\n    errors.append(FieldError("${name}", "is longer than ${type.length} characters"))`,
    )
  for (const check of checks) {
    const parsed = check.parsed
    if (!parsed || parsed.column !== name) continue
    if (parsed.kind === 'in')
      rules.push(
        `if value not in (${parsed.values.map((item) => JSON.stringify(item)).join(', ')},):\n    errors.append(FieldError("${name}", "must be one of: ${parsed.values.join(', ')}"))`,
      )
    if (parsed.kind === 'compare')
      rules.push(
        `if not value ${parsed.op} ${parsed.value}:\n    errors.append(FieldError("${name}", "must be ${parsed.op} ${parsed.value}"))`,
      )
    if (parsed.kind === 'length')
      rules.push(
        `if not len(value) ${parsed.op} ${parsed.value}:\n    errors.append(FieldError("${name}", "must have ${parsed.op} ${parsed.value} characters"))`,
      )
  }
  return rules
}

function validateMethod(writer: Writer): Block {
  const { info, imports } = writer
  imports.from('app.errors', 'FieldError', 'ValidationFailedError').from('typing', 'Any')
  const editable = createColumns(info)
  const blocks = editable.map((column) => {
    const name = column.column.name
    const attr = column.attr
    const missing = column.required
      ? `if creating or "${attr}" in values:\n        errors.append(FieldError("${name}", "is required"))`
      : !column.column.nullable
        ? `if "${attr}" in values and not creating:\n        errors.append(FieldError("${name}", "cannot be empty"))`
        : 'pass'
    const rules = valueRules(column, info.table.checks)
    // A nullable column without rules has nothing to check
    if (missing === 'pass' && rules.length === 0) return ''
    if (missing === 'pass') return lines(`value = values.get("${attr}")`, 'if value is not None:', ...rules.map((rule) => indent(rule)))
    return lines(
      `value = values.get("${attr}")`,
      'if value is None:',
      `    ${missing}`,
      rules.length > 0 && ['else:', ...rules.map((rule) => indent(rule))],
    )
  })
  // The key, what the database fills, and what the service itself keeps (the version, the soft-delete mark)
  const unchangeable = info.columns
    .filter((column) => column.generated || info.key.includes(column) || column === info.version || column === info.soft)
    .map((column) => `"${column.attr}"`)
  return [
    'def _validate(self, values: dict[str, Any], creating: bool) -> None:',
    `    """Checks the values against the rules of the "${info.name}" table; raises ValidationFailedError with every problem."""`,
    '    errors: list[FieldError] = []',
    `    for name in values.keys() - _FIELDS:`,
    `        errors.append(FieldError(name, "is not a field of ${info.entity}"))`,
    unchangeable.length > 0 && [
      `    if not creating:`,
      `        for name in values.keys() & {${unchangeable.join(', ')}}:`,
      '            errors.append(FieldError(name, "cannot be changed"))',
    ],
    ...blocks.filter((block) => block !== '').map((block) => indent(block)),
    ...parentChecks(writer).map((line) => (typeof line === 'string' ? indent(line) : line)),
    '    if errors:',
    `        raise ValidationFailedError("${info.entity}", errors)`,
  ]
}

/** The rows each foreign key points to must exist; checked through the parent's repository. */
function parentChecks(writer: Writer): Block {
  const { context, info } = writer
  const checks: Block = []
  for (const key of info.table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    const read = parent ? query(parent, 'getByKey') : undefined
    const sameKey = parent && parent.key.map((column) => column.column.name).join(',') === key.references.columns.join(',')
    if (!parent || !read || !sameKey) {
      checks.push(
        `# TODO: ${key.columns.join(', ')} must point to a row of ${key.references.table}; that table has no read by key to check it`,
      )
      continue
    }
    const attrs = key.columns.map((name) => info.columns.find((column) => column.column.name === name)!.attr)
    for (const attr of attrs)
      checks.push(`${attr} = values["${attr}"] if "${attr}" in values else (getattr(current, "${attr}") if current is not None else None)`)
    const present = attrs.map((attr) => `${attr} is not None`).join(' and ')
    checks.push(
      `if ${present} and ${call(writer, `${repo(parent)}.${queryName(context, read)}(${attrs.join(', ')})`)} is None:`,
      `    errors.append(FieldError("${key.columns.join(', ')}", "no ${parent.entity} has this key"))`,
    )
  }
  return checks
}

function uniqueMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const checks: Block = []
  for (const unique of info.table.uniques) {
    const read = query(info, 'findByUnique', unique.columns)
    if (!read) {
      checks.push(`# ${unique.columns.join(', ')} must be unique: the database refuses repeated values (ConflictError)`)
      continue
    }
    imports.from('app.errors', 'ConflictError')
    const attrs = unique.columns.map((name) => info.columns.find((column) => column.column.name === name)!.attr)
    for (const attr of attrs)
      checks.push(`${attr} = values["${attr}"] if "${attr}" in values else (current.${attr} if current is not None else None)`)
    checks.push(
      `if ${attrs.map((attr) => `${attr} is not None`).join(' and ')}:`,
      `    other = ${call(writer, `${repo(info)}.${queryName(context, read)}(${attrs.join(', ')})`)}`,
      // Another row, by its key: ORMs without an identity map (Django) return a new object for the same row
      `    if other is not None and (current is None or ${sameKey(info)}):`,
      `        raise ConflictError("${info.entity}", "${unique.columns.join(', ')} is already taken", (${attrs.map((attr) => `"${attr}"`).join(', ')},))`,
    )
  }
  if (checks.length === 0) return []
  return [
    `${writer.def} _check_unique(self, values: dict[str, Any], current: ${info.entity} | None) -> None:`,
    '    """Values that must be unique are not taken by another row."""',
    ...checks.map((line) => (typeof line === 'string' ? indent(line) : line)),
  ]
}

/** True when `other` is another row than `current`, compared by key. */
const sameKey = (info: TableInfo) =>
  info.key.length === 1
    ? `other.${info.key[0].attr} != current.${info.key[0].attr}`
    : `(${info.key.map((column) => `other.${column.attr}`).join(', ')}) != (${info.key.map((column) => `current.${column.attr}`).join(', ')})`

const hasUniqueCheck = (writer: Writer) => writer.info.table.uniques.length > 0

function checkMethod(writer: Writer): Block {
  const { info } = writer
  const async = writer.context.async
  return [
    `${writer.def} _check(self, values: dict[str, Any], current: ${info.entity} | None) -> None:`,
    '    """Every check before a write: the values, the rows they point to, the unique values."""',
    `    ${async ? 'await ' : ''}self._validate_all(values, current)`,
    hasUniqueCheck(writer) && `    ${call(writer, 'self._check_unique(values, current)')}`,
  ]
}

/** `_validate` with the parent checks needs the repositories, so it is asynchronous when they are. */
function validateAll(writer: Writer): Block {
  const method = validateMethod(writer)
  const [, doc, ...body] = method
  return [
    `${writer.def} _validate_all(self, values: dict[str, Any], current: ${writer.info.entity} | None) -> None:`,
    doc,
    '    creating = current is None',
    ...body,
  ]
}

function findMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const read = query(info, 'getByKey')
  if (!read) return []
  imports.from('app.errors', 'NotFoundError')
  return [
    `${writer.def} _find(self, ${keyParams(writer)}) -> ${info.entity}:`,
    `    """The ${info.entity} with this key; NotFoundError when there is none."""`,
    `    entity = ${call(writer, `${repo(info)}.${queryName(context, read)}(${keyArgs(info)})`)}`,
    '    if entity is None:',
    `        raise NotFoundError("${info.entity}", ${keyValue(info)})`,
    '    return entity',
  ]
}

// Conversions

function readMethod(writer: Writer): Block {
  if (!writer.dtos) return []
  const { info } = writer
  const body =
    writer.context.settings.dtoKind === 'pydantic'
      ? `    return ${readDto(info)}.model_validate(entity)`
      : `    return ${readDto(info)}(${readColumns(info)
          .map((column) => `${column.attr}=entity.${column.attr}`)
          .join(', ')})`
  return [
    '@staticmethod',
    `def _read(entity: ${info.entity}) -> ${readDto(info)}:`,
    `    """The ${info.entity} as services return it."""`,
    body,
  ]
}

/** The values a DTO carries, leaving out the fields it does not set. */
function dumped(writer: Writer, variable: string): string {
  if (writer.context.settings.dtoKind === 'pydantic') return `${variable}.model_dump(exclude_unset=True)`
  writer.imports.from('dataclasses', 'asdict')
  return `{name: value for name, value in asdict(${variable}).items() if value is not None}`
}

const out = (writer: Writer, expression: string) => (writer.dtos ? `self._read(${expression})` : expression)
const resultType = (writer: Writer) => (writer.dtos ? readDto(writer.info) : writer.info.entity)

// Operations

function versionCheck(writer: Writer): Block {
  const version = writer.info.version
  if (!version) return []
  writer.imports.from('app.errors', 'ConflictError')
  return [
    `if current.${version.attr} != version:`,
    `    raise ConflictError("${writer.info.entity}", "was changed by someone else since it was read", ("${version.attr}",))`,
  ]
}

function childrenLines(writer: Writer): Block {
  const { context, info, imports } = writer
  const children = info.children
  if (!children) return []
  const result: Block = []
  for (const link of children.links) {
    const child = findInfo(context, link.table)
    const list = child ? query(child, 'listByParent', link.columns) : undefined
    if (!child || !list) {
      result.push(`# TODO: rows of ${link.table} may point here; that table has no list by ${link.columns.join(', ')} to look for them`)
      continue
    }
    const args = link.references.map((name) => `current.${info.columns.find((column) => column.column.name === name)!.attr}`).join(', ')
    const rows = call(writer, `${repo(child)}.${queryName(context, list)}(${args})`)
    if (children.policy === 'block') {
      imports.from('app.errors', 'ConflictError')
      result.push(`if ${rows}:`, `    raise ConflictError("${info.entity}", "rows of ${link.table} still point to it", ("${link.table}",))`)
    } else {
      const remove = query(child, 'delete')
      if (!remove) result.push(`# TODO: rows of ${link.table} must be deleted first, and that table has no delete`)
      else result.push(`for row in ${rows}:`, `    ${call(writer, `${repo(child)}.${queryName(context, remove)}(row)`)}`)
    }
  }
  return result
}

function operationLines(writer: Writer, operation: OperationDesign): Block {
  const { context, info, imports } = writer
  const name = operationName(context, operation)
  const entity = info.entity
  const methodDef = writer.def
  switch (operation.kind) {
    case 'create': {
      const insert = query(info, 'insert')
      if (!insert) return []
      const param = writer.dtos ? `data: ${createDto(info)}` : `${snakeName(entity)}: ${entity}`
      const values = writer.dtos ? dumped(writer, 'data') : `{name: getattr(${snakeName(entity)}, name) for name in _FIELDS}`
      const stored = writer.dtos ? `${entity}(**values)` : snakeName(entity)
      return [
        `${methodDef} ${name}(self, ${param}) -> ${resultType(writer)}:`,
        `    """Stores a new ${entity} after checking it."""`,
        `    values = ${values}`,
        indent(
          lines(
            ...inTransaction(writer, [
              call(writer, 'self._check(values, None)'),
              `created = ${call(writer, `${repo(info)}.${queryName(context, insert)}(${stored})`)}`,
              `return ${out(writer, 'created')}`,
            ]),
          ),
        ),
      ]
    }
    case 'get':
      if (!query(info, 'getByKey')) return []
      return [
        `${methodDef} ${name}(self, ${keyParams(writer)}) -> ${resultType(writer)}:`,
        `    """The ${entity} with this key; NotFoundError when there is none."""`,
        `    return ${out(writer, call(writer, `self._find(${keyArgs(info)})`))}`,
      ]
    case 'list': {
      const list = query(info, 'list')
      if (!list) return []
      const paging = context.settings.paging
      const method = `${repo(info)}.${queryName(context, list)}`
      if (paging === 'offset') {
        imports.from('app.paging', 'Page')
        return [
          `${methodDef} ${name}(self, offset: int = 0, limit: int = 50) -> Page[${resultType(writer)}]:`,
          `    """A page of ${info.name}, by primary key."""`,
          writer.dtos
            ? [
                `    page = ${call(writer, `${method}(offset, limit)`)}`,
                '    return Page(items=[self._read(entity) for entity in page.items], total=page.total, offset=page.offset, limit=page.limit)',
              ]
            : `    return ${call(writer, `${method}(offset, limit)`)}`,
        ]
      }
      if (paging === 'cursor') {
        imports.from('app.paging', 'CursorPage')
        return [
          `${methodDef} ${name}(self, after: tuple[Any, ...] | None = None, limit: int = 50) -> CursorPage[${resultType(writer)}]:`,
          `    """A page of ${info.name} after the key \`after\`, by primary key."""`,
          writer.dtos
            ? [
                `    page = ${call(writer, `${method}(after, limit)`)}`,
                '    return CursorPage(items=[self._read(entity) for entity in page.items], next=page.next)',
              ]
            : `    return ${call(writer, `${method}(after, limit)`)}`,
        ]
      }
      return [
        `${methodDef} ${name}(self) -> list[${resultType(writer)}]:`,
        `    """Every ${entity}, by primary key."""`,
        writer.dtos
          ? `    return [self._read(entity) for entity in ${call(writer, `${method}()`)}]`
          : `    return ${call(writer, `${method}()`)}`,
      ]
    }
    case 'update': {
      const update = query(info, 'update')
      if (!update || !query(info, 'getByKey')) return []
      imports.from('typing', 'Any')
      if (!writer.dtos) imports.from('collections.abc', 'Mapping')
      const param = writer.dtos ? `data: ${updateDto(info)}` : 'changes: Mapping[str, Any]'
      const version = info.version ? `, version: ${columnPyType(info.version, imports, false)}` : ''
      return [
        `${methodDef} ${name}(self, ${keyParams(writer)}, ${param}${version}) -> ${resultType(writer)}:`,
        `    """Changes the given values of a ${entity}${info.version ? ', read at `version`' : ''}."""`,
        `    values = ${writer.dtos ? dumped(writer, 'data') : 'dict(changes)'}`,
        indent(
          lines(
            ...inTransaction(writer, [
              `current = ${call(writer, `self._find(${keyArgs(info)})`)}`,
              ...versionCheck(writer),
              call(writer, 'self._check(values, current)'),
              'for name, value in values.items():',
              '    setattr(current, name, value)',
              info.version && `current.${info.version.attr} = version + 1`,
              `updated = ${call(writer, `${repo(info)}.${queryName(context, update)}(current)`)}`,
              `return ${out(writer, 'updated')}`,
            ]),
          ),
        ),
      ]
    }
    case 'delete': {
      const remove = query(info, 'delete')
      const update = query(info, 'update')
      if (!query(info, 'getByKey') || (!info.soft && !remove) || (info.soft && !update)) return []
      const version = info.version ? `, version: ${columnPyType(info.version, imports, false)}` : ''
      let action: Block
      if (info.soft) {
        const soft = info.soft
        const value = soft.column.type.kind === 'boolean' ? 'True' : 'datetime.now(UTC)'
        if (value !== 'True') imports.from('datetime', 'UTC', 'datetime')
        action = [`current.${soft.attr} = ${value}`, call(writer, `${repo(info)}.${queryName(context, update!)}(current)`)]
      } else action = [call(writer, `${repo(info)}.${queryName(context, remove!)}(current)`)]
      return [
        `${methodDef} ${name}(self, ${keyParams(writer)}${version}) -> None:`,
        info.soft
          ? `    """Marks a ${entity} as deleted (${info.soft.column.name}); reads leave it out from then on."""`
          : `    """Deletes a ${entity}."""`,
        indent(
          lines(
            ...inTransaction(writer, [
              `current = ${call(writer, `self._find(${keyArgs(info)})`)}`,
              ...versionCheck(writer),
              ...childrenLines(writer),
              ...action,
            ]),
          ),
        ),
      ]
    }
    case 'find': {
      const read = query(info, 'findByUnique', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => info.columns.find((item) => item.column.name === column)!)
      const params = columns.map((column) => `${column.attr}: ${columnPyType(column, imports, false)}`).join(', ')
      const args = columns.map((column) => column.attr).join(', ')
      return [
        `${methodDef} ${name}(self, ${params}) -> ${resultType(writer)} | None:`,
        `    """The ${entity} with this ${operation.columns.join(' and ')}, or None."""`,
        writer.dtos
          ? [
              `    entity = ${call(writer, `${repo(info)}.${queryName(context, read)}(${args})`)}`,
              '    return self._read(entity) if entity is not None else None',
            ]
          : `    return ${call(writer, `${repo(info)}.${queryName(context, read)}(${args})`)}`,
      ]
    }
    case 'listByParent': {
      const read = query(info, 'listByParent', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => info.columns.find((item) => item.column.name === column)!)
      const params = columns.map((column) => `${column.attr}: ${columnPyType(column, imports, false)}`).join(', ')
      const args = columns.map((column) => column.attr).join(', ')
      const rows = call(writer, `${repo(info)}.${queryName(context, read)}(${args})`)
      return [
        `${methodDef} ${name}(self, ${params}) -> list[${resultType(writer)}]:`,
        `    """The ${info.name} with this ${operation.columns.join(' and ')}."""`,
        writer.dtos ? `    return [self._read(entity) for entity in ${rows}]` : `    return ${rows}`,
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
  const attrOf = (column: string) => join.columns.find((item) => item.column.name === column)!
  const ownCols = own.columns.map(attrOf)
  const farCols = far.columns.map(attrOf)
  const params = [...ownCols, ...farCols].map((column) => `${column.attr}: ${columnPyType(column, imports, false)}`).join(', ')
  const keyArgsJoin = join.key.map((column) => column.attr).join(', ')
  const found = call(writer, `${repo(join)}.${queryName(context, read)}(${keyArgsJoin})`)
  imports.from('app.errors', 'NotFoundError').from(moduleOf(context, join, 'entity'), join.entity)
  if (operation.kind === 'link') {
    const insert = query(join, 'insert')
    const farRead = query(farInfo, 'getByKey')
    if (!insert || !farRead || !query(info, 'getByKey')) return []
    imports.from('app.errors', 'ConflictError')
    const farArgs = farCols.map((column) => column.attr).join(', ')
    return [
      `${writer.def} ${name}(self, ${params}) -> None:`,
      `    """Links a ${info.entity} and a ${farInfo.entity} (${join.name})."""`,
      indent(
        lines(
          ...inTransaction(writer, [
            call(writer, `self._find(${ownCols.map((column) => column.attr).join(', ')})`),
            `if ${call(writer, `${repo(farInfo)}.${queryName(context, farRead)}(${farArgs})`)} is None:`,
            `    raise NotFoundError("${farInfo.entity}", ${farCols.length === 1 ? farArgs : `(${farArgs})`})`,
            `if ${found} is not None:`,
            `    raise ConflictError("${info.entity}", "is already linked to this ${farInfo.entity}", (${farCols.map((column) => `"${column.attr}"`).join(', ')},))`,
            call(
              writer,
              `${repo(join)}.${queryName(context, insert)}(${join.entity}(${[...ownCols, ...farCols].map((column) => `${column.attr}=${column.attr}`).join(', ')}))`,
            ),
          ]),
        ),
      ),
    ]
  }
  const remove = query(join, 'delete')
  if (!remove) return []
  return [
    `${writer.def} ${name}(self, ${params}) -> None:`,
    `    """Removes the link between a ${info.entity} and a ${farInfo.entity} (${join.name})."""`,
    indent(
      lines(
        ...inTransaction(writer, [
          `link = ${found}`,
          'if link is None:',
          `    raise NotFoundError("${join.entity}", (${keyArgsJoin}))`,
          call(writer, `${repo(join)}.${queryName(context, remove)}(link)`),
        ]),
      ),
    ),
  ]
}

export function serviceFile(context: Context, info: TableInfo): GeneratedFile | null {
  if (!info.service) return null
  const imports = new Imports()
    .from('app.unit_of_work', 'UnitOfWork')
    .from(moduleOf(context, info, 'entity'), info.entity)
    .from('typing', 'Any')
  const dtos = context.settings.serviceTypes === 'dtos'
  const writer: Writer = { context, info, imports, dtos, a: aw(context), def: def(context) }
  if (dtos) {
    const module = moduleOf(context, info, 'dtos')
    imports.from(module, readDto(info))
    if (info.role === 'entity') imports.from(module, createDto(info), updateDto(info))
  }
  const writes = info.role === 'entity'
  const operations = info.operations.map((operation) => operationLines(writer, operation)).filter((block) => block.length > 0)
  const helpers: Block[] = [findMethod(writer), readMethod(writer)]
  if (writes) helpers.unshift(validateAll(writer), uniqueMethod(writer), checkMethod(writer))
  const hidden = info.hidden.length > 0 && !dtos
  const fields = writes ? createColumns(info).map((column) => `"${column.attr}"`) : []
  const content = lines(
    `"""Operations on ${info.name}: what each one checks before it writes."""`,
    '',
    imports.write('app'),
    writes && ['', `# Columns a client may send: the database fills the others`, `_FIELDS = frozenset({${fields.join(', ')}})`],
    '',
    '',
    `class ${serviceClass(info)}:`,
    `    """Operations on ${info.name}. ${context.settings.transactions === 'operation' ? 'Each write runs in its own transaction.' : context.settings.transactions === 'caller' ? 'It never commits: the caller owns the transaction.' : 'Repositories commit every write.'}"""`,
    hidden &&
      `    # TODO: ${info.hidden.join(', ')} ${info.hidden.length === 1 ? 'is' : 'are'} returned with the entity; use DTOs to leave ${info.hidden.length === 1 ? 'it' : 'them'} out`,
    '',
    '    def __init__(self, uow: UnitOfWork) -> None:',
    '        self._uow = uow',
    ...[...helpers, ...operations].filter((block) => block.length > 0).flatMap((block) => ['', indent(lines(...block))]),
    '',
  )
  return { path: pathOf(moduleOf(context, info, 'service')), content }
}
