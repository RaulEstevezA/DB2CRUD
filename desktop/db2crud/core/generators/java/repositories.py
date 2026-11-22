"""The repositories of each table: the interface services depend on (when the settings want one), its database
implementation (written by the strategy: JPA or JDBC), and its in-memory one, with the same methods. Repositories decide
nothing. Mirrors web/src/core/generators/java/repositories.ts."""

from ...js import number_text
from ..types import lines
from .context import (
    column_of,
    common_package,
    memory_repository_class,
    package_of,
    qualified,
    query_name,
    repository_interface,
    sql_repository_class,
)
from .java import JavaImports, java_path, java_string


def repository_methods(context: dict, info: dict, imports: JavaImports) -> list[dict]:
    """The methods of a table's repository, with their Java signatures."""
    entity = info["entity"]
    paging = context["settings"]["paging"]
    methods = []
    for query_design in info["queries"]:
        name = query_name(context, query_design)
        by_columns = [
            {"name": column_of(info, column)["prop"], "type": column_of(info, column)["java"]}
            for column in query_design["columns"]
        ]
        for column in query_design["columns"]:
            java_import = column_of(info, column)["javaImport"]
            if java_import:
                imports.add(java_import)

        def add(params: list, returns: str, doc: str, query_design: dict = query_design, name: str = name) -> None:
            methods.append({"query": query_design, "name": name, "params": params, "returns": returns, "doc": doc})

        kind = query_design["kind"]
        if kind == "getByKey":
            imports.add("java.util.Optional")
            add(by_columns, f"Optional<{entity}>", "The row with this primary key, if there is one.")
        elif kind == "findByUnique":
            imports.add("java.util.Optional")
            add(
                by_columns,
                f"Optional<{entity}>",
                f"The row with this {' and '.join(query_design['columns'])}, if there is one.",
            )
        elif kind in ("listByParent", "findAllBy"):
            imports.add("java.util.List")
            add(
                by_columns,
                f"List<{entity}>",
                f"Rows with this {' and '.join(query_design['columns'])}, by primary key.",
            )
        elif kind == "list":
            if paging == "offset":
                imports.add(f"{common_package(context)}.Page")
                add(
                    [{"name": "offset", "type": "int"}, {"name": "limit", "type": "int"}],
                    f"Page<{entity}>",
                    "At most limit rows from offset, by primary key, and how many there are.",
                )
            elif paging == "cursor":
                imports.add(f"{common_package(context)}.CursorPage", "java.util.List")
                add(
                    [{"name": "after", "type": "List<Object>"}, {"name": "limit", "type": "int"}],
                    f"CursorPage<{entity}>",
                    "At most limit rows after the key after (null for the first page), by primary key, and the key to read the next page from.",
                )
            else:
                imports.add("java.util.List")
                add([], f"List<{entity}>", "Every row, by primary key.")
        elif kind == "insert":
            add(
                [{"name": "entity", "type": entity}],
                entity,
                "Stores a new row; the values the database fills are read back.",
            )
        elif kind == "update":
            add(
                [{"name": "entity", "type": entity}],
                entity,
                "Stores the changes made to a row read from this repository.",
            )
        elif kind == "delete":
            add([{"name": "entity", "type": entity}], "void", "Removes a row read from this repository.")
    return methods


def _signature(method: dict) -> str:
    params = ", ".join(f"{param['type']} {param['name']}" for param in method["params"])
    return f"{method['returns']} {method['name']}({params})"


# In memory


def _literal_of(java: str, value: str) -> str:
    """A default value of the database as a Java literal of the column's type."""
    if java == "Long":
        return f"{value}L"
    if java == "Short":
        return f"(short) {value}"
    if java == "BigDecimal":
        return f"new BigDecimal({java_string(value)})"
    if java == "String":
        return java_string(value)
    if java == "Double":
        return value if "." in value else f"{value}.0"
    if java == "Float":
        return f"{value}f"
    return value


def _string_of(value) -> str:
    """String(value) of the web version."""
    if isinstance(value, str):
        return value
    return number_text(value)


def _memory_fill(column: dict, imports: JavaImports) -> str | None:
    db = column["column"]
    generated = db.get("generated")

    def set_(value: str) -> str:
        return f"if (entity.{column['getter']}() == null) entity.{column['setter']}({value});"

    if generated == "identity":
        java = column["java"]
        return set_("nextId++" if java == "Long" else "(short) nextId++" if java == "Short" else "(int) nextId++")
    if generated == "uuid":
        return set_("UUID.randomUUID()")
    if generated in ("now", "onUpdateNow"):
        if column["java"] == "OffsetDateTime":
            imports.add("java.time.ZoneOffset")
            return set_("OffsetDateTime.now(ZoneOffset.UTC)")
        return set_(f"{column['java']}.now()")
    default = db.get("default")
    if default and default["kind"] == "literal" and default["value"] is not None:
        return set_(_literal_of(column["java"], _string_of(default["value"])))
    return None


def _memory_visible(info: dict) -> str:
    soft = info["soft"]
    if not soft:
        return "true"
    if soft["column"]["type"]["kind"] == "boolean":
        return f"!Boolean.TRUE.equals(row.{soft['getter']}())"
    return f"row.{soft['getter']}() == null"


