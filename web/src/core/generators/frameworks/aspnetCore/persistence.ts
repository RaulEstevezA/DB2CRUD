/**
 * Storage of each resource in the ASP.NET Core project: the repository interface the service depends on, and
 * the implementation of the chosen persistence:
 * - `memory`: a dictionary, to run the API without a database; it keeps copies, never the caller's objects
 * - `none`: every method throws NotImplementedException (501), with a TODO where the storage goes
 * - `efCore`: Entity Framework Core, with filters and sorting written for each field
 */
import type { SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { CsUsings, csDoc, csHeader, csString } from '../../languages/csharp/csharp.ts'
import { queryableFields } from './common.ts'
import {
  commonNamespace,
  dataNamespace,
  keyField,
  keyType,
  names,
  namespaceOf,
  property,
  sourcePath,
  type AspNetContext,
} from './context.ts'
import { fieldType } from './model.ts'

export function repositoryFiles(context: AspNetContext, resource: SpecResource): GeneratedFile[] {
  const relative = context.layout.resource(resource, 'repository')
  const namespace = namespaceOf(context, relative)
  const name = names(resource)
  const model = namespaceOf(context, context.layout.resource(resource, 'model'))
  const key = keyType(resource)
  const keyProperty = property(keyField(resource), name.type)
  const file = (className: string, usings: CsUsings, body: (string | false | string[])[]) => ({
    path: sourcePath(context, relative, className),
    content: fileText(lines(...csHeader(namespace, usings), ...body)),
  })
  const files: GeneratedFile[] = []

  files.push(
    file(name.repository, new CsUsings(namespace).add(model, commonNamespace(context)), [
      csDoc(`Where ${resource.plural} are kept. The service depends only on this interface.`),
      `public interface ${name.repository}`,
      '{',
      '    /// <summary>Items equal to every filter, in order, within the window; and how many match.</summary>',
      `    Task<ListResult<${name.type}>> ListAsync(ListQuery query);`,
      '',
      '    /// <summary>The item with this key, or null when there is none.</summary>',
      `    Task<${name.type}?> GetAsync(${key} key);`,
      '',
      `    /// <summary>Stores a new item${resource.key.generated ? ' and assigns its key' : ''}; returns it as stored.</summary>`,
      `    Task<${name.type}> AddAsync(${name.type} item);`,
      '',
      '    /// <summary>Stores the new state of an existing item and returns it.</summary>',
      `    Task<${name.type}> UpdateAsync(${name.type} item);`,
      '',
      '    /// <summary>Removes an existing item.</summary>',
      `    Task DeleteAsync(${key} key);`,
      '}',
    ]),
  )

  if (context.pending) {
    const message = csString(`The storage of ${resource.plural} is not written yet`)
    const method = (signature: string) => [
      `    public ${signature}`,
      '    {',
      `        // TODO: store ${resource.plural} in your database`,
      `        throw new NotImplementedException(${message});`,
      '    }',
    ]
    files.push(
      file(name.pendingRepository, new CsUsings(namespace).add(model, commonNamespace(context)), [
        csDoc(`Storage of ${resource.plural} to write: every method answers 501 until it is implemented.`),
        `public sealed class ${name.pendingRepository} : ${name.repository}`,
        '{',
        method(`Task<ListResult<${name.type}>> ListAsync(ListQuery query)`),
        '',
        method(`Task<${name.type}?> GetAsync(${key} key)`),
        '',
        method(`Task<${name.type}> AddAsync(${name.type} item)`),
        '',
        method(`Task<${name.type}> UpdateAsync(${name.type} item)`),
        '',
        method(`Task DeleteAsync(${key} key)`),
        '}',
      ]),
    )
    return files
  }

  const generated = resource.key.generated
  const assign =
    generated === 'increment'
      ? `        item.${keyProperty} = Interlocked.Increment(ref lastKey);`
      : generated === 'uuid'
        ? `        item.${keyProperty} = ${key === 'Guid' ? 'Guid.NewGuid()' : 'Guid.NewGuid().ToString()'};`
        : false

  if (!context.efCore) {
    const usings = new CsUsings(namespace).add('System.Collections.Concurrent', model, commonNamespace(context))
    const values = resource.fields.map((field) => `        ${csString(field.wire)} => item.${property(field, name.type)},`)
    const byKey =
      key === 'string' ? `.OrderBy(item => item.${keyProperty}, StringComparer.Ordinal)` : `.OrderBy(item => item.${keyProperty})`
    files.push(
      file(name.memory, usings, [
        csDoc(`Keeps ${resource.plural} in memory: they are lost when the application stops. Use it to try the API.`),
        `public sealed class ${name.memory} : ${name.repository}`,
        '{',
        `    private readonly ConcurrentDictionary<${key}, ${name.type}> items = new();`,
        generated === 'increment' && ['', '    private long lastKey;'],
        '',
        '    /// <summary>The value of a field by its JSON name, for filters and sorting.</summary>',
        `    private static object? Value(${name.type} item, string field) => field switch`,
        '    {',
        values,
        '        _ => null,',
        '    };',
        '',
        `    public Task<ListResult<${name.type}>> ListAsync(ListQuery query)`,
        '    {',
        '        var found = items.Values',
        '            .Where(item => query.Filters.All(filter => Equals(Value(item, filter.Key), filter.Value)))',
        `            ${byKey}`,
        '            .ToList();',
        '        if (query.SortField is { } field)',
        '        {',
        '            var present = found.Where(item => Value(item, field) is not null);',
        '            var sorted = query.Descending',
        '                ? present.OrderByDescending(item => Value(item, field), Comparer<object?>.Default)',
        '                : present.OrderBy(item => Value(item, field), Comparer<object?>.Default);',
        '            // Items without a value go last, whatever the order',
        '            found = [.. sorted, .. found.Where(item => Value(item, field) is null)];',
        '        }',
        '        var window = found.Skip(query.Offset).Take(query.Limit ?? int.MaxValue).Select(item => JsonValues.Copy(item)).ToList();',
        `        return Task.FromResult(new ListResult<${name.type}>(window, found.Count));`,
        '    }',
        '',
        `    public Task<${name.type}?> GetAsync(${key} key) =>`,
        '        Task.FromResult(items.TryGetValue(key, out var item) ? JsonValues.Copy(item) : null);',
        '',
        `    public Task<${name.type}> AddAsync(${name.type} item)`,
        '    {',
        assign,
        `        items[item.${keyProperty}] = JsonValues.Copy(item);`,
        '        return Task.FromResult(item);',
        '    }',
        '',
        `    public Task<${name.type}> UpdateAsync(${name.type} item)`,
        '    {',
        `        items[item.${keyProperty}] = JsonValues.Copy(item);`,
        '        return Task.FromResult(item);',
        '    }',
        '',
        `    public Task DeleteAsync(${key} key)`,
        '    {',
        '        items.TryRemove(key, out _);',
        '        return Task.CompletedTask;',
        '    }',
        '}',
      ]),
    )
    return files
  }

  const usings = new CsUsings(namespace).add(
    'System.Linq.Expressions',
    'Microsoft.EntityFrameworkCore',
    model,
    commonNamespace(context),
    dataNamespace(context),
  )
  const fields = queryableFields(resource)
  const filters = fields.map((field) => {
    const isKey = field.name === resource.key.field
    const type = fieldType(context, field, usings, resource, !isKey)
    return `                ${csString(field.wire)} => items.Where(item => item.${property(field, name.type)} == (${type})value),`
  })
  const sorts = fields.map((field) => {
    const prop = property(field, name.type)
    if (field.name === resource.key.field)
      return `            ${csString(field.wire)} => query.Descending ? items.OrderByDescending(item => item.${prop}) : items.OrderBy(item => item.${prop}),`
    return `            ${csString(field.wire)} => Sorted(items, item => item.${prop}, query.Descending),`
  })
  files.push(
    file(name.efRepository, usings, [
      csDoc(`Keeps ${resource.plural} in the database with Entity Framework Core.`),
      `public sealed class ${name.efRepository}(AppDbContext database) : ${name.repository}`,
      '{',
      `    public async Task<ListResult<${name.type}>> ListAsync(ListQuery query)`,
      '    {',
      `        IQueryable<${name.type}> items = database.${name.set};`,
      '        foreach (var (field, value) in query.Filters)',
      '        {',
      '            items = field switch',
      '            {',
      filters,
      '                _ => items,',
      '            };',
      '        }',
      '        var total = await items.LongCountAsync();',
      '        items = query.SortField switch',
      '        {',
      sorts,
      `            _ => items.OrderBy(item => item.${keyProperty}),`,
      '        };',
      '        items = items.Skip(query.Offset);',
      '        if (query.Limit is { } limit)',
      '        {',
      '            items = items.Take(limit);',
      '        }',
      `        return new ListResult<${name.type}>(await items.AsNoTracking().ToListAsync(), total);`,
      '    }',
      '',
      `    public async Task<${name.type}?> GetAsync(${key} key) => await database.${name.set}.FindAsync(key);`,
      '',
      `    public async Task<${name.type}> AddAsync(${name.type} item)`,
      '    {',
      generated === 'uuid' && key === 'string' && assign,
      `        database.${name.set}.Add(item);`,
      '        await database.SaveChangesAsync();',
      '        // Read back, so the answer has what the database keeps',
      '        await database.Entry(item).ReloadAsync();',
      '        return item;',
      '    }',
      '',
      `    public async Task<${name.type}> UpdateAsync(${name.type} item)`,
      '    {',
      '        await database.SaveChangesAsync();',
      '        await database.Entry(item).ReloadAsync();',
      '        return item;',
      '    }',
      '',
      `    public async Task DeleteAsync(${key} key) =>`,
      `        await database.${name.set}.Where(item => item.${keyProperty} == key).ExecuteDeleteAsync();`,
      '',
      '    /// <summary>Sorts by a field: items without a value go last, whatever the order, and the key breaks ties.</summary>',
      `    private static IQueryable<${name.type}> Sorted<TValue>(IQueryable<${name.type}> items, Expression<Func<${name.type}, TValue>> value, bool descending)`,
      '    {',
      `        var missing = Expression.Lambda<Func<${name.type}, bool>>(`,
      '            Expression.Equal(value.Body, Expression.Constant(null, typeof(TValue))), value.Parameters);',
      '        var ordered = items.OrderBy(missing);',
      `        return (descending ? ordered.ThenByDescending(value) : ordered.ThenBy(value)).ThenBy(item => item.${keyProperty});`,
      '    }',
      '}',
    ]),
  )
  return files
}
