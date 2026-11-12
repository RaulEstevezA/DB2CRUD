/**
 * The service of each table: its operations and what each one checks before it writes, in the order of the
 * design (docs/design.md, section 3): the values against the database's rules, the rows they point to, unique
 * values, the version; then children and soft deletes. The values of a create or an update are gathered in a map of
 * the fields given, so the three ways an update can come (Patch, Optional, every field) are checked and applied the
 * same way. Every write runs in uow.transaction(...); errors are domain exceptions without HTTP codes. Mirrors
 * typescript/common/services.ts.
 */
import type { OperationDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { DbCheck } from '../../schema/types.ts'
import { lines, type Line } from '../types.ts'
import { javaPath, javaString, JavaImports } from './java.ts'
import {
  columnOf,
  commonPackage,
  errorsPackage,
  findInfo,
  operationName,
  packageOf,
  qualified,
  query,
  queryName,
  serviceClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { accessor, createColumns, createDto, readColumns, readDto, updateColumns, updatePackage, updateType } from './dtos.ts'

interface Writer {
  context: Context
  info: TableInfo
  imports: JavaImports
  dtos: boolean
}

type Block = Line[]

const repo = (info: TableInfo, uow = 'uow') => `${uow}.${info.attr}()`
const keyParams = (info: TableInfo) => info.key.map((column) => `${column.java} ${column.prop}`).join(', ')
const keyArgs = (info: TableInfo, target?: string) =>
  info.key.map((column) => (target ? `${target}.${column.getter}()` : column.prop)).join(', ')
const keyValue = (info: TableInfo, imports: JavaImports) => {
  if (info.key.length === 1) return info.key[0].prop
  imports.add('java.util.List')
  return `List.of(${keyArgs(info)})`
}

/** A body indented inside a method */
const body = (items: Line[], spaces = 8): Line[] =>
  items.map((line) => (typeof line === 'string' ? (line === '' ? '' : ' '.repeat(spaces) + line) : line))

const numericKinds = new Set(['integer', 'decimal', 'float'])

/** The rules a value must follow, from the column's type and the CHECK constraints the rules understand. */
function valueRules(column: ColumnInfo, checks: DbCheck[], usesNumber: { value: boolean }): string[] {
  const rules: string[] = []
  const name = column.column.name
  const type = column.column.type
  const error = (message: string) => `errors.add(new FieldError(${javaString(name)}, ${javaString(message)}));`
  if (type.kind === 'text' && type.length !== undefined)
    rules.push(`if (value instanceof String text && text.length() > ${type.length}) ${error(`is longer than ${type.length} characters`)}`)
  for (const check of checks) {
    const parsed = check.parsed
    if (!parsed || parsed.column !== name) continue
    if (parsed.kind === 'in') {
      const choices = parsed.values.map((item) => javaString(String(item))).join(', ')
      if (numericKinds.has(type.kind)) {
        usesNumber.value = true
        rules.push(
          `if (Stream.of(${choices}).map(BigDecimal::new).noneMatch((choice) -> choice.compareTo(number(value)) == 0)) ${error(`must be one of: ${parsed.values.join(', ')}`)}`,
        )
      } else rules.push(`if (!List.of(${choices}).contains(String.valueOf(value))) ${error(`must be one of: ${parsed.values.join(', ')}`)}`)
    }
    if (parsed.kind === 'compare') {
      usesNumber.value = true
      rules.push(
        `if (!(number(value).compareTo(new BigDecimal(${javaString(String(parsed.value))})) ${parsed.op} 0)) ${error(`must be ${parsed.op} ${parsed.value}`)}`,
      )
    }
    if (parsed.kind === 'length')
      rules.push(
        `if (!(String.valueOf(value).length() ${parsed.op} ${parsed.value})) ${error(`must have ${parsed.op} ${parsed.value} characters`)}`,
      )
  }
  return rules
}

function validateMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  imports.add(
    `${errorsPackage(context)}.ValidationFailedException`,
    `${errorsPackage(context)}.FieldError`,
    'java.util.ArrayList',
    'java.util.List',
    'java.util.Map',
    `${context.base}.UnitOfWork`,
  )
  const usesNumber = { value: false }
  const blocks: Line[][] = []
  for (const column of createColumns(info)) {
    const name = column.column.name
    const prop = column.prop
    const missing = column.required
      ? `if (creating || values.containsKey(${javaString(prop)})) errors.add(new FieldError(${javaString(name)}, "is required"));`
      : !column.column.nullable
        ? `if (!creating && values.containsKey(${javaString(prop)})) errors.add(new FieldError(${javaString(name)}, "cannot be empty"));`
        : null
    const rules = valueRules(column, info.table.checks, usesNumber)
    if (!missing && rules.length === 0) continue
    blocks.push([
      '{',
      `    Object value = values.get(${javaString(prop)});`,
      ...(missing
        ? [
            '    if (value == null) {',
            `        ${missing}`,
            ...(rules.length > 0 ? ['    } else {', ...rules.map((rule) => `        ${rule}`)] : []),
            '    }',
          ]
        : ['    if (value != null) {', ...rules.map((rule) => `        ${rule}`), '    }']),
      '}',
    ])
  }
  if (usesNumber.value) imports.add('java.math.BigDecimal', 'java.util.stream.Stream')
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
      ...columns.map(
        (column) =>
          `    ${column.java} ${column.prop} = (${column.java}) (values.containsKey(${javaString(column.prop)}) ? values.get(${javaString(column.prop)}) : current == null ? null : current.${column.getter}());`,
      ),
      `    if (${columns.map((column) => `${column.prop} != null`).join(' && ')} && ${repo(parent)}.${queryName(context, read)}(${columns.map((column) => column.prop).join(', ')}).isEmpty())`,
      `        errors.add(new FieldError(${javaString(key.columns.join(', '))}, ${javaString(`no ${parent.entity} has this key`)}));`,
      '}',
    ])
  }
  return [
    `/** Checks the values against the rules of the "${info.name}" table, and the rows they point to; throws ValidationFailedException with every problem. */`,
    `private void validate(UnitOfWork uow, Map<String, Object> values, ${info.entity} current) {`,
    '    boolean creating = current == null;',
    '    List<FieldError> errors = new ArrayList<>();',
    ...blocks.flatMap((block) => block.map((line) => (typeof line === 'string' ? `    ${line}` : line))),
    `    if (!errors.isEmpty()) throw new ValidationFailedException("${info.entity}", errors);`,
    '}',
    ...(usesNumber.value
      ? [
          '',
          '/** A number of any type, to compare it. */',
          'private static BigDecimal number(Object value) {',
          '    return new BigDecimal(String.valueOf(value));',
          '}',
        ]
      : []),
  ]
}

function uniqueMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const checks: Line[][] = []
  for (const unique of info.table.uniques) {
    const read = query(info, 'findByUnique', unique.columns)
    if (!read) {
      checks.push([`// ${unique.columns.join(', ')} must be unique: the database refuses repeated values (ConflictException)`])
      continue
    }
    imports.add(`${errorsPackage(context)}.ConflictException`, 'java.util.List', 'java.util.Objects', 'java.util.Optional')
    const columns = unique.columns.map((name) => columnOf(info, name))
    const other = info.key.map((column) => `!Objects.equals(other.get().${column.getter}(), current.${column.getter}())`).join(' || ')
    checks.push([
      '{',
      ...columns.map(
        (column) =>
          `    ${column.java} ${column.prop} = (${column.java}) (values.containsKey(${javaString(column.prop)}) ? values.get(${javaString(column.prop)}) : current == null ? null : current.${column.getter}());`,
      ),
      `    if (${columns.map((column) => `${column.prop} != null`).join(' && ')}) {`,
      `        Optional<${info.entity}> other = ${repo(info)}.${queryName(context, read)}(${columns.map((column) => column.prop).join(', ')});`,
      `        if (other.isPresent() && (current == null || ${other}))`,
      `            throw new ConflictException("${info.entity}", ${javaString(`${unique.columns.join(', ')} is already taken`)}, List.of(${columns.map((column) => javaString(column.prop)).join(', ')}));`,
      '    }',
      '}',
    ])
  }
  if (checks.length === 0) return []
  return [
    '/** Values that must be unique are not taken by another row. */',
    `private void checkUnique(UnitOfWork uow, Map<String, Object> values, ${info.entity} current) {`,
    ...checks.flatMap((block) => block.map((line) => (typeof line === 'string' ? `    ${line}` : line))),
    '}',
  ]
}