def _memory_body(context: dict, info: dict, method: dict) -> list:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    conditions = " && ".join(f"Objects.equals(row.{column['getter']}(), {column['prop']})" for column in columns)
    kind = method["query"]["kind"]
    entity = info["entity"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [f"return visible().filter((row) -> {conditions}).findFirst();"]
    if kind in ("listByParent", "findAllBy"):
        return [f"return visible().filter((row) -> {conditions}).toList();"]
    if kind == "list":
        if paging == "offset":
            return [
                f"List<{entity}> rows = visible().toList();",
                "return new Page<>(rows.stream().skip(offset).limit(limit).toList(), rows.size(), offset, limit);",
            ]
        if paging == "cursor":
            return [
                f"List<{entity}> rows = visible().filter((row) -> after == null || compareKeys(keyOf(row), after) > 0).toList();",
                f"List<{entity}> items = rows.stream().limit(limit).toList();",
                "return new CursorPage<>(items, rows.size() > limit ? keyOf(items.get(items.size() - 1)) : null);",
            ]
        return ["return visible().toList();"]
    if kind in ("insert", "update"):
        return ["rows.put(keyOf(entity), entity);", "return entity;"]
    if kind == "delete":
        return ["rows.remove(keyOf(entity));"]
    return ["throw new UnsupportedOperationException();"]


def _block(method: dict, body: list, override: bool) -> list:
    return [
        "",
        "    @Override" if override else f"    /** {method['doc']} */",
        f"    public {_signature(method)} {{",
        *((f"        {line}" if isinstance(line, str) else line) for line in body),
        "    }",
    ]


def repository_files(context: dict, info: dict) -> list[dict]:
    pkg = package_of(context, info, "repository")
    entity_import = qualified(context, info, "entity", info["entity"])
    interfaces = context["settings"]["repositoryInterfaces"]
    entity = info["entity"]
    files = []

    def unit(name: str, imports: JavaImports, body: list) -> dict:
        return {"path": java_path(pkg, name), "content": lines(f"package {pkg};", "", imports.write(), "", *body, "")}

    if interfaces:
        imports = JavaImports(pkg).add(entity_import)
        methods = repository_methods(context, info, imports)
        members = []
        for index, method in enumerate(methods):
            members += ["" if index > 0 else None, f"    /** {method['doc']} */", f"    {_signature(method)};"]
        files.append(
            unit(
                repository_interface(info),
                imports,
                [
                    f"/** Where {info['name']} rows are kept. Services depend only on this interface. */",
                    f"public interface {repository_interface(info)} {{",
                    *members,
                    "}",
                ],
            )
        )
    # The database
    orm = context["orm"]
    imports = JavaImports(pkg).add(entity_import)
    methods = repository_methods(context, info, imports)
    bodies = [
        _block(method, orm["repository"]["body"](context, info, method, imports), interfaces) for method in methods
    ]
    head = orm["repository"]["head"](context, info, imports)
    tail = orm["repository"]["tail"](context, info, imports)
    implements = f" implements {repository_interface(info)}" if interfaces else ""
    files.append(
        unit(
            sql_repository_class(info),
            imports,
            [
                f"/** {orm['repository']['doc'](context, info)} */",
                f"public class {sql_repository_class(info)}{implements} {{",
                *head,
                *[line for block in bodies for line in block],
                *tail,
                "}",
            ],
        )
    )
    if context["settings"]["memoryRepositories"]:
        imports = JavaImports(pkg).add(
            entity_import,
            "java.util.ArrayList",
            "java.util.Comparator",
            "java.util.LinkedHashMap",
            "java.util.List",
            "java.util.Map",
            "java.util.Objects",
            "java.util.stream.Stream",
        )
        methods = repository_methods(context, info, imports)
        fills = [line for line in (_memory_fill(column, imports) for column in info["columns"]) if line is not None]
        for column in info["columns"]:
            if column["javaImport"]:
                imports.add(column["javaImport"])
        bodies = []
        for method in methods:
            body = _memory_body(context, info, method)
            bodies.append(_block(method, [*fills, *body] if method["query"]["kind"] == "insert" else body, True))
        identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
        memory = memory_repository_class(info)
        files.append(
            unit(
                memory,
                imports,
                [
                    f"/** Keeps {info['name']} rows in memory, for tests and for trying the services without a database. */",
                    f"public class {memory} implements {repository_interface(info)} {{"
                    if interfaces
                    else f"public class {memory} extends {sql_repository_class(info)} {{",
                    f"    private final Map<List<Object>, {entity}> rows = new LinkedHashMap<>();",
                    identity and "    private long nextId = 1;",
                    not interfaces and ["", f"    public {memory}() {{", "        super(null);", "    }"],
                    "",
                    "    /** The key of a row, as a list of its key values. */",
                    f"    private static List<Object> keyOf({entity} row) {{",
                    "        List<Object> key = new ArrayList<>();",
                    *(f"        key.add(row.{column['getter']}());" for column in info["key"]),
                    "        return key;",
                    "    }",
                    "",
                    "    /** Orders two keys value by value. */",
                    '    @SuppressWarnings({"unchecked", "rawtypes"})',
                    "    private static int compareKeys(List<Object> a, List<Object> b) {",
                    "        for (int index = 0; index < a.size(); index++) {",
                    "            int order = ((Comparable) a.get(index)).compareTo(b.get(index));",
                    "            if (order != 0) return order;",
                    "        }",
                    "        return 0;",
                    "    }",
                    "",
                    f"    private Stream<{entity}> visible() {{",
                    f"        return rows.values().stream().filter((row) -> {_memory_visible(info)}).sorted(Comparator.comparing({memory}::keyOf, {memory}::compareKeys));",
                    "    }",
                    *[line for block in bodies for line in block],
                    "}",
                ],
            )
        )
    return files
