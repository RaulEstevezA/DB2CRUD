"""Storage of each resource in the ASP.NET Core project: the repository interface the service depends on, and the
implementation of the chosen persistence:
- memory: a dictionary, to run the API without a database; it keeps copies, never the caller's objects
- none: every method throws NotImplementedException (501), with a TODO where the storage goes
- efCore: Entity Framework Core, with filters and sorting written for each field
Mirrors web/src/core/generators/frameworks/aspnetCore/persistence.ts.
"""

from ...common.text import file_text, lines
from ...languages.csharp.csharp import CsUsings, cs_doc, cs_header, cs_string
from .common import queryable_fields
from .context import (
    AspNetContext,
    common_namespace,
    data_namespace,
    key_field,
    key_type,
    names,
    namespace_of,
    property_name,
    source_path,
)
from .model import field_type


def repository_files(context: AspNetContext, resource: dict) -> list[dict]:
    relative = context.layout.resource(resource, "repository")
    namespace = namespace_of(context, relative)
    name = names(resource)
    item_type = name["type"]
    model = namespace_of(context, context.layout.resource(resource, "model"))
    key = key_type(resource)
    key_property = property_name(key_field(resource), item_type)
    plural = resource["plural"]

    def file(class_name: str, usings: CsUsings, body: list) -> dict:
        return {
            "path": source_path(context, relative, class_name),
            "content": file_text(lines(*cs_header(namespace, usings), *body)),
        }

    files = []
    assigns_key = " and assigns its key" if resource["key"]["generated"] else ""
    files.append(
        file(
            name["repository"],
            CsUsings(namespace).add(model, common_namespace(context)),
            [
                cs_doc(f"Where {plural} are kept. The service depends only on this interface."),
                f"public interface {name['repository']}",
                "{",
                "    /// <summary>Items equal to every filter, in order, within the window; and how many match.</summary>",
                f"    Task<ListResult<{item_type}>> ListAsync(ListQuery query);",
                "",
                "    /// <summary>The item with this key, or null when there is none.</summary>",
                f"    Task<{item_type}?> GetAsync({key} key);",
                "",
                f"    /// <summary>Stores a new item{assigns_key}; returns it as stored.</summary>",
                f"    Task<{item_type}> AddAsync({item_type} item);",
                "",
                "    /// <summary>Stores the new state of an existing item and returns it.</summary>",
                f"    Task<{item_type}> UpdateAsync({item_type} item);",
                "",
                "    /// <summary>Removes an existing item.</summary>",
                f"    Task DeleteAsync({key} key);",
                "}",
            ],
        )
    )

    if context.pending:
        message = cs_string(f"The storage of {plural} is not written yet")

        def method(signature: str) -> list[str]:
            return [
                f"    public {signature}",
                "    {",
                f"        // TODO: store {plural} in your database",
                f"        throw new NotImplementedException({message});",
                "    }",
            ]

        files.append(
            file(
                name["pendingRepository"],
                CsUsings(namespace).add(model, common_namespace(context)),
                [
                    cs_doc(f"Storage of {plural} to write: every method answers 501 until it is implemented."),
                    f"public sealed class {name['pendingRepository']} : {name['repository']}",
                    "{",
                    method(f"Task<ListResult<{item_type}>> ListAsync(ListQuery query)"),
                    "",
                    method(f"Task<{item_type}?> GetAsync({key} key)"),
                    "",
                    method(f"Task<{item_type}> AddAsync({item_type} item)"),
                    "",
                    method(f"Task<{item_type}> UpdateAsync({item_type} item)"),
                    "",
                    method(f"Task DeleteAsync({key} key)"),
                    "}",
                ],
            )
        )
        return files

    generated = resource["key"]["generated"]
    if generated == "increment":
        assign = f"        item.{key_property} = Interlocked.Increment(ref lastKey);"
    elif generated == "uuid":
        new_key = "Guid.NewGuid()" if key == "Guid" else "Guid.NewGuid().ToString()"
        assign = f"        item.{key_property} = {new_key};"
    else:
        assign = False

    if not context.ef_core:
        usings = CsUsings(namespace).add("System.Collections.Concurrent", model, common_namespace(context))
        values = [
            f"        {cs_string(field['wire'])} => item.{property_name(field, item_type)},"
            for field in resource["fields"]
        ]
        if key == "string":
            by_key = f".OrderBy(item => item.{key_property}, StringComparer.Ordinal)"
        else:
            by_key = f".OrderBy(item => item.{key_property})"
        files.append(
            file(
                name["memory"],
                usings,
                [
                    cs_doc(
                        f"Keeps {plural} in memory: they are lost when the application stops. Use it to try the API."
                    ),
                    f"public sealed class {name['memory']} : {name['repository']}",
                    "{",
                    f"    private readonly ConcurrentDictionary<{key}, {item_type}> items = new();",
                    generated == "increment" and ["", "    private long lastKey;"],
                    "",
                    "    /// <summary>The value of a field by its JSON name, for filters and sorting.</summary>",
                    f"    private static object? Value({item_type} item, string field) => field switch",
                    "    {",
                    values,
                    "        _ => null,",
                    "    };",
                    "",
                    f"    public Task<ListResult<{item_type}>> ListAsync(ListQuery query)",
                    "    {",
                    "        var found = items.Values",
                    "            .Where(item => query.Filters.All(filter => Equals(Value(item, filter.Key), filter.Value)))",
                    f"            {by_key}",
                    "            .ToList();",
                    "        if (query.SortField is { } field)",
                    "        {",
                    "            var present = found.Where(item => Value(item, field) is not null);",
                    "            var sorted = query.Descending",
                    "                ? present.OrderByDescending(item => Value(item, field), Comparer<object?>.Default)",
                    "                : present.OrderBy(item => Value(item, field), Comparer<object?>.Default);",
                    "            // Items without a value go last, whatever the order",
                    "            found = [.. sorted, .. found.Where(item => Value(item, field) is null)];",
                    "        }",
                    "        var window = found.Skip(query.Offset).Take(query.Limit ?? int.MaxValue).Select(item => JsonValues.Copy(item)).ToList();",
                    f"        return Task.FromResult(new ListResult<{item_type}>(window, found.Count));",
                    "    }",
                    "",
                    f"    public Task<{item_type}?> GetAsync({key} key) =>",
                    "        Task.FromResult(items.TryGetValue(key, out var item) ? JsonValues.Copy(item) : null);",
                    "",
                    f"    public Task<{item_type}> AddAsync({item_type} item)",
                    "    {",
                    assign,
                    f"        items[item.{key_property}] = JsonValues.Copy(item);",
                    "        return Task.FromResult(item);",
                    "    }",
                    "",
                    f"    public Task<{item_type}> UpdateAsync({item_type} item)",
                    "    {",
                    f"        items[item.{key_property}] = JsonValues.Copy(item);",
                    "        return Task.FromResult(item);",
                    "    }",
                    "",
                    f"    public Task DeleteAsync({key} key)",
                    "    {",
                    "        items.TryRemove(key, out _);",
                    "        return Task.CompletedTask;",
                    "    }",
                    "}",
                ],
            )
        )
        return files

    usings = CsUsings(namespace).add(
        "System.Linq.Expressions",
        "Microsoft.EntityFrameworkCore",
        model,
        common_namespace(context),
        data_namespace(context),
    )
    fields = queryable_fields(resource)
    filters = []
    sorts = []
    for field in fields:
        is_key = field["name"] == resource["key"]["field"]
        prop = property_name(field, item_type)
        wire = cs_string(field["wire"])
        type_name = field_type(context, field, usings, resource, not is_key)
        filters.append(f"                {wire} => items.Where(item => item.{prop} == ({type_name})value),")
        if is_key:
            sorts.append(
                f"            {wire} => query.Descending ? items.OrderByDescending(item => item.{prop}) : items.OrderBy(item => item.{prop}),"
            )
        else:
            sorts.append(f"            {wire} => Sorted(items, item => item.{prop}, query.Descending),")
    files.append(
        file(
            name["efRepository"],
            usings,
            [
                cs_doc(f"Keeps {plural} in the database with Entity Framework Core."),
                f"public sealed class {name['efRepository']}(AppDbContext database) : {name['repository']}",
                "{",
                f"    public async Task<ListResult<{item_type}>> ListAsync(ListQuery query)",
                "    {",
                f"        IQueryable<{item_type}> items = database.{name['set']};",
                "        foreach (var (field, value) in query.Filters)",
                "        {",
                "            items = field switch",
                "            {",
                filters,
                "                _ => items,",
                "            };",
                "        }",
                "        var total = await items.LongCountAsync();",
                "        items = query.SortField switch",
                "        {",
                sorts,
                f"            _ => items.OrderBy(item => item.{key_property}),",
                "        };",
                "        items = items.Skip(query.Offset);",
                "        if (query.Limit is { } limit)",
                "        {",
                "            items = items.Take(limit);",
                "        }",
                f"        return new ListResult<{item_type}>(await items.AsNoTracking().ToListAsync(), total);",
                "    }",
                "",
                f"    public async Task<{item_type}?> GetAsync({key} key) => await database.{name['set']}.FindAsync(key);",
                "",
                f"    public async Task<{item_type}> AddAsync({item_type} item)",
                "    {",
                generated == "uuid" and key == "string" and assign,
                f"        database.{name['set']}.Add(item);",
                "        await database.SaveChangesAsync();",
                "        // Read back, so the answer has what the database keeps",
                "        await database.Entry(item).ReloadAsync();",
                "        return item;",
                "    }",
                "",
                f"    public async Task<{item_type}> UpdateAsync({item_type} item)",
                "    {",
                "        await database.SaveChangesAsync();",
                "        await database.Entry(item).ReloadAsync();",
                "        return item;",
                "    }",
                "",
                f"    public async Task DeleteAsync({key} key) =>",
                f"        await database.{name['set']}.Where(item => item.{key_property} == key).ExecuteDeleteAsync();",
                "",
                "    /// <summary>Sorts by a field: items without a value go last, whatever the order, and the key breaks ties.</summary>",
                f"    private static IQueryable<{item_type}> Sorted<TValue>(IQueryable<{item_type}> items, Expression<Func<{item_type}, TValue>> value, bool descending)",
                "    {",
                f"        var missing = Expression.Lambda<Func<{item_type}, bool>>(",
                "            Expression.Equal(value.Body, Expression.Constant(null, typeof(TValue))), value.Parameters);",
                "        var ordered = items.OrderBy(missing);",
                f"        return (descending ? ordered.ThenByDescending(value) : ordered.ThenBy(value)).ThenBy(item => item.{key_property});",
                "    }",
                "}",
            ],
        )
    )
    return files
