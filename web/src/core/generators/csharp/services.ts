/**
 * The service of each table: its operations and what each one checks before it writes, in the order of the
 * design (docs/design.md, section 3): the values against the database's rules, the rows they point to, unique
 * values, the version; then children and soft deletes. The values of a create or an update are gathered in a
 * dictionary of the fields given, so every way an update can come is checked and applied the same way. Every write
 * runs in uow.TransactionAsync(...); errors are domain exceptions without HTTP codes. Mirrors java/services.ts.
 */
import type { OperationDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { DbCheck } from '../../schema/types.ts'
import { lines, type Line } from '../types.ts'
import { csString, CsUsings } from './csharp.ts'
import {
  columnOf,
  commonNamespace,
  errorsNamespace,
  findInfo,
  namespaceOf,
  operationName,
  pathOf,
  query,
  queryName,
  serviceClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, readColumns, readDto, updateColumns, updateNamespace, updateType } from './dtos.ts'

interface Writer {
  context: Context
  info: TableInfo
  usings: CsUsings
  dtos: boolean
}

type Block = Line[]

const repo = (info: TableInfo, uow = 'uow') => `${uow}.${info.attr}`
const keyParams = (info: TableInfo) => info.key.map((column) => `${column.cs} ${column.local}`).join(', ')
const keyArgs = (info: TableInfo) => info.key.map((column) => column.local).join(', ')
const keyValue = (info: TableInfo) => (info.key.length === 1 ? info.key[0].local : `new object[] { ${keyArgs(info)} }`)
const indent = (items: Line[], spaces = 4): Line[] =>
  items.map((line) => (typeof line === 'string' ? (line === '' ? '' : ' '.repeat(spaces) + line) : line))

const numericKinds = new Set(['integer', 'decimal', 'float'])

/** The value of a field as the database had it, or as the change gives it: `(long?)(values.TryGetValue(...) ? ...)`. */
const givenOrCurrent = (column: ColumnInfo) =>
  `var ${column.local} = values.TryGetValue(${csString(column.prop)}, out var given${column.prop}) ? (${column.cs}?)given${column.prop} : current?.${column.prop};`

/** The value to pass on, once known not to be null. */
const known = (column: ColumnInfo) => (column.valueType ? `${column.local}.Value` : column.local)

function valueRules(column: ColumnInfo, checks: DbCheck[]): string[] {
  const rules: string[] = []
  const name = column.column.name
  const type = column.column.type
  const error = (message: string) => `errors.Add(new FieldError(${csString(name)}, ${csString(message)}));`
  if (type.kind === 'text' && type.length !== undefined)
    rules.push(`if (value is string text && text.Length > ${type.length}) ${error(`is longer than ${type.length} characters`)}`)
  for (const check of checks) {
    const parsed = check.parsed
    if (!parsed || parsed.column !== name) continue
    if (parsed.kind === 'in') {
      const message = `must be one of: ${parsed.values.join(', ')}`
      if (numericKinds.has(type.kind))
        rules.push(
          `if (!new[] { ${parsed.values.map((item) => `${String(item)}m`).join(', ')} }.Contains(Number(value))) ${error(message)}`,
        )
      else
        rules.push(
          `if (!new[] { ${parsed.values.map((item) => csString(String(item))).join(', ')} }.Contains(Convert.ToString(value, CultureInfo.InvariantCulture))) ${error(message)}`,
        )
    }
    if (parsed.kind === 'compare')
      rules.push(`if (!(Number(value) ${parsed.op} ${String(parsed.value)}m)) ${error(`must be ${parsed.op} ${parsed.value}`)}`)
    if (parsed.kind === 'length')
      rules.push(
        `if (!(Convert.ToString(value, CultureInfo.InvariantCulture)!.Length ${parsed.op} ${parsed.value})) ${error(`must have ${parsed.op} ${parsed.value} characters`)}`,
      )
  }
  return rules
}

function validateMethod(writer: Writer): Block {
  const { context, info, usings } = writer
  usings.add(errorsNamespace(context), context.base)
  const blocks: Line[][] = []
  for (const column of createColumns(info)) {
    const name = column.column.name
    const prop = csString(column.prop)
    const missing = column.required
      ? `if (creating || values.ContainsKey(${prop})) errors.Add(new FieldError(${csString(name)}, "is required"));`
      : !column.column.nullable
        ? `if (!creating && values.ContainsKey(${prop})) errors.Add(new FieldError(${csString(name)}, "cannot be empty"));`
        : null
    const rules = valueRules(column, info.table.checks)
    if (!missing && rules.length === 0) continue
    blocks.push([
      '{',
      `    var value = values.GetValueOrDefault(${prop});`,
      ...(missing
        ? [
            '    if (value is null)',
            `        ${missing}`,
            ...(rules.length > 0 ? ['    else', '    {', ...rules.map((rule) => `        ${rule}`), '    }'] : []),
          ]
        : ['    if (value is not null)', '    {', ...rules.map((rule) => `        ${rule}`), '    }']),
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
      '{',
      ...columns.map((column) => `    ${givenOrCurrent(column)}`),
      `    if (${columns.map((column) => `${column.local} is not null`).join(' && ')} && await ${repo(parent)}.${queryName(context, read)}(${columns.map(known).join(', ')}) is null)`,
      `        errors.Add(new FieldError(${csString(key.columns.join(', '))}, ${csString(`no ${parent.entity} has this key`)}));`,
      '}',
    ])
  }
  const created = new Set(createColumns(info).map((column) => column.column.name))
  const parsed = info.table.checks
    .map((check) => check.parsed)
    .filter((item): item is NonNullable<typeof item> => item !== undefined && created.has(item.column))
  const numbers = parsed.some(
    (item) => item.kind === 'compare' || (item.kind === 'in' && numericKinds.has(columnOf(info, item.column).column.type.kind)),
  )
  if (numbers || parsed.some((item) => item.kind === 'length' || item.kind === 'in')) usings.add('System.Globalization')
  return [
    `/// <summary>Checks the values against the rules of the "${info.name}" table, and the rows they point to; throws ValidationFailedException with every problem.</summary>`,
    `private static async Task ValidateAsync(IUnitOfWork uow, Dictionary<string, object?> values, ${info.entity}? current)`,
    '{',
    '    var creating = current is null;',
    '    var errors = new List<FieldError>();',
    ...blocks.flatMap((block) => indent(block)),
    `    if (errors.Count > 0) throw new ValidationFailedException(${csString(info.entity)}, errors);`,
    '}',
    ...(numbers
      ? [
          '',
          '/// <summary>A number of any type, to compare it.</summary>',
          'private static decimal Number(object value) => Convert.ToDecimal(value, CultureInfo.InvariantCulture);',
        ]
      : []),
  ]
}

function uniqueMethod(writer: Writer): Block {
  const { context, info, usings } = writer
  const checks: Line[][] = []
  for (const unique of info.table.uniques) {
    const read = query(info, 'findByUnique', unique.columns)
    if (!read) {
      checks.push([`// ${unique.columns.join(', ')} must be unique: the database refuses repeated values (ConflictException)`])
      continue
    }
    usings.add(errorsNamespace(context))
    const columns = unique.columns.map((name) => columnOf(info, name))
    const other = info.key.map((column) => `!Equals(other.${column.prop}, current.${column.prop})`).join(' || ')
    checks.push([
      '{',
      ...columns.map((column) => `    ${givenOrCurrent(column)}`),
      `    if (${columns.map((column) => `${column.local} is not null`).join(' && ')})`,
      '    {',
      `        var other = await ${repo(info)}.${queryName(context, read)}(${columns.map(known).join(', ')});`,
      `        if (other is not null && (current is null || ${other}))`,
      `            throw new ConflictException(${csString(info.entity)}, ${csString(`${unique.columns.join(', ')} is already taken`)}, [${columns.map((column) => csString(column.prop)).join(', ')}]);`,
      '    }',
      '}',
    ])
  }
  if (checks.length === 0) return []
  return [
    '/// <summary>Values that must be unique are not taken by another row.</summary>',
    `private static async Task CheckUniqueAsync(IUnitOfWork uow, Dictionary<string, object?> values, ${info.entity}? current)`,
    '{',
    ...checks.flatMap((block) => indent(block)),
    '}',
  ]
}

function checkMethod(writer: Writer): Block {
  const { info } = writer
  return [
    '/// <summary>Every check before a write: the values, the rows they point to, the unique values.</summary>',
    `private static async Task CheckAsync(IUnitOfWork uow, Dictionary<string, object?> values, ${info.entity}? current)`,
    '{',
    '    await ValidateAsync(uow, values, current);',
    info.table.uniques.length > 0 && '    await CheckUniqueAsync(uow, values, current);',
    '}',
  ]
}

function applyMethod(writer: Writer): Block {
  const { info } = writer
  return [
    '/// <summary>Sets the given values on the entity.</summary>',
    `private static void Apply(${info.entity} entity, Dictionary<string, object?> values)`,
    '{',
    ...createColumns(info).map(
      (column) =>
        `    if (values.TryGetValue(${csString(column.prop)}, out var ${column.local})) entity.${column.prop} = (${column.propType})${column.local}${column.optional ? '' : '!'};`,
    ),
    '}',
  ]
}

function findMethod(writer: Writer): Block {
  const { context, info, usings } = writer
  const read = query(info, 'getByKey')
  if (!read) return []
  usings.add(errorsNamespace(context), context.base)
  return [
    `/// <summary>The ${info.entity} with this key; NotFoundException when there is none.</summary>`,
    `private static async Task<${info.entity}> FindAsync(IUnitOfWork uow, ${keyParams(info)}) =>`,
    `    await ${repo(info)}.${queryName(context, read)}(${keyArgs(info)}) ?? throw new NotFoundException(${csString(info.entity)}, ${keyValue(info)});`,
  ]
}

function readMethod(writer: Writer): Block {
  if (!writer.dtos) return []
  const { context, info } = writer
  const values = readColumns(info).map((column) => `entity.${column.prop}`)
  return [
    `/// <summary>The ${info.entity} as services return it.</summary>`,
    context.settings.dtoKind === 'class'
      ? `private static ${readDto(info)} Read(${info.entity} entity) => new() { ${readColumns(info)
          .map((column) => `${column.prop} = entity.${column.prop}`)
          .join(', ')} };`
      : `private static ${readDto(info)} Read(${info.entity} entity) => new(${values.join(', ')});`,
  ]
}

function givenMethod(writer: Writer): Block {
  const { context, info, usings } = writer
  const type = updateType(context, info)
  if (updateNamespace(context, info) !== namespaceOf(context, info, 'service')) usings.add(updateNamespace(context, info))
  const body = updateColumns(info).map((column) =>
    context.settings.updates === 'patch'
      ? `if (changes.${column.prop} is { IsPresent: true } ${column.local}) values[${csString(column.prop)}] = ${column.local}.Value;`
      : `values[${csString(column.prop)}] = changes.${column.prop};`,
  )
  return [
    '/// <summary>The values an update gives, by field.</summary>',
    `private static Dictionary<string, object?> Given(${type} changes)`,
    '{',
    '    var values = new Dictionary<string, object?>();',
    ...body.map((line) => `    ${line}`),
    '    return values;',
    '}',
  ]
}

const out = (writer: Writer, expression: string) => (writer.dtos ? `Read(${expression})` : expression)
const resultType = (writer: Writer) => (writer.dtos ? readDto(writer.info) : writer.info.entity)

function versionCheck(writer: Writer): string[] {
  const version = writer.info.version
  if (!version) return []
  writer.usings.add(errorsNamespace(writer.context))
  return [
    `if (!Equals(current.${version.prop}, version))`,
    `    throw new ConflictException(${csString(writer.info.entity)}, "was changed by someone else since it was read", [${csString(version.prop)}]);`,
  ]
}

function childrenLines(writer: Writer): string[] {
  const { context, info, usings } = writer
  if (!info.children) return []
  const result: string[] = []
  for (const link of info.children.links) {
    const child = findInfo(context, link.table)
    const list = child ? query(child, 'listByParent', link.columns) : undefined
    if (!child || !list) {
      result.push(`// TODO: rows of ${link.table} may point here; that table has no list by ${link.columns.join(', ')} to look for them`)
      continue
    }
    const args = link.references
      .map((name) => {
        const column = columnOf(info, name)
        return `current.${column.prop}${column.optional && column.valueType ? '!.Value' : ''}`
      })
      .join(', ')
    const rows = `await ${repo(child)}.${queryName(context, list)}(${args})`
    if (info.children.policy === 'block') {
      usings.add(errorsNamespace(context))
      result.push(
        `if ((${rows}).Count > 0) throw new ConflictException(${csString(info.entity)}, ${csString(`rows of ${link.table} still point to it`)}, [${csString(link.table)}]);`,
      )
    } else {
      const remove = query(child, 'delete')
      if (!remove) result.push(`// TODO: rows of ${link.table} must be deleted first, and that table has no delete`)
      else result.push(`foreach (var row in ${rows}) await ${repo(child)}.${queryName(context, remove)}(row);`)
    }
  }
  return result
}

function inTransaction(items: string[], returns: boolean): string[] {
  return [`${returns ? 'return ' : ''}await this.uow.TransactionAsync(async uow =>`, '{', ...items.map((line) => `    ${line}`), '});']
}

function operationLines(writer: Writer, operation: OperationDesign): Block {
  const { context, info, usings } = writer
  const name = operationName(context, operation)
  const entity = info.entity
  switch (operation.kind) {
    case 'create': {
      const insert = query(info, 'insert')
      if (!insert) return []
      if (writer.dtos) usings.add(namespaceOf(context, info, 'dtos'))
      const variable = entity.charAt(0).toLowerCase() + entity.slice(1)
      const source = writer.dtos ? 'data' : variable
      return [
        `/// <summary>Stores a new ${entity} after checking it.</summary>`,
        `public async Task<${resultType(writer)}> ${name}(${writer.dtos ? `${createDto(info)} data` : `${entity} ${variable}`})`,
        '{',
        '    var values = new Dictionary<string, object?>();',
        ...createColumns(info).map((column) =>
          column.optional || !column.valueType
            ? `    if (${source}.${column.prop} is not null) values[${csString(column.prop)}] = ${source}.${column.prop};`
            : `    values[${csString(column.prop)}] = ${source}.${column.prop};`,
        ),
        ...indent(
          inTransaction(
            [
              'await CheckAsync(uow, values, null);',
              ...(writer.dtos ? [`var entity = new ${entity}();`, 'Apply(entity, values);'] : []),
              `return ${out(writer, `await ${repo(info)}.${queryName(context, insert)}(${writer.dtos ? 'entity' : variable})`)};`,
            ],
            true,
          ),
        ),
        '}',
      ]
    }
    case 'get':
      if (!query(info, 'getByKey')) return []
      return [
        `/// <summary>The ${entity} with this key; NotFoundException when there is none.</summary>`,
        `public async Task<${resultType(writer)}> ${name}(${keyParams(info)}) => ${out(writer, `await FindAsync(uow, ${keyArgs(info)})`)};`,
      ]
    case 'list': {
      const list = query(info, 'list')
      if (!list) return []
      const method = `${repo(info)}.${queryName(context, list)}`
      const mapped = (expression: string, kind: 'page' | 'list') =>
        writer.dtos ? (kind === 'page' ? `(${expression}).Map(Read)` : `(${expression}).Select(Read).ToList()`) : expression
      if (context.settings.paging === 'offset') {
        usings.add(commonNamespace(context))
        return [
          `/// <summary>A page of ${info.name}, by primary key.</summary>`,
          `public async Task<Page<${resultType(writer)}>> ${name}(int offset, int limit) => ${mapped(`await ${method}(offset, limit)`, 'page')};`,
        ]
      }
      if (context.settings.paging === 'cursor') {
        usings.add(commonNamespace(context))
        return [
          `/// <summary>A page of ${info.name} after the key after (null for the first page), by primary key.</summary>`,
          `public async Task<CursorPage<${resultType(writer)}>> ${name}(IReadOnlyList<object>? after, int limit) => ${mapped(`await ${method}(after, limit)`, 'page')};`,
        ]
      }
      return [
        `/// <summary>Every ${entity}, by primary key.</summary>`,
        `public async Task<List<${resultType(writer)}>> ${name}() => ${mapped(`await ${method}()`, 'list')};`,
      ]
    }
    case 'update': {
      const update = query(info, 'update')
      if (!update || !query(info, 'getByKey')) return []
      const version = info.version ? `, ${info.version.cs} version` : ''
      return [
        `/// <summary>Changes the given values of a ${entity}${info.version ? ', read at version' : ''}.</summary>`,
        `public async Task<${resultType(writer)}> ${name}(${keyParams(info)}, ${updateType(context, info)} changes${version})`,
        '{',
        '    var values = Given(changes);',
        ...indent(
          inTransaction(
            [
              `var current = await FindAsync(uow, ${keyArgs(info)});`,
              ...versionCheck(writer),
              'await CheckAsync(uow, values, current);',
              'Apply(current, values);',
              ...(info.version
                ? [`current.${info.version.prop} = ${info.version.cs === 'short' ? '(short)(version + 1)' : 'version + 1'};`]
                : []),
              `return ${out(writer, `await ${repo(info)}.${queryName(context, update)}(current)`)};`,
            ],
            true,
          ),
        ),
        '}',
      ]
    }
    case 'delete': {
      const remove = query(info, 'delete')
      const update = query(info, 'update')
      if (!query(info, 'getByKey') || (!info.soft && !remove) || (info.soft && !update)) return []
      const version = info.version ? `, ${info.version.cs} version` : ''
      const mark = !info.soft
        ? ''
        : info.soft.column.type.kind === 'boolean'
          ? 'true'
          : info.soft.cs === 'DateTimeOffset'
            ? 'DateTimeOffset.UtcNow'
            : 'DateTime.Now'
      const action = info.soft
        ? [`current.${info.soft.prop} = ${mark};`, `await ${repo(info)}.${queryName(context, update!)}(current);`]
        : [`await ${repo(info)}.${queryName(context, remove!)}(current);`]
      return [
        info.soft
          ? `/// <summary>Marks a ${entity} as deleted (${info.soft.column.name}); reads leave it out from then on.</summary>`
          : `/// <summary>Deletes a ${entity}.</summary>`,
        `public async Task ${name}(${keyParams(info)}${version})`,
        '{',
        ...indent(
          inTransaction(
            [`var current = await FindAsync(uow, ${keyArgs(info)});`, ...versionCheck(writer), ...childrenLines(writer), ...action],
            false,
          ),
        ),
        '}',
      ]
    }
    case 'find':
    case 'listByParent': {
      const read = query(info, operation.kind === 'find' ? 'findByUnique' : 'listByParent', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => columnOf(info, column))
      const params = columns.map((column) => `${column.cs} ${column.local}`).join(', ')
      const rows = `await ${repo(info)}.${queryName(context, read)}(${columns.map((column) => column.local).join(', ')})`
      if (operation.kind === 'find')
        return [
          `/// <summary>The ${entity} with this ${operation.columns.join(' and ')}, or null.</summary>`,
          writer.dtos
            ? `public async Task<${resultType(writer)}?> ${name}(${params}) => ${rows} is { } entity ? Read(entity) : null;`
            : `public async Task<${resultType(writer)}?> ${name}(${params}) => ${rows};`,
        ]
      return [
        `/// <summary>The ${info.name} with this ${operation.columns.join(' and ')}.</summary>`,
        `public async Task<List<${resultType(writer)}>> ${name}(${params}) => ${writer.dtos ? `(${rows}).Select(Read).ToList()` : rows};`,
      ]
    }
    case 'link':
    case 'unlink':
      return linkLines(writer, operation, name)
  }
}

function linkLines(writer: Writer, operation: OperationDesign, name: string): Block {
  const { context, info, usings } = writer
  const join = operation.through ? findInfo(context, operation.through) : undefined
  if (!join) return []
  const own = join.table.foreignKeys.find((key) => key.references.table === info.name)
  const far = join.table.foreignKeys.find((key) => key !== own)
  const farInfo = far ? findInfo(context, far.references.table) : undefined
  const read = query(join, 'getByKey')
  if (!own || !far || !farInfo || !read) return []
  const ownCols = own.columns.map((column) => columnOf(join, column))
  const farCols = far.columns.map((column) => columnOf(join, column))
  const params = [...ownCols, ...farCols].map((column) => `${column.cs} ${column.local}`).join(', ')
  const joinKey = join.key.map((column) => column.local).join(', ')
  const found = `await ${repo(join)}.${queryName(context, read)}(${joinKey})`
  usings.add(errorsNamespace(context), namespaceOf(context, join, 'entity'))
  if (operation.kind === 'link') {
    const insert = query(join, 'insert')
    const farRead = query(farInfo, 'getByKey')
    if (!insert || !farRead || !query(info, 'getByKey')) return []
    const farArgs = farCols.map((column) => column.local).join(', ')
    return [
      `/// <summary>Links a ${info.entity} and a ${farInfo.entity} (${join.name}).</summary>`,
      `public async Task ${name}(${params})`,
      '{',
      ...indent(
        inTransaction(
          [
            `await FindAsync(uow, ${ownCols.map((column) => column.local).join(', ')});`,
            `if (await ${repo(farInfo)}.${queryName(context, farRead)}(${farArgs}) is null) throw new NotFoundException(${csString(farInfo.entity)}, ${farCols.length === 1 ? farArgs : `new object[] { ${farArgs} }`});`,
            `if (${found} is not null) throw new ConflictException(${csString(info.entity)}, ${csString(`is already linked to this ${farInfo.entity}`)}, [${farCols.map((column) => csString(column.prop)).join(', ')}]);`,
            `await ${repo(join)}.${queryName(context, insert)}(new ${join.entity} { ${[...ownCols, ...farCols].map((column) => `${column.prop} = ${column.local}`).join(', ')} });`,
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
    `/// <summary>Removes the link between a ${info.entity} and a ${farInfo.entity} (${join.name}).</summary>`,
    `public async Task ${name}(${params})`,
    '{',
    ...indent(
      inTransaction(
        [
          `var link = ${found} ?? throw new NotFoundException(${csString(join.entity)}, new object[] { ${joinKey} });`,
          `await ${repo(join)}.${queryName(context, remove)}(link);`,
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
  const ns = namespaceOf(context, info, 'service')
  const usings = new CsUsings(ns).add(namespaceOf(context, info, 'entity'), context.base)
  const dtos = context.settings.serviceTypes === 'dtos'
  const writer: Writer = { context, info, usings, dtos }
  if (dtos) usings.add(namespaceOf(context, info, 'dtos'))
  const writes = info.role === 'entity'
  const operations = info.operations.map((operation) => operationLines(writer, operation)).filter((block) => block.length > 0)
  const updates = info.operations.some((operation) => operation.kind === 'update') && query(info, 'update') && query(info, 'getByKey')
  const helpers: Block[] = [findMethod(writer), readMethod(writer)]
  if (writes) helpers.unshift(validateMethod(writer), uniqueMethod(writer), checkMethod(writer), applyMethod(writer))
  if (writes && updates) helpers.push(givenMethod(writer))
  const hidden = info.hidden.length > 0 && !dtos
  const members = [...helpers, ...operations].filter((block) => block.length > 0)
  const written = usings.write()
  const content = lines(
    written !== '' && [written, ''],
    `namespace ${ns};`,
    '',
    `/// <summary>Operations on ${info.name}. ${TRANSACTIONS[context.settings.transactions]}</summary>`,
    `public class ${serviceClass(info)}(IUnitOfWork unitOfWork)`,
    '{',
    hidden &&
      `    // TODO: ${info.hidden.join(', ')} ${info.hidden.length === 1 ? 'is' : 'are'} returned with the entity; use DTOs to leave ${info.hidden.length === 1 ? 'it' : 'them'} out`,
    '    private readonly IUnitOfWork uow = unitOfWork;',
    ...members.flatMap((block) => ['', ...indent(block)]),
    '}',
    '',
  )
  return { path: pathOf(ns, serviceClass(info)), content }
}
