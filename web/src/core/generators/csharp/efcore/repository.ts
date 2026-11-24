/**
 * The EF Core repositories, over AppDbContext: LINQ reads that leave out rows marked as deleted, writes saved at once so a
 * database refusal becomes a ConflictException, and the values the database fills read back by EF Core.
 */
import type { Line } from '../../types.ts'
import { csString, type CsUsings } from '../csharp.ts'
import { columnOf, errorsNamespace, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import type { Method } from '../repositories.ts'

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

const equals = (columns: ColumnInfo[]) => columns.map((column) => `e.${column.prop} == ${column.local}`)

/** A uuid that is not the key is made before the insert: SQLite and MySQL have no default for it. */
const uuids = (info: TableInfo) =>
  info.columns
    .filter((column) => column.column.generated === 'uuid' && !info.key.includes(column))
    .map((column) => `entity.${column.prop} ??= Guid.NewGuid();`)

export function efBody(context: Context, info: TableInfo, method: Method, usings: CsUsings): string[] {
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

/** SaveAsync, which every write goes through. */
export const efTail = (info: TableInfo): Line[] => [
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
]
