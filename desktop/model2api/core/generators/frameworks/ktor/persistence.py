"""Storage of each resource in the Ktor project: the repository interface the service depends on, and the
implementation of the chosen persistence:
- memory: a map, to run the API without a database; it keeps copies, never the caller's objects
- none: every method calls TODO(), which the API answers with 501
- exposed: a table and a repository with Exposed, with filters and sorting written for each field
Mirrors web/src/core/generators/frameworks/ktor/persistence.ts.
"""

from ....js import number_text
from ...common.text import file_text, lines
from ...languages.kotlin.kotlin import KtImports, kt_class, kt_doc, kt_header, kt_string
from .context import KtorContext, column, common_package, key_field, key_type, names, property_name, source_path
from .model import serializer_of, stored_as_json


def _queryable(field: dict) -> bool:
    """Whether a field can be filtered and sorted in the database: plain values, enums and single references."""
    return not stored_as_json(field) and field["type"]["kind"] in ("scalar", "enum")


def _same(value: str) -> str:
    return value


class _Column:
    def __init__(self, definition: str, write=_same, read=_same, match=_same) -> None:
        self.definition = definition
        self.write = write
        self.read = read
        self.match = match


def _target(context: KtorContext, name: str) -> dict:
    return next(item for item in context.spec["resources"] if item["name"] == name)


def _column_of(context: KtorContext, resource: dict, field: dict, imports: KtImports) -> _Column:
    """The Exposed column of a field, and how a value goes in and comes out of it."""
    name = kt_string(column(field))

    def key_column(target: dict) -> str:
        scalar = target["key"]["type"]["scalar"]
        if scalar == "integer":
            return f"long({name})"
        if scalar == "uuid":
            imports.add("org.jetbrains.exposed.v1.core.java.javaUUID")
            return f"javaUUID({name})"
        length = key_field(target)["constraints"].get("maxLength")
        return f"varchar({name}, {number_text(length if length is not None else 191)})"

    if field["name"] == resource["key"]["field"]:
        definition = key_column(resource)
        return _Column(f"{definition}.autoIncrement()" if resource["key"]["generated"] == "increment" else definition)
    if stored_as_json(field):
        serializer = serializer_of(context, field, imports)
        imports.add(f"{common_package(context)}.JsonFormat")
        return _Column(
            f"text({name}).nullable()",
            lambda value: f"{value}?.let {{ JsonFormat.encodeToString({serializer}, it) }}",
            lambda value: f"{value}?.let {{ JsonFormat.decodeFromString({serializer}, it) }}",
        )
    if field.get("reference"):
        return _Column(f"{key_column(_target(context, field['reference']))}.nullable()")
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        enum_class = kt_class(type_ref["name"])
        imports.add(f"{context.layout.shared()}.{enum_class}")
        if item["valueType"] == "integer":
            return _Column(
                f"long({name}).nullable()",
                lambda value: f"{value}?.value",
                lambda value: f"{value}?.let {{ {enum_class}.fromValue(it) }}",
                lambda value: f"{value}.value",
            )
        return _Column(
            f"varchar({name}, 64).nullable()",
            lambda value: f"{value}?.name",
            lambda value: f"{value}?.let {{ {enum_class}.valueOf(it) }}",
            lambda value: f"{value}.name",
        )
    if type_ref["kind"] != "scalar":
        return _Column(f"text({name}).nullable()")
    max_length = field["constraints"].get("maxLength")
    text = (
        f"varchar({name}, {number_text(max_length)})"
        if max_length is not None and max_length <= 255
        else f"text({name})"
    )

    def time(fn: str) -> str:
        imports.add(f"org.jetbrains.exposed.v1.javatime.{fn}")
        return f"{fn}({name})"

    scalar = type_ref["scalar"]
    if scalar == "integer":
        return _Column(f"{'long' if type_ref.get('bits') == 64 else 'integer'}({name}).nullable()")
    if scalar == "float":
        return _Column(f"double({name}).nullable()")
    if scalar == "decimal":
        return _Column(f"decimal({name}, 18, 4).nullable()")
    if scalar == "boolean":
        return _Column(f"bool({name}).nullable()")
    if scalar == "date":
        return _Column(f"{time('date')}.nullable()")
    if scalar == "datetime":
        return _Column(f"{time('timestamp')}.nullable()")
    if scalar == "uuid":
        imports.add("org.jetbrains.exposed.v1.core.java.javaUUID")
        return _Column(f"javaUUID({name}).nullable()")
    if scalar == "time":
        return _Column(f"varchar({name}, 32).nullable()")
    return _Column(f"{text}.nullable()")