function checkMethod(writer: Writer): Block {
  const { info } = writer
  return [
    '/** Every check before a write: the values, the rows they point to, the unique values. */',
    `private void check(UnitOfWork uow, Map<String, Object> values, ${info.entity} current) {`,
    '    validate(uow, values, current);',
    info.table.uniques.length > 0 && '    checkUnique(uow, values, current);',
    '}',
  ]
}

function applyMethod(writer: Writer): Block {
  const { info, imports } = writer
  imports.add('java.util.Map')
  return [
    '/** Sets the given values on the entity. */',
    `private static void apply(${info.entity} entity, Map<String, Object> values) {`,
    ...createColumns(info).map(
      (column) =>
        `    if (values.containsKey(${javaString(column.prop)})) entity.${column.setter}((${column.java}) values.get(${javaString(column.prop)}));`,
    ),
    '}',
  ]
}

function findMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const read = query(info, 'getByKey')
  if (!read) return []
  imports.add(`${errorsPackage(context)}.NotFoundException`, `${context.base}.UnitOfWork`)
  return [
    `/** The ${info.entity} with this key; NotFoundException when there is none. */`,
    `private ${info.entity} find(UnitOfWork uow, ${keyParams(info)}) {`,
    `    return ${repo(info)}.${queryName(context, read)}(${keyArgs(info)}).orElseThrow(() -> new NotFoundException("${info.entity}", ${keyValue(info, imports)}));`,
    '}',
  ]
}

function readMethod(writer: Writer): Block {
  if (!writer.dtos) return []
  const { info } = writer
  return [
    `/** The ${info.entity} as services return it. */`,
    `private static ${readDto(info)} read(${info.entity} entity) {`,
    `    return new ${readDto(info)}(${readColumns(info)
      .map((column) => `entity.${column.getter}()`)
      .join(', ')});`,
    '}',
  ]
}

/** The values given in an update, by field. */
function changesMethod(writer: Writer): Block {
  const { context, info, imports } = writer
  const type = updateType(context, info)
  const record = writer.dtos ? context.settings.dtoKind !== 'class' : true
  imports.add('java.util.LinkedHashMap', 'java.util.Map')
  if (updatePackage(context, info) !== packageOf(context, info, 'service')) imports.add(`${updatePackage(context, info)}.${type}`)
  const lines_: string[] = updateColumns(info).map((column) => {
    const get = `changes.${accessor(context, column.prop, record)}`
    if (context.settings.updates === 'patch')
      return `if (${get} != null && ${get}.isPresent()) values.put(${javaString(column.prop)}, ${get}.value());`
    if (context.settings.updates === 'optional') return `if (${get} != null) values.put(${javaString(column.prop)}, ${get}.orElse(null));`
    return `values.put(${javaString(column.prop)}, ${get});`
  })
  return [
    '/** The values an update gives, by field. */',
    `private static Map<String, Object> given(${type} changes) {`,
    '    Map<String, Object> values = new LinkedHashMap<>();',
    ...lines_.map((line) => `    ${line}`),
    '    return values;',
    '}',
  ]
}

const out = (writer: Writer, expression: string) => (writer.dtos ? `read(${expression})` : expression)
const resultType = (writer: Writer) => (writer.dtos ? readDto(writer.info) : writer.info.entity)

