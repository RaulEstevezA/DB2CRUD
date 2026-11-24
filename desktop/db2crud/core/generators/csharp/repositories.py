"""The repositories of each table: the interface services depend on (when the settings want one), its database
implementation (its bodies are the strategy's), and its in-memory one, with the same methods. Repositories decide
nothing. Mirrors web/src/core/generators/csharp/repositories.ts."""

from ...js import number_text
from ..types import lines
from .context import (
    column_of,
    common_namespace,
    errors_namespace,
    is_in,
    memory_repository_class,
    namespace_of,
    path_of,
    query_name,
    repository_interface,
    sql_repository_class,
)
from .csharp import CsUsings, cs_string


def repository_methods(context: dict, info: dict, usings: CsUsings) -> list[dict]:
    """The methods of a table's repository, with their C# signatures."""
    entity = info["entity"]
    paging = context["settings"]["paging"]
    methods = []
    for query_design in info["queries"]:
        name = query_name(context, query_design)
        by_columns = [
            {"name": column_of(info, column)["local"], "type": column_of(info, column)["cs"]}
            for column in query_design["columns"]
        ]

        def add(params: list, returns: str, doc: str, query_design: dict = query_design, name: str = name) -> None:
            methods.append({"query": query_design, "name": name, "params": params, "returns": returns, "doc": doc})

        kind = query_design["kind"]
        joined = " and ".join(query_design["columns"])
        if kind == "getByKey":
            add(by_columns, f"Task<{entity}?>", "The row with this primary key, or null.")
        elif kind == "findByUnique":
            add(by_columns, f"Task<{entity}?>", f"The row with this {joined}, or null.")
        elif kind in ("listByParent", "findAllBy"):
            add(by_columns, f"Task<List<{entity}>>", f"Rows with this {joined}, by primary key.")
        elif kind == "list":
            if paging == "offset":
                usings.add(common_namespace(context))
                add(
                    [{"name": "offset", "type": "int"}, {"name": "limit", "type": "int"}],
                    f"Task<Page<{entity}>>",
                    "At most limit rows from offset, by primary key, and how many there are.",
                )
            elif paging == "cursor":
                usings.add(common_namespace(context))
                add(
                    [{"name": "after", "type": "IReadOnlyList<object>?"}, {"name": "limit", "type": "int"}],
                    f"Task<CursorPage<{entity}>>",
                    "At most limit rows after the key after (null for the first page), by primary key, and the key to read the next page from.",
                )
            else:
                add([], f"Task<List<{entity}>>", "Every row, by primary key.")
        elif kind == "insert":
            add(
                [{"name": "entity", "type": entity}],
                f"Task<{entity}>",
                "Stores a new row; the values the database fills are read back.",
            )
        elif kind == "update":
            add(
                [{"name": "entity", "type": entity}],
                f"Task<{entity}>",
                "Stores the changes made to a row read from this repository.",
            )
        elif kind == "delete":
            add([{"name": "entity", "type": entity}], "Task", "Removes a row read from this repository.")
    return methods


def _signature(method: dict) -> str:
    params = ", ".join(f"{param['type']} {param['name']}" for param in method["params"])
    return f"{method['returns']} {method['name']}({params})"


# In memory


def _literal_of(cs: str, value: str) -> str:
    if cs == "long":
        return f"{value}L"
    if cs == "short":
        return f"(short){value}"
    if cs == "decimal":
        return f"{value}m"
    if cs == "float":
        return f"{value}f"
    if cs == "double":
        return value if "." in value else f"{value}.0"
    if cs == "string":
        return cs_string(value)
    return value


def _memory_fill(info: dict, column: dict) -> str | None:
    db = column["column"]
    target = f"entity.{column['prop']}"
    primary = is_in(column, info["key"])
    generated = db.get("generated")
    if generated == "identity":
        value = "nextId++" if column["cs"] == "long" else f"({column['cs']})nextId++"
        return f"if ({target} == 0) {target} = {value};" if primary else f"{target} ??= {value};"
    if generated == "uuid":
        return f"if ({target} == Guid.Empty) {target} = Guid.NewGuid();" if primary else f"{target} ??= Guid.NewGuid();"
    if generated in ("now", "onUpdateNow"):
        return f"{target} ??= {'DateTimeOffset.UtcNow' if column['cs'] == 'DateTimeOffset' else 'DateTime.Now'};"
    default = db.get("default")
    if default and default["kind"] == "literal" and default["value"] is not None and column["optional"]:
        value = default["value"]
        if isinstance(value, bool):
            text = "true" if value else "false"
        else:
            text = _literal_of(column["cs"], value if isinstance(value, str) else number_text(value))
        return f"{target} ??= {text};"
    return None


def _memory_visible(info: dict) -> str:
    soft = info["soft"]
    if not soft:
        return "true"
    return (
        f"row.{soft['prop']} != true" if soft["column"]["type"]["kind"] == "boolean" else f"row.{soft['prop']} == null"
    )