def _cast_of(context: KtorContext, field: dict, imports: KtImports) -> str:
    """The Kotlin type a filter value has, for the cast before comparing it with its column."""
    if field.get("reference"):
        key = key_type(_target(context, field["reference"]))
        if key == "JsonUuid":
            imports.add(f"{common_package(context)}.JsonUuid")
        return key
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        return kt_class(type_ref["name"])
    if type_ref["kind"] != "scalar":
        return "String"
    scalar = type_ref["scalar"]
    if scalar == "integer":
        return "Long" if type_ref.get("bits") == 64 else "Int"
    if scalar == "float":
        return "Double"
    if scalar == "boolean":
        return "Boolean"
    if scalar == "decimal":
        imports.add("java.math.BigDecimal")
        return "BigDecimal"
    if scalar == "date":
        imports.add("java.time.LocalDate")
        return "LocalDate"
    if scalar == "datetime":
        imports.add("java.time.Instant")
        return "Instant"
    if scalar == "uuid":
        imports.add("java.util.UUID")
        return "UUID"
    return "String"


def repository_files(context: KtorContext, resource: dict) -> list[dict]:
    package = context.layout.resource(resource, "repository")
    name = names(resource)
    item_type = name["type"]
    common = common_package(context)
    model = f"{context.layout.resource(resource, 'model')}.{item_type}"
    key = key_type(resource)
    key_property = property_name(key_field(resource))
    plural = resource["plural"]

    def file(class_name: str, imports: KtImports, body: list) -> dict:
        return {
            "path": source_path(package, class_name),
            "content": file_text(lines(*kt_header(package, imports), *body)),
        }

    def key_import(imports: KtImports) -> KtImports:
        return imports.add(f"{common}.JsonUuid") if key == "JsonUuid" else imports

    files = []
    assigns = " and assigns its key" if resource["key"]["generated"] else ""
    files.append(
        file(
            name["repository"],
            key_import(KtImports(package).add(model, f"{common}.ListQuery", f"{common}.ListResult")),
            [
                kt_doc(f"Where {plural} are kept. The service depends only on this interface."),
                f"interface {name['repository']} {{",
                "    /** Items equal to every filter, in order, within the window; and how many match. */",
                f"    suspend fun list(query: ListQuery): ListResult<{item_type}>",
                "",
                "    /** The item with this key, or null when there is none. */",
                f"    suspend fun get(key: {key}): {item_type}?",
                "",
                f"    /** Stores a new item{assigns}; returns it as stored. */",
                f"    suspend fun add(item: {item_type}): {item_type}",
                "",
                "    /** Stores the new state of an existing item and returns it. */",
                f"    suspend fun update(item: {item_type}): {item_type}",
                "",
                "    /** Removes an existing item. */",
                f"    suspend fun delete(key: {key})",
                "}",
            ],
        )
    )

    if context.pending:
        message = kt_string(f"The storage of {plural} is not written yet")

        def method(signature: str) -> list[str]:
            return [
                f"    override suspend fun {signature} {{",
                f"        // TODO: store {plural} in your database",
                f"        TODO({message})",
                "    }",
            ]

        files.append(
            file(
                name["pendingRepository"],
                key_import(KtImports(package).add(model, f"{common}.ListQuery", f"{common}.ListResult")),
                [
                    kt_doc(f"Storage of {plural} to write: every method answers 501 until it is implemented."),
                    f"class {name['pendingRepository']} : {name['repository']} {{",
                    method(f"list(query: ListQuery): ListResult<{item_type}>"),
                    "",
                    method(f"get(key: {key}): {item_type}?"),
                    "",
                    method(f"add(item: {item_type}): {item_type}"),
                    "",
                    method(f"update(item: {item_type}): {item_type}"),
                    "",
                    method(f"delete(key: {key})"),
                    "}",
                ],
            )
        )
        return files

    generated = resource["key"]["generated"]
    new_uuid = "UUID.randomUUID()" if key == "JsonUuid" else "UUID.randomUUID().toString()"
    if not context.exposed:
        imports = key_import(
            KtImports(package).add(
                model,
                f"{common}.ListQuery",
                f"{common}.ListResult",
                f"{common}.compareFieldValues",
                f"{common}.sameValue",
                "java.util.concurrent.ConcurrentHashMap",
            )
        )
        if generated == "increment":
            imports.add("java.util.concurrent.atomic.AtomicLong")
        if generated == "uuid":
            imports.add("java.util.UUID")
        if generated == "increment":
            assign = f"        val stored = item.copy({key_property} = lastKey.incrementAndGet())"
        elif generated == "uuid":
            assign = f"        val stored = item.copy({key_property} = {new_uuid})"
        else:
            assign = "        val stored = item.copy()"
        files.append(
            file(
                name["memory"],
                imports,
                [
                    kt_doc(
                        f"Keeps {plural} in memory: they are lost when the application stops. Use it to try the API."
                    ),
                    f"class {name['memory']} : {name['repository']} {{",
                    f"    private val items = ConcurrentHashMap<{key}, {item_type}>()",
                    generated == "increment" and "    private val lastKey = AtomicLong()",
                    "",
                    "    /** The value of a field by its JSON name, for filters and sorting. */",
                    f"    private fun value(item: {item_type}, field: String): Any? = when (field) {{",
                    [
                        f"        {kt_string(field['wire'])} -> item.{property_name(field)}"
                        for field in resource["fields"]
                    ],
                    "        else -> null",
                    "    }",
                    "",
                    f"    override suspend fun list(query: ListQuery): ListResult<{item_type}> {{",
                    "        var found = items.values",
                    "            .filter { item -> query.filters.all { (field, value) -> sameValue(value(item, field), value) } }",
                    f"            .sortedWith {{ a, b -> compareFieldValues(a.{key_property}, b.{key_property}) }}",
                    "        val field = query.sortField",
                    "        if (field != null) {",
                    "            val present = found.filter { value(it, field) != null }",
                    "                .sortedWith { a, b -> compareFieldValues(value(a, field), value(b, field)) }",
                    "            // Items without a value go last, whatever the order",
                    "            found = (if (query.descending) present.reversed() else present) + found.filter { value(it, field) == null }",
                    "        }",
                    "        val window = found.drop(query.offset).let { if (query.limit == null) it else it.take(query.limit) }",
                    "        return ListResult(window.map { it.copy() }, found.size.toLong())",
                    "    }",
                    "",
                    f"    override suspend fun get(key: {key}): {item_type}? = items[key]?.copy()",
                    "",
                    f"    override suspend fun add(item: {item_type}): {item_type} {{",
                    assign,
                    f"        items[stored.{key_property}] = stored",
                    "        return stored.copy()",
                    "    }",
                    "",
                    f"    override suspend fun update(item: {item_type}): {item_type} {{",
                    f"        items[item.{key_property}] = item.copy()",
                    "        return item.copy()",
                    "    }",
                    "",
                    f"    override suspend fun delete(key: {key}) {{",
                    "        items.remove(key)",
                    "    }",
                    "}",
                ],
            )
        )
        return files

    imports = key_import(
        KtImports(package).add(
            model,
            f"{common}.ListQuery",
            f"{common}.ListResult",
            "org.jetbrains.exposed.v1.core.ResultRow",
            "org.jetbrains.exposed.v1.core.SortOrder",
            "org.jetbrains.exposed.v1.core.Table",
            "org.jetbrains.exposed.v1.core.eq",
            "org.jetbrains.exposed.v1.core.statements.UpdateBuilder",
            "org.jetbrains.exposed.v1.jdbc.Database",
            "org.jetbrains.exposed.v1.jdbc.andWhere",
            "org.jetbrains.exposed.v1.jdbc.deleteWhere",
            "org.jetbrains.exposed.v1.jdbc.insert",
            "org.jetbrains.exposed.v1.jdbc.selectAll",
            "org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction",
            "org.jetbrains.exposed.v1.jdbc.update",
        )
    )
    if generated == "uuid":
        imports.add("java.util.UUID")
    columns = [(field, _column_of(context, resource, field, imports)) for field in resource["fields"]]
    table = name["table"]
    key_column = f"{table}.{key_property}"
    filters = []
    for field, spec_column in columns:
        if not _queryable(field):
            continue
        cast = key if field["name"] == resource["key"]["field"] else _cast_of(context, field, imports)
        value = spec_column.match(f"(value as {cast})")
        filters.append(
            f"                {kt_string(field['wire'])} -> select.andWhere {{ {table}.{property_name(field)} eq {value} }}"
        )
    sorts = [
        f"            {kt_string(field['wire'])} -> {table}.{property_name(field)}"
        for field, _ in columns
        if _queryable(field)
    ]
    assigned = new_uuid if generated == "uuid" else None
    if generated == "increment":
        insert = [f"            {table}.insert {{ fill(it, item) }} get {key_column}"]
    else:
        insert = [
            f"            val key = {assigned if assigned else f'item.{key_property}'}",
            f"            {table}.insert {{",
            f"                it[{key_column}] = key",
            "                fill(it, item)",
            "            }",
            "            key",
        ]
    files.append(
        file(
            name["exposedRepository"],
            imports,
            [
                kt_doc(f"The {name['sqlTable']} table."),
                f"object {table} : Table({kt_string(name['sqlTable'])}) {{",
                [f"    val {property_name(field)} = {spec_column.definition}" for field, spec_column in columns],
                "",
                f"    override val primaryKey = PrimaryKey({key_property})",
                "}",
                "",
                kt_doc(f"Keeps {plural} in the database with Exposed."),
                f"class {name['exposedRepository']}(private val database: Database) : {name['repository']} {{",
                f"    override suspend fun list(query: ListQuery): ListResult<{item_type}> = suspendTransaction(database) {{",
                f"        val select = {table}.selectAll()",
                "        for ((field, value) in query.filters) {",
                "            when (field) {",
                filters,
                "            }",
                "        }",
                "        val total = select.count()",
                "        val sorted = when (query.sortField) {",
                sorts,
                "            else -> null",
                "        }",
                "        // Items without a value go last, whatever the order; the key breaks ties",
                "        if (sorted != null) select.orderBy(sorted, if (query.descending) SortOrder.DESC_NULLS_LAST else SortOrder.ASC_NULLS_LAST)",
                f"        select.orderBy({key_column}, SortOrder.ASC)",
                "        if (query.limit != null) select.limit(query.limit).offset(query.offset.toLong())",
                "        ListResult(select.map(::toItem), total)",
                "    }",
                "",
                f"    override suspend fun get(key: {key}): {item_type}? = suspendTransaction(database) {{",
                f"        {table}.selectAll().where {{ {key_column} eq key }}.singleOrNull()?.let(::toItem)",
                "    }",
                "",
                f"    override suspend fun add(item: {item_type}): {item_type} {{",
                "        val key = suspendTransaction(database) {",
                insert,
                "        }",
                "        // Read back, so the answer has what the database keeps",
                "        return get(key)!!",
                "    }",
                "",
                f"    override suspend fun update(item: {item_type}): {item_type} {{",
                f"        suspendTransaction(database) {{ {table}.update({{ {key_column} eq item.{key_property} }}) {{ fill(it, item) }} }}",
                f"        return get(item.{key_property})!!",
                "    }",
                "",
                f"    override suspend fun delete(key: {key}) {{",
                f"        suspendTransaction(database) {{ {table}.deleteWhere {{ {key_column} eq key }} }}",
                "    }",
                "",
                "    /** Every column but the key takes the value of the item. */",
                f"    private fun fill(row: UpdateBuilder<*>, item: {item_type}) {{",
                [
                    f"        row[{table}.{property_name(field)}] = {spec_column.write(f'item.{property_name(field)}')}"
                    for field, spec_column in columns
                    if field["name"] != resource["key"]["field"]
                ],
                "    }",
                "",
                f"    private fun toItem(row: ResultRow) = {item_type}(",
                [
                    f"        {property_name(field)} = {spec_column.read(f'row[{table}.{property_name(field)}]')},"
                    for field, spec_column in columns
                ],
                "    )",
                "}",
            ],
        )
    )
    return files
