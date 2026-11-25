/**
 * The repositories of each table: the interface services depend on (when the settings want one), its database
 * implementation (its bodies are the strategy's, orm.ts), and its in-memory one, with the same methods. Repositories
 * decide nothing.
 */
import type { QueryDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import { lines, type Line } from '../types.ts'
import { isObjectId } from '../../schema/documents.ts'
import { identifiedLists, listOf } from './documents.ts'
import { csString, CsUsings } from './csharp.ts'
import {
  columnOf,
  commonNamespace,
  errorsNamespace,
  memoryRepositoryClass,
  namespaceOf,
  pathOf,
  queryName,
  repositoryInterface,
  sqlRepositoryClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'

export interface Method {
  query: QueryDesign
  name: string
  params: { name: string; type: string }[]
  returns: string
  doc: string
}

/** The methods of a table's repository, with their C# signatures. */
export function repositoryMethods(context: Context, info: TableInfo, usings: CsUsings): Method[] {
  const entity = info.entity
  const methods: Method[] = []
  for (const query of info.queries) {
    const name = queryName(context, query)
    const byColumns = query.columns.map((column) => ({ name: columnOf(info, column).local, type: columnOf(info, column).cs }))
    const add = (params: Method['params'], returns: string, doc: string) => methods.push({ query, name, params, returns, doc })
    switch (query.kind) {
      case 'getByKey':
        add(byColumns, `Task<${entity}?>`, 'The row with this primary key, or null.')
        break
      case 'findByUnique':
        add(byColumns, `Task<${entity}?>`, `The row with this ${query.columns.join(' and ')}, or null.`)
        break
      case 'listByParent':
      case 'findAllBy':
        add(byColumns, `Task<List<${entity}>>`, `Rows with this ${query.columns.join(' and ')}, by primary key.`)
        break
      case 'list':
        if (context.settings.paging === 'offset') {
          usings.add(commonNamespace(context))
          add(
            [
              { name: 'offset', type: 'int' },
              { name: 'limit', type: 'int' },
            ],
            `Task<Page<${entity}>>`,
            'At most limit rows from offset, by primary key, and how many there are.',
          )
        } else if (context.settings.paging === 'cursor') {
          usings.add(commonNamespace(context))
          add(
            [
              { name: 'after', type: 'IReadOnlyList<object>?' },
              { name: 'limit', type: 'int' },
            ],
            `Task<CursorPage<${entity}>>`,
            'At most limit rows after the key after (null for the first page), by primary key, and the key to read the next page from.',
          )
        } else add([], `Task<List<${entity}>>`, 'Every row, by primary key.')
        break
      case 'insert':
        add([{ name: 'entity', type: entity }], `Task<${entity}>`, 'Stores a new row; the values the database fills are read back.')
        break
      case 'update':
        add([{ name: 'entity', type: entity }], `Task<${entity}>`, 'Stores the changes made to a row read from this repository.')
        break
      case 'addItem':
      case 'removeItem': {
        const list = listOf(info, query)
        const adds = query.kind === 'addItem'
        // Told apart by its position, it is only removed from a list of the size it was seen in
        const size = !adds && list.by === 'position' ? [{ name: 'size', type: 'int' }] : []
        add(
          [
            ...info.key.map((column) => ({ name: column.local, type: column.cs })),
            ...(adds ? [{ name: list.item, type: list.cs }] : list.params),
            ...size,
          ],
          `Task<${entity}?>`,
          adds
            ? `Adds an item to ${query.columns[0]}, and gives the row as it is then, if there is one.`
            : `Removes an item from ${query.columns[0]}${size.length > 0 ? ' that has this size' : ''}, and gives the row as it is then, if there is one.`,
        )
        break
      }
      case 'delete':
        add([{ name: 'entity', type: entity }], 'Task', 'Removes a row read from this repository.')
        break
    }
  }
  return methods
}

const signature = (method: Method) =>
  `${method.returns} ${method.name}(${method.params.map((param) => `${param.type} ${param.name}`).join(', ')})`

// In memory

function literalOf(cs: string, value: string): string {
  if (cs === 'long') return `${value}L`
  if (cs === 'short') return `(short)${value}`
  if (cs === 'decimal') return `${value}m`
  if (cs === 'float') return `${value}f`
  if (cs === 'double') return value.includes('.') ? value : `${value}.0`
  if (cs === 'string') return csString(value)
  return value
}

export function memoryFill(context: Context, info: TableInfo, column: ColumnInfo): string | null {
  const db = column.column
  const target = `entity.${column.prop}`
  const primary = info.key.includes(column)
  if (db.generated === 'identity')
    return primary
      ? `if (${target} == 0) ${target} = ${column.cs === 'long' ? 'nextId++' : `(${column.cs})nextId++`};`
      : `${target} ??= ${column.cs === 'long' ? 'nextId++' : `(${column.cs})nextId++`};`
  if (db.generated === 'uuid' && column.cs === 'string')
    return `${target} ??= ${isObjectId(db.type) ? 'MongoDB.Bson.ObjectId.GenerateNewId().ToString()' : 'Guid.NewGuid().ToString()'};`
  if (db.generated === 'uuid') return primary ? `if (${target} == Guid.Empty) ${target} = Guid.NewGuid();` : `${target} ??= Guid.NewGuid();`
  if (db.generated === 'now' || db.generated === 'onUpdateNow')
    return `${target} ??= ${column.cs === 'DateTimeOffset' ? 'DateTimeOffset.UtcNow' : context.orm.documents ? 'DateTime.UtcNow' : 'DateTime.Now'};`
  if (db.default?.kind === 'literal' && db.default.value !== null && column.optional)
    return `${target} ??= ${typeof db.default.value === 'boolean' ? String(db.default.value) : literalOf(column.cs, String(db.default.value))};`
  return null
}

function memoryVisible(info: TableInfo): string {
  if (!info.soft) return 'true'
  return info.soft.column.type.kind === 'boolean' ? `row.${info.soft.prop} != true` : `row.${info.soft.prop} == null`
}

function memoryBody(context: Context, info: TableInfo, method: Method): string[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const conditions = columns.map((column) => `Equals(row.${column.prop}, ${column.local})`).join(' && ')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return Task.FromResult(Visible().FirstOrDefault(row => ${conditions}));`]
    case 'listByParent':
    case 'findAllBy':
      return [`return Task.FromResult(Visible().Where(row => ${conditions}).ToList());`]
    case 'list':
      if (context.settings.paging === 'offset')
        return [
          'var rows = Visible().ToList();',
          `return Task.FromResult(new Page<${info.entity}>(rows.Skip(offset).Take(limit).ToList(), rows.Count, offset, limit));`,
        ]
      if (context.settings.paging === 'cursor')
        return [
          'var rows = Visible().Where(row => after is null || Compare(KeyOf(row), after) > 0).ToList();',
          'var items = rows.Take(limit).ToList();',
          `return Task.FromResult(new CursorPage<${info.entity}>(items, rows.Count > limit ? KeyOf(items[^1]) : null));`,
        ]
      return ['return Task.FromResult(Visible().ToList());']
    case 'insert':
    case 'update':
      return [
        ...(identifiedLists(info).length > 0 ? ['entity.IdentifyItems();'] : []),
        'rows[KeyText(entity)] = entity;',
        'return Task.FromResult(entity);',
      ]
    case 'addItem':
    case 'removeItem':
      return memoryItem(info, method)
    case 'delete':
      return ['rows.Remove(KeyText(entity));', 'return Task.CompletedTask;']
    default:
      return ['throw new NotSupportedException();']
  }
}

/** One item of a list added or removed in memory. */
function memoryItem(info: TableInfo, method: Method): string[] {
  const list = listOf(info, method.query)
  const [param] = list.params
  const items = `found.${list.column.prop}`
  const keys = info.key.map((column) => `Equals(row.${column.prop}, ${column.local})`).join(' && ')
  const version = info.version
  const change =
    method.query.kind === 'addItem'
      ? [
          ...(list.by === 'id' ? [`${list.item}.Id ??= MongoDB.Bson.ObjectId.GenerateNewId().ToString();`] : []),
          `${items} = [..${items} ?? [], ${list.item}];`,
        ]
      : list.by === 'position'
        ? [`${items} = (${items} ?? []).Where((_, index) => index != position).ToList();`]
        : [`${items} = (${items} ?? []).Where(candidate => !Equals(candidate${list.by === 'id' ? '.Id' : ''}, ${param.name})).ToList();`]
  return [
    `var found = Visible().FirstOrDefault(row => ${keys});`,
    `if (found is null${method.query.kind === 'removeItem' && list.by === 'position' ? ` || (${items}?.Count ?? 0) != size` : ''}) return Task.FromResult<${info.entity}?>(null);`,
    ...change,
    ...(version ? [`found.${version.prop} = ${version.optional ? `(found.${version.prop} ?? 0)` : `found.${version.prop}`} + 1;`] : []),
    ...info.columns.filter(({ column }) => column.generated === 'onUpdateNow').map((column) => `found.${column.prop} = DateTime.UtcNow;`),
    `return Task.FromResult<${info.entity}?>(found);`,
  ]
}

function block(method: Method, body: Line[], modifier: string, async: boolean, doc: boolean): Line[] {
  return [
    '',
    doc && `    /// <summary>${method.doc}</summary>`,
    `    public ${modifier}${async ? 'async ' : ''}${signature(method)}`,
    '    {',
    ...body.map((line) => (typeof line === 'string' ? `        ${line}` : line)),
    '    }',
  ]
}

export function repositoryFiles(context: Context, info: TableInfo): GeneratedFile[] {
  const ns = namespaceOf(context, info, 'repository')
  const entityNs = namespaceOf(context, info, 'entity')
  const interfaces = context.settings.repositoryInterfaces
  const files: GeneratedFile[] = []
  const unit = (name: string, usings: CsUsings, body: Line[]) => {
    const written = usings.write()
    return { path: pathOf(ns, name), content: lines(written !== '' && [written, ''], `namespace ${ns};`, '', ...body, '') }
  }
  if (interfaces) {
    const usings = new CsUsings(ns).add(entityNs)
    const methods = repositoryMethods(context, info, usings)
    files.push(
      unit(repositoryInterface(info), usings, [
        `/// <summary>Where ${info.name} rows are kept. Services depend only on this interface.</summary>`,
        `public interface ${repositoryInterface(info)}`,
        '{',
        ...methods.flatMap((method, index) => [
          index > 0 ? '' : null,
          `    /// <summary>${method.doc}</summary>`,
          `    ${signature(method)};`,
        ]),
        '}',
      ]),
    )
  }
  {
    const { repository, holder } = context.orm
    const usings = new CsUsings(ns).add(entityNs, context.base, ...repository.usings, errorsNamespace(context))
    const methods = repositoryMethods(context, info, usings)
    const modifier = interfaces ? '' : 'virtual '
    const head = repository.head(context, info)
    const bodies = methods.flatMap((method) => block(method, repository.body(context, info, method, usings), modifier, true, !interfaces))
    files.push(
      unit(sqlRepositoryClass(info), usings, [
        `/// <summary>${repository.doc(context, info)}</summary>`,
        `public class ${sqlRepositoryClass(info)}(${holder} db)${interfaces ? ` : ${repositoryInterface(info)}` : ''}`,
        '{',
        ...head,
        ...(head.length > 0 ? bodies : bodies.slice(1)),
        ...repository.tail(context, info, usings),
        '}',
      ]),
    )
  }
  if (context.settings.memoryRepositories) {
    const usings = new CsUsings(ns).add(entityNs)
    const methods = repositoryMethods(context, info, usings)
    const fills = info.columns.map((column) => memoryFill(context, info, column)).filter((line): line is string => line !== null)
    const modifier = interfaces ? '' : 'override '
    const bodies = methods.map((method) => {
      const body = memoryBody(context, info, method)
      return block(method, method.query.kind === 'insert' ? [...fills, ...body] : body, modifier, false, false)
    })
    const identity = info.columns.some((column) => column.column.generated === 'identity')
    const keyValues = info.key.map((column) => `row.${column.prop}`).join(', ')
    files.push(
      unit(memoryRepositoryClass(info), usings, [
        `/// <summary>Keeps ${info.name} rows in memory, for tests and for trying the services without a database.</summary>`,
        interfaces
          ? `public class ${memoryRepositoryClass(info)} : ${repositoryInterface(info)}`
          : `public class ${memoryRepositoryClass(info)}() : ${sqlRepositoryClass(info)}(null!)`,
        '{',
        `    private readonly Dictionary<string, ${info.entity}> rows = [];`,
        identity && '    private long nextId = 1;',
        '',
        '    /// <summary>The key of a row, as a list of its key values.</summary>',
        `    private static object[] KeyOf(${info.entity} row) => [${keyValues}];`,
        '',
        `    private static string KeyText(${info.entity} row) => string.Join("|", KeyOf(row));`,
        '',
        '    /// <summary>Orders two keys value by value.</summary>',
        '    private static int Compare(IReadOnlyList<object> a, IReadOnlyList<object> b)',
        '    {',
        '        for (var index = 0; index < a.Count; index++)',
        '        {',
        '            var order = Comparer<object>.Default.Compare(a[index], b[index]);',
        '            if (order != 0) return order;',
        '        }',
        '        return 0;',
        '    }',
        '',
        `    private IEnumerable<${info.entity}> Visible() =>`,
        `        rows.Values.Where(row => ${memoryVisible(info)}).OrderBy(KeyOf, Comparer<object[]>.Create((a, b) => Compare(a, b)));`,
        ...bodies.flat(),
        '}',
      ]),
    )
  }
  return files
}