def _memory_body(context: dict, info: dict, method: dict) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    conditions = " && ".join(f"Equals(row.{column['prop']}, {column['local']})" for column in columns)
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    entity = info["entity"]
    if kind in ("getByKey", "findByUnique"):
        return [f"return Task.FromResult(Visible().FirstOrDefault(row => {conditions}));"]
    if kind in ("listByParent", "findAllBy"):
        return [f"return Task.FromResult(Visible().Where(row => {conditions}).ToList());"]
    if kind == "list":
        if paging == "offset":
            return [
                "var rows = Visible().ToList();",
                f"return Task.FromResult(new Page<{entity}>(rows.Skip(offset).Take(limit).ToList(), rows.Count, offset, limit));",
            ]
        if paging == "cursor":
            return [
                "var rows = Visible().Where(row => after is null || Compare(KeyOf(row), after) > 0).ToList();",
                "var items = rows.Take(limit).ToList();",
                f"return Task.FromResult(new CursorPage<{entity}>(items, rows.Count > limit ? KeyOf(items[^1]) : null));",
            ]
        return ["return Task.FromResult(Visible().ToList());"]
    if kind in ("insert", "update"):
        return ["rows[KeyText(entity)] = entity;", "return Task.FromResult(entity);"]
    if kind == "delete":
        return ["rows.Remove(KeyText(entity));", "return Task.CompletedTask;"]
    return ["throw new NotSupportedException();"]


def _block(method: dict, body: list[str], modifier: str, is_async: bool, doc: bool) -> list:
    return [
        "",
        doc and f"    /// <summary>{method['doc']}</summary>",
        f"    public {modifier}{'async ' if is_async else ''}{_signature(method)}",
        "    {",
        *(f"        {line}" if isinstance(line, str) else line for line in body),
        "    }",
    ]


def repository_files(context: dict, info: dict) -> list[dict]:
    ns = namespace_of(context, info, "repository")
    entity_ns = namespace_of(context, info, "entity")
    interfaces = context["settings"]["repositoryInterfaces"]
    entity = info["entity"]
    files = []

    def unit(name: str, usings: CsUsings, body: list) -> dict:
        written = usings.write()
        return {
            "path": path_of(ns, name),
            "content": lines(written != "" and [written, ""], f"namespace {ns};", "", *body, ""),
        }

    if interfaces:
        usings = CsUsings(ns).add(entity_ns)
        methods = repository_methods(context, info, usings)
        members = []
        for index, method in enumerate(methods):
            members += [
                "" if index > 0 else None,
                f"    /// <summary>{method['doc']}</summary>",
                f"    {_signature(method)};",
            ]
        files.append(
            unit(
                repository_interface(info),
                usings,
                [
                    f"/// <summary>Where {info['name']} rows are kept. Services depend only on this interface.</summary>",
                    f"public interface {repository_interface(info)}",
                    "{",
                    *members,
                    "}",
                ],
            )
        )
    repository = context["orm"]["repository"]
    usings = CsUsings(ns).add(entity_ns, context["base"], *repository["usings"], errors_namespace(context))
    methods = repository_methods(context, info, usings)
    modifier = "" if interfaces else "virtual "
    head = repository["head"](context, info)
    bodies = [
        line
        for method in methods
        for line in _block(method, repository["body"](context, info, method, usings), modifier, True, not interfaces)
    ]
    tail = repository["tail"](context, info, usings)
    implements = f" : {repository_interface(info)}" if interfaces else ""
    files.append(
        unit(
            sql_repository_class(info),
            usings,
            [
                f"/// <summary>{repository['doc'](context, info)}</summary>",
                f"public class {sql_repository_class(info)}({context['orm']['holder']} db){implements}",
                "{",
                *head,
                *(bodies if head else bodies[1:]),
                *tail,
                "}",
            ],
        )
    )
    if context["settings"]["memoryRepositories"]:
        usings = CsUsings(ns).add(entity_ns)
        methods = repository_methods(context, info, usings)
        fills = [line for line in (_memory_fill(info, column) for column in info["columns"]) if line is not None]
        modifier = "" if interfaces else "override "
        bodies = []
        for method in methods:
            body = _memory_body(context, info, method)
            bodies.append(
                _block(method, [*fills, *body] if method["query"]["kind"] == "insert" else body, modifier, False, False)
            )
        identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
        key_values = ", ".join(f"row.{column['prop']}" for column in info["key"])
        memory = memory_repository_class(info)
        files.append(
            unit(
                memory,
                usings,
                [
                    f"/// <summary>Keeps {info['name']} rows in memory, for tests and for trying the services without a database.</summary>",
                    f"public class {memory} : {repository_interface(info)}"
                    if interfaces
                    else f"public class {memory}() : {sql_repository_class(info)}(null!)",
                    "{",
                    f"    private readonly Dictionary<string, {entity}> rows = [];",
                    identity and "    private long nextId = 1;",
                    "",
                    "    /// <summary>The key of a row, as a list of its key values.</summary>",
                    f"    private static object[] KeyOf({entity} row) => [{key_values}];",
                    "",
                    f'    private static string KeyText({entity} row) => string.Join("|", KeyOf(row));',
                    "",
                    "    /// <summary>Orders two keys value by value.</summary>",
                    "    private static int Compare(IReadOnlyList<object> a, IReadOnlyList<object> b)",
                    "    {",
                    "        for (var index = 0; index < a.Count; index++)",
                    "        {",
                    "            var order = Comparer<object>.Default.Compare(a[index], b[index]);",
                    "            if (order != 0) return order;",
                    "        }",
                    "        return 0;",
                    "    }",
                    "",
                    f"    private IEnumerable<{entity}> Visible() =>",
                    f"        rows.Values.Where(row => {_memory_visible(info)}).OrderBy(KeyOf, Comparer<object[]>.Create((a, b) => Compare(a, b)));",
                    *[line for block in bodies for line in block],
                    "}",
                ],
            )
        )
    return files
