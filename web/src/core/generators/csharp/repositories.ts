/**
 * The repositories of each table: the interface services depend on (when the settings want one), its EF Core
 * implementation over AppDbContext (LINQ reads that leave out rows marked as deleted, writes saved at once so a
 * database refusal becomes a ConflictException, values the database fills read back by EF Core), and its in-memory
 * one, with the same methods. Repositories decide nothing.
 */
import type { QueryDesign } from '../../crud/types.ts'
import type { GeneratedFile } from '../../export/files.ts'
import { lines, type Line } from '../types.ts'
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
      case 'delete':
        add([{ name: 'entity', type: entity }], 'Task', 'Removes a row read from this repository.')
        break
    }
  }
  return methods
}

const signature = (method: Method) =>
  `${method.returns} ${method.name}(${method.params.map((param) => `${param.type} ${param.name}`).join(', ')})`

// EF Core

/** The condition that leaves out rows marked as deleted. */
function softCondition(info: TableInfo): string | null {
  if (!info.soft) return null
  return info.soft.column.type.kind === 'boolean' ? `e.${info.soft.prop} != true` : `e.${info.soft.prop} == null`
}

function where(conditions: (string | null)[]): string {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? `.Where(e => ${present.join(' && ')})` : ''
}

const order = (info: TableInfo) => info.key.map((column, index) => `.${index === 0 ? 'OrderBy' : 'ThenBy'}(e => e.${column.prop})`).join('')

const equals = (columns: ColumnInfo[], target?: string) =>
  columns.map((column) => `e.${column.prop} == ${target ? `${target}.${column.prop}` : column.local}`)

/** A uuid that is not the key is made before the insert: SQLite and MySQL have no default for it. */
const uuids = (info: TableInfo) =>
  info.columns
    .filter((column) => column.column.generated === 'uuid' && !info.key.includes(column))
    .map((column) => `entity.${column.prop} ??= Guid.NewGuid();`)

function efBody(context: Context, info: TableInfo, method: Method, usings: CsUsings): string[] {
  const set = `db.${info.attr}`
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return await ${set}${where([...equals(columns), soft])}.FirstOrDefaultAsync();`]
    case 'listByParent':
    case 'findAllBy':
      return [`return await ${set}${where([...equals(columns), soft])}${order(info)}.ToListAsync();`]
    case 'list': {
      if (context.settings.paging === 'offset')
        return [
          `var query = ${set}${where([soft])};`,
          'var total = await query.LongCountAsync();',
          `var items = await query${order(info)}.Skip(offset).Take(limit).ToListAsync();`,
          'return new Page<' + info.entity + '>(items, total, offset, limit);',
        ]
      if (context.settings.paging === 'cursor') {
        // After the key (a, b): a greater, or a the same and b greater
        const key = info.key
        const casts = key.map((column, index) => `var k${index} = (${column.cs})after[${index}];`)
        const compare = (column: ColumnInfo, index: number) =>
          column.cs === 'string' || column.cs === 'Guid' ? `e.${column.prop}.CompareTo(k${index}) > 0` : `e.${column.prop} > k${index}`
        const after = key
          .map((column, index) =>
            [...key.slice(0, index).map((before, position) => `e.${before.prop} == k${position}`), compare(column, index)].join(' && '),
          )
          .map((item) => (key.length > 1 ? `(${item})` : item))
          .join(' || ')
        return [
          `IQueryable<${info.entity}> query = ${set}${where([soft])};`,
          'if (after is not null)',
          '{',
          ...casts.map((line) => `    ${line}`),
          `    query = query.Where(e => ${after});`,
          '}',
          `var rows = await query${order(info)}.Take(limit + 1).ToListAsync();`,
          'var items = rows.Take(limit).ToList();',
          `return new CursorPage<${info.entity}>(items, rows.Count > limit ? [${key.map((column) => `items[^1].${column.prop}`).join(', ')}] : null);`,
        ]
      }
      return [`return await ${set}${where([soft])}${order(info)}.ToListAsync();`]
    }
    case 'insert':
      usings.add(errorsNamespace(context))
      return [...uuids(info), `${set}.Add(entity);`, 'await SaveAsync();', 'return entity;']
    case 'update':
      return [`${set}.Update(entity);`, 'await SaveAsync();', 'return entity;']
    case 'delete':
      return [`${set}.Remove(entity);`, 'await SaveAsync();']
    default:
      return ['throw new NotSupportedException();']
  }
}

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

function memoryFill(info: TableInfo, column: ColumnInfo): string | null {
  const db = column.column
  const target = `entity.${column.prop}`
  const primary = info.key.includes(column)
  if (db.generated === 'identity')
    return primary
      ? `if (${target} == 0) ${target} = ${column.cs === 'long' ? 'nextId++' : `(${column.cs})nextId++`};`
      : `${target} ??= ${column.cs === 'long' ? 'nextId++' : `(${column.cs})nextId++`};`
  if (db.generated === 'uuid') return primary ? `if (${target} == Guid.Empty) ${target} = Guid.NewGuid();` : `${target} ??= Guid.NewGuid();`
  if (db.generated === 'now' || db.generated === 'onUpdateNow')
    return `${target} ??= ${column.cs === 'DateTimeOffset' ? 'DateTimeOffset.UtcNow' : 'DateTime.Now'};`
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
      return ['rows[KeyText(entity)] = entity;', 'return Task.FromResult(entity);']
    case 'delete':
      return ['rows.Remove(KeyText(entity));', 'return Task.CompletedTask;']
    default:
      return ['throw new NotSupportedException();']
  }
}

function block(method: Method, body: string[], modifier: string, async: boolean, doc: boolean): Line[] {
  return [
    '',
    doc && `    /// <summary>${method.doc}</summary>`,
    `    public ${modifier}${async ? 'async ' : ''}${signature(method)}`,
    '    {',
    ...body.map((line) => `        ${line}`),
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
    const usings = new CsUsings(ns).add(entityNs, context.base, 'Microsoft.EntityFrameworkCore', errorsNamespace(context))
    const methods = repositoryMethods(context, info, usings)
    const modifier = interfaces ? '' : 'virtual '
    const bodies = methods.map((method) => block(method, efBody(context, info, method, usings), modifier, true, !interfaces))
    files.push(
      unit(sqlRepositoryClass(info), usings, [
        `/// <summary>Keeps ${info.name} rows in the database, through AppDbContext. ${
          context.settings.transactions === 'caller'
            ? 'Writes run in the transaction of whoever holds the AppDbContext, when there is one.'
            : 'A write joins the transaction already open, or is committed at once.'
        }</summary>`,
        `public class ${sqlRepositoryClass(info)}(AppDbContext db)${interfaces ? ` : ${repositoryInterface(info)}` : ''}`,
        '{',
        ...bodies.flat().slice(1),
        '',
        '    /// <summary>Saves the changes; a database refusal (a unique value, a row still pointed to) becomes a ConflictException.</summary>',
        '    private async Task SaveAsync()',
        '    {',
        '        try',
        '        {',
        '            await db.SaveChangesAsync();',
        '        }',
        '        catch (DbUpdateException error)',
        '        {',
        '            db.ChangeTracker.Clear();',
        `            throw new ConflictException(${csString(info.entity)}, $"the database refused the change: {error.InnerException?.Message ?? error.Message}");`,
        '        }',
        '    }',
        '}',
      ]),
    )
  }
  if (context.settings.memoryRepositories) {
    const usings = new CsUsings(ns).add(entityNs)
    const methods = repositoryMethods(context, info, usings)
    const fills = info.columns.map((column) => memoryFill(info, column)).filter((line): line is string => line !== null)
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