function versionCheck(writer: Writer): string[] {
  const version = writer.info.version
  if (!version) return []
  writer.imports.add(`${errorsPackage(writer.context)}.ConflictException`, 'java.util.List', 'java.util.Objects')
  return [
    `if (!Objects.equals(current.${version.getter}(), version))`,
    `    throw new ConflictException("${writer.info.entity}", "was changed by someone else since it was read", List.of(${javaString(version.prop)}));`,
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
    const args = link.references.map((name) => `current.${columnOf(info, name).getter}()`).join(', ')
    const rows = `${repo(child)}.${queryName(context, list)}(${args})`
    if (info.children.policy === 'block') {
      imports.add(`${errorsPackage(context)}.ConflictException`, 'java.util.List')
      result.push(
        `if (!${rows}.isEmpty()) throw new ConflictException("${info.entity}", ${javaString(`rows of ${link.table} still point to it`)}, List.of(${javaString(link.table)}));`,
      )
    } else {
      const remove = query(child, 'delete')
      if (!remove) result.push(`// TODO: rows of ${link.table} must be deleted first, and that table has no delete`)
      else {
        imports.add(qualified(context, child, 'entity', child.entity))
        result.push(`for (${child.entity} row : ${rows}) ${repo(child)}.${queryName(context, remove)}(row);`)
      }
    }
  }
  return result
}

function inTransaction(items: string[], returns: boolean): string[] {
  return [
    `${returns ? 'return ' : ''}uow.transaction((uow) -> {`,
    ...items.map((line) => `    ${line}`),
    ...(returns ? [] : ['    return null;']),
    '});',
  ]
}

/** `version + 1`, in the type of the version column. */
const nextVersion = (column: ColumnInfo) => (column.java === 'Short' ? '(short) (version + 1)' : 'version + 1')

