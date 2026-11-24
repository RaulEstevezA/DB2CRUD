"""The EF Core repositories, over AppDbContext: LINQ reads that leave out rows marked as deleted, writes saved at once so a
database refusal becomes a ConflictException, and the values the database fills read back by EF Core. Mirrors
web/src/core/generators/csharp/efcore/repository.ts."""

from ..context import column_of, errors_namespace, is_in
from ..csharp import CsUsings, cs_string


def _soft_condition(info: dict) -> str | None:
    soft = info["soft"]
    if not soft:
        return None
    return f"e.{soft['prop']} != true" if soft["column"]["type"]["kind"] == "boolean" else f"e.{soft['prop']} == null"


def _where(conditions: list) -> str:
    present = [item for item in conditions if item is not None]
    return f".Where(e => {' && '.join(present)})" if present else ""


def _order(info: dict) -> str:
    return "".join(
        f".{'OrderBy' if index == 0 else 'ThenBy'}(e => e.{column['prop']})" for index, column in enumerate(info["key"])
    )


def _equals(columns: list[dict]) -> list[str]:
    return [f"e.{column['prop']} == {column['local']}" for column in columns]


def _uuids(info: dict) -> list[str]:
    """A uuid that is not the key is made before the insert: SQLite and MySQL have no default for it."""
    return [
        f"entity.{column['prop']} ??= Guid.NewGuid();"
        for column in info["columns"]
        if column["column"].get("generated") == "uuid" and not is_in(column, info["key"])
    ]


def ef_body(context: dict, info: dict, method: dict, usings: CsUsings) -> list[str]:
    table_set = f"db.{info['attr']}"
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(info)
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    entity = info["entity"]
    if kind in ("getByKey", "findByUnique"):
        return [f"return await {table_set}{_where([*_equals(columns), soft])}.FirstOrDefaultAsync();"]
    if kind in ("listByParent", "findAllBy"):
        return [f"return await {table_set}{_where([*_equals(columns), soft])}{_order(info)}.ToListAsync();"]
    if kind == "list":
        if paging == "offset":
            return [
                f"var query = {table_set}{_where([soft])};",
                "var total = await query.LongCountAsync();",
                f"var items = await query{_order(info)}.Skip(offset).Take(limit).ToListAsync();",
                f"return new Page<{entity}>(items, total, offset, limit);",
            ]
        if paging == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            key = info["key"]
            casts = [f"var k{index} = ({column['cs']})after[{index}];" for index, column in enumerate(key)]

            def compare(column: dict, index: int) -> str:
                if column["cs"] in ("string", "Guid"):
                    return f"e.{column['prop']}.CompareTo(k{index}) > 0"
                return f"e.{column['prop']} > k{index}"

            options = []
            for index, column in enumerate(key):
                parts = [f"e.{before['prop']} == k{position}" for position, before in enumerate(key[:index])]
                parts.append(compare(column, index))
                item = " && ".join(parts)
                options.append(f"({item})" if len(key) > 1 else item)
            after = " || ".join(options)
            last = ", ".join(f"items[^1].{column['prop']}" for column in key)
            return [
                f"IQueryable<{entity}> query = {table_set}{_where([soft])};",
                "if (after is not null)",
                "{",
                *(f"    {line}" for line in casts),
                f"    query = query.Where(e => {after});",
                "}",
                f"var rows = await query{_order(info)}.Take(limit + 1).ToListAsync();",
                "var items = rows.Take(limit).ToList();",
                f"return new CursorPage<{entity}>(items, rows.Count > limit ? [{last}] : null);",
            ]
        return [f"return await {table_set}{_where([soft])}{_order(info)}.ToListAsync();"]
    if kind == "insert":
        usings.add(errors_namespace(context))
        return [*_uuids(info), f"{table_set}.Add(entity);", "await SaveAsync();", "return entity;"]
    if kind == "update":
        return [f"{table_set}.Update(entity);", "await SaveAsync();", "return entity;"]
    if kind == "delete":
        return [f"{table_set}.Remove(entity);", "await SaveAsync();"]
    return ["throw new NotSupportedException();"]


def ef_tail(_context: dict, info: dict, _usings: CsUsings) -> list:
    """SaveAsync, which every write goes through."""
    return [
        "",
        "    /// <summary>Saves the changes; a database refusal (a unique value, a row still pointed to) becomes a ConflictException.</summary>",
        "    private async Task SaveAsync()",
        "    {",
        "        try",
        "        {",
        "            await db.SaveChangesAsync();",
        "        }",
        "        catch (DbUpdateException error)",
        "        {",
        "            db.ChangeTracker.Clear();",
        f'            throw new ConflictException({cs_string(info["entity"])}, $"the database refused the change: {{error.InnerException?.Message ?? error.Message}}");',
        "        }",
        "    }",
    ]