function operationLines(writer: Writer, operation: OperationDesign): Block {
  const { context, info, imports } = writer
  const name = operationName(context, operation)
  const entity = info.entity
  const record = context.settings.dtoKind !== 'class'
  switch (operation.kind) {
    case 'create': {
      const insert = query(info, 'insert')
      if (!insert) return []
      imports.add('java.util.LinkedHashMap', 'java.util.Map')
      if (writer.dtos) imports.add(qualified(context, info, 'dtos', createDto(info)))
      const variable = entity.charAt(0).toLowerCase() + entity.slice(1)
      const get = (column: ColumnInfo) =>
        writer.dtos ? `data.${accessor(context, column.prop, record)}` : `${variable}.${column.getter}()`
      return [
        `/** Stores a new ${entity} after checking it. */`,
        `public ${resultType(writer)} ${name}(${writer.dtos ? `${createDto(info)} data` : `${entity} ${variable}`}) {`,
        '    Map<String, Object> values = new LinkedHashMap<>();',
        ...createColumns(info).map((column) => `    if (${get(column)} != null) values.put(${javaString(column.prop)}, ${get(column)});`),
        ...body(
          inTransaction(
            [
              'check(uow, values, null);',
              ...(writer.dtos ? [`${entity} entity = new ${entity}();`, 'apply(entity, values);'] : []),
              `return ${out(writer, `${repo(info)}.${queryName(context, insert)}(${writer.dtos ? 'entity' : variable})`)};`,
            ],
            true,
          ),
          4,
        ),
        '}',
      ]
    }
    case 'get':
      if (!query(info, 'getByKey')) return []
      return [
        `/** The ${entity} with this key; NotFoundException when there is none. */`,
        `public ${resultType(writer)} ${name}(${keyParams(info)}) {`,
        `    return ${out(writer, `find(uow, ${keyArgs(info)})`)};`,
        '}',
      ]
    case 'list': {
      const list = query(info, 'list')
      if (!list) return []
      const method = `${repo(info)}.${queryName(context, list)}`
      const mapped = (expression: string, kind: 'page' | 'list') =>
        writer.dtos
          ? kind === 'page'
            ? `${expression}.map(${serviceClass(info)}::read)`
            : `${expression}.stream().map(${serviceClass(info)}::read).toList()`
          : expression
      if (context.settings.paging === 'offset') {
        imports.add(`${commonPackage(context)}.Page`)
        return [
          `/** A page of ${info.name}, by primary key. */`,
          `public Page<${resultType(writer)}> ${name}(int offset, int limit) {`,
          `    return ${mapped(`${method}(offset, limit)`, 'page')};`,
          '}',
        ]
      }
      if (context.settings.paging === 'cursor') {
        imports.add(`${commonPackage(context)}.CursorPage`, 'java.util.List')
        return [
          `/** A page of ${info.name} after the key after (null for the first page), by primary key. */`,
          `public CursorPage<${resultType(writer)}> ${name}(List<Object> after, int limit) {`,
          `    return ${mapped(`${method}(after, limit)`, 'page')};`,
          '}',
        ]
      }
      imports.add('java.util.List')
      return [
        `/** Every ${entity}, by primary key. */`,
        `public List<${resultType(writer)}> ${name}() {`,
        `    return ${mapped(`${method}()`, 'list')};`,
        '}',
      ]
    }
    case 'update': {
      const update = query(info, 'update')
      if (!update || !query(info, 'getByKey')) return []
      const type = updateType(context, info)
      const version = info.version ? `, ${info.version.java} version` : ''
      return [
        `/** Changes the given values of a ${entity}${info.version ? ', read at version' : ''}. */`,
        `public ${resultType(writer)} ${name}(${keyParams(info)}, ${type} changes${version}) {`,
        '    Map<String, Object> values = given(changes);',
        ...body(
          inTransaction(
            [
              `${entity} current = find(uow, ${keyArgs(info)});`,
              ...versionCheck(writer),
              'check(uow, values, current);',
              'apply(current, values);',
              ...(info.version ? [`current.${info.version.setter}(${nextVersion(info.version)});`] : []),
              `return ${out(writer, `${repo(info)}.${queryName(context, update)}(current)`)};`,
            ],
            true,
          ),
          4,
        ),
        '}',
      ]
    }
    case 'delete': {
      const remove = query(info, 'delete')
      const update = query(info, 'update')
      if (!query(info, 'getByKey') || (!info.soft && !remove) || (info.soft && !update)) return []
      const version = info.version ? `, ${info.version.java} version` : ''
      let mark = 'Boolean.TRUE'
      if (info.soft && info.soft.column.type.kind !== 'boolean') {
        if (info.soft.java === 'OffsetDateTime') {
          imports.add('java.time.OffsetDateTime', 'java.time.ZoneOffset')
          mark = 'OffsetDateTime.now(ZoneOffset.UTC)'
        } else {
          if (info.soft.javaImport) imports.add(info.soft.javaImport)
          mark = `${info.soft.java}.now()`
        }
      }
      const action = info.soft
        ? [`current.${info.soft.setter}(${mark});`, `${repo(info)}.${queryName(context, update!)}(current);`]
        : [`${repo(info)}.${queryName(context, remove!)}(current);`]
      return [
        info.soft
          ? `/** Marks a ${entity} as deleted (${info.soft.column.name}); reads leave it out from then on. */`
          : `/** Deletes a ${entity}. */`,
        `public void ${name}(${keyParams(info)}${version}) {`,
        ...body(
          inTransaction(
            [`${entity} current = find(uow, ${keyArgs(info)});`, ...versionCheck(writer), ...childrenLines(writer), ...action],
            false,
          ),
          4,
        ),
        '}',
      ]
    }
    case 'find':
    case 'listByParent': {
      const read = query(info, operation.kind === 'find' ? 'findByUnique' : 'listByParent', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => columnOf(info, column))
      const params = columns.map((column) => `${column.java} ${column.prop}`).join(', ')
      const rows = `${repo(info)}.${queryName(context, read)}(${columns.map((column) => column.prop).join(', ')})`
      if (operation.kind === 'find') {
        imports.add('java.util.Optional')
        return [
          `/** The ${entity} with this ${operation.columns.join(' and ')}, if there is one. */`,
          `public Optional<${resultType(writer)}> ${name}(${params}) {`,
          `    return ${writer.dtos ? `${rows}.map(${serviceClass(info)}::read)` : rows};`,
          '}',
        ]
      }
      imports.add('java.util.List')
      return [
        `/** The ${info.name} with this ${operation.columns.join(' and ')}. */`,
        `public List<${resultType(writer)}> ${name}(${params}) {`,
        `    return ${writer.dtos ? `${rows}.stream().map(${serviceClass(info)}::read).toList()` : rows};`,
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
  const params = [...ownCols, ...farCols].map((column) => `${column.java} ${column.prop}`).join(', ')
  const joinKey = join.key.map((column) => column.prop).join(', ')
  const found = `${repo(join)}.${queryName(context, read)}(${joinKey})`
  imports.add(`${errorsPackage(context)}.NotFoundException`, qualified(context, join, 'entity', join.entity), 'java.util.List')
  if (operation.kind === 'link') {
    const insert = query(join, 'insert')
    const farRead = query(farInfo, 'getByKey')
    if (!insert || !farRead || !query(info, 'getByKey')) return []
    imports.add(`${errorsPackage(context)}.ConflictException`)
    const farArgs = farCols.map((column) => column.prop).join(', ')
    return [
      `/** Links a ${info.entity} and a ${farInfo.entity} (${join.name}). */`,
      `public void ${name}(${params}) {`,
      ...body(
        inTransaction(
          [
            `find(uow, ${ownCols.map((column) => column.prop).join(', ')});`,
            `if (${repo(farInfo)}.${queryName(context, farRead)}(${farArgs}).isEmpty()) throw new NotFoundException("${farInfo.entity}", ${farCols.length === 1 ? farArgs : `List.of(${farArgs})`});`,
            `if (${found}.isPresent()) throw new ConflictException("${info.entity}", ${javaString(`is already linked to this ${farInfo.entity}`)}, List.of(${farCols.map((column) => javaString(column.prop)).join(', ')}));`,
            `${join.entity} link = new ${join.entity}();`,
            ...[...ownCols, ...farCols].map((column) => `link.${column.setter}(${column.prop});`),
            `${repo(join)}.${queryName(context, insert)}(link);`,
          ],
          false,
        ),
        4,
      ),
      '}',
    ]
  }
  const remove = query(join, 'delete')
  if (!remove) return []
  return [
    `/** Removes the link between a ${info.entity} and a ${farInfo.entity} (${join.name}). */`,
    `public void ${name}(${params}) {`,
    ...body(
      inTransaction(
        [
          `${join.entity} link = ${found}.orElseThrow(() -> new NotFoundException("${join.entity}", List.of(${joinKey})));`,
          `${repo(join)}.${queryName(context, remove)}(link);`,
        ],
        false,
      ),
      4,
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
  const imports = new JavaImports(pkg).add(qualified(context, info, 'entity', info.entity), `${context.base}.UnitOfWork`)
  for (const column of info.columns) if (column.javaImport) imports.add(column.javaImport)
  const dtos = context.settings.serviceTypes === 'dtos'
  const writer: Writer = { context, info, imports, dtos }
  if (dtos) imports.add(qualified(context, info, 'dtos', readDto(info)))
  const writes = info.role === 'entity'
  const operations = info.operations.map((operation) => operationLines(writer, operation)).filter((block) => block.length > 0)
  const updates = info.operations.some((operation) => operation.kind === 'update') && query(info, 'update') && query(info, 'getByKey')
  const helpers: Block[] = [findMethod(writer), readMethod(writer)]
  if (writes) helpers.unshift(validateMethod(writer), uniqueMethod(writer), checkMethod(writer), applyMethod(writer))
  if (writes && updates) helpers.push(changesMethod(writer))
  const hidden = info.hidden.length > 0 && !dtos
  const members = [...helpers, ...operations].filter((block) => block.length > 0)
  const content = lines(
    `package ${pkg};`,
    '',
    imports.write(),
    '',
    `/** Operations on ${info.name}. ${TRANSACTIONS[context.settings.transactions]} */`,
    `public class ${serviceClass(info)} {`,
    hidden &&
      `    // TODO: ${info.hidden.join(', ')} ${info.hidden.length === 1 ? 'is' : 'are'} returned with the entity; use DTOs to leave ${info.hidden.length === 1 ? 'it' : 'them'} out`,
    '    private final UnitOfWork uow;',
    '',
    `    public ${serviceClass(info)}(UnitOfWork uow) {`,
    '        this.uow = uow;',
    '    }',
    ...members.flatMap((block) => ['', ...block.map((line) => (typeof line === 'string' ? (line === '' ? '' : `    ${line}`) : line))]),
    '}',
    '',
  )
  return { path: javaPath(pkg, serviceClass(info)), content }
}
