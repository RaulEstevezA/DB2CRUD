"""The entity of each table (a class with a property per column, every one of them null until it is set) and its Exposed
table object, which describes the table as the database has it: exact table and column names, types with their lengths
and precision, the key, unique values, indexes, foreign keys with their actions, defaults and the values the database
fills. Exposed reads and writes rows through the table object; the repositories turn rows into entities and back. CHECK
constraints are named in the table's comment: the services check them. Mirrors
web/src/core/generators/kotlin/exposed/entities.ts."""

from ....js import js_string
from ....schema.ddl import type_sql
from ..context import column_of, common_package, find_info, kt_file, optional_type, package_of, path_of, qualified
from ..kotlin import KtImports, kt_string
from ..repositories import kt_literal

EXPOSED = "org.jetbrains.exposed.v1.core"
JAVA_TIME = "org.jetbrains.exposed.v1.javatime"


def entity_file(context: dict, info: dict) -> dict:
    pkg = package_of(context, info, "entity")
    imports = KtImports(pkg)
    for column in info["columns"]:
        if column["ktImport"]:
            imports.add(column["ktImport"])
    comment = info["table"].get("comment")
    return kt_file(
        path_of(pkg, info["entity"]),
        pkg,
        imports.write(),
        [
            f'/** A row of the "{info["name"]}" table{f": {comment}" if comment else ""}. Its mapping is {info["tableObject"]}; a property stays null until it is set or read. */',
            f"class {info['entity']}(",
            *(f"    var {column['prop']}: {optional_type(column)} = null," for column in info["columns"]),
            ")",
        ],
    )


def native_enum(context: dict, column: dict) -> dict | None:
    """The enum of the database a column holds, when the database keeps it as a type of its own."""
    column_type = column["type"]
    if column_type["kind"] != "enum" or context["settings"]["database"] == "sqlite":
        return None
    item = next(
        (candidate for candidate in context["schema"]["enums"] if candidate["name"] == column_type["name"]), None
    )
    return item if item and item.get("storage") == "native" else None


def uses_enum_columns(context: dict) -> bool:
    """Whether a table object uses the column type of the enums of the database."""
    return any(
        info["writesEntity"] and any(native_enum(context, column["column"]) for column in info["columns"])
        for info in context["tables"]
    )


def _is_mysql(context: dict) -> bool:
    return context["settings"]["database"] in ("mysql", "mariadb")


def _uses_column(context: dict, test) -> bool:
    return any(
        info["writesEntity"] and any(test(column["column"]["type"]) for column in info["columns"])
        for info in context["tables"]
    )


def uses_native_text(context: dict) -> bool:
    """Whether a table object uses the column type of the values PostgreSQL keeps in a type Exposed does not have."""
    return context["settings"]["database"] == "postgresql" and _uses_column(
        context, lambda column_type: column_type["kind"] in ("json", "array", "unknown")
    )


def _uses_long_binary(context: dict) -> bool:
    """Whether a table object uses the column type of MySQL's bytes without a length."""
    return _is_mysql(context) and _uses_column(
        context, lambda column_type: column_type["kind"] == "binary" and column_type.get("length") is None
    )


def _quote_sql(text: str) -> str:
    escaped = text.replace("'", "''")
    return f"'{escaped}'"


def _column_call(context: dict, column: dict, imports: KtImports) -> str:
    """The Exposed call that registers a column, without its modifiers."""
    db = column["column"]
    name = kt_string(db["name"])
    column_type = db["type"]
    kind = column_type["kind"]
    database = context["settings"]["database"]
    enum_type = native_enum(context, db)
    if enum_type:
        imports.add(qualified(common_package(context), "databaseEnum"))
        sql = (
            f'"{enum_type["name"]}"'
            if database == "postgresql"
            else f"ENUM({', '.join(_quote_sql(value) for value in enum_type['values'])})"
        )
        type_name = f", {kt_string(enum_type['name'])}" if database == "postgresql" else ""
        return f"databaseEnum({name}, {kt_string(sql)}{type_name})"
    if kind == "integer":
        return f"{ {16: 'short', 64: 'long'}.get(column_type['bits'], 'integer') }({name})"
    if kind == "decimal":
        precision = column_type.get("precision")
        scale = column_type.get("scale")
        return f"decimal({name}, {js_string(10 if precision is None else precision)}, {js_string(0 if scale is None else scale)})"
    if kind == "float":
        return f"{'float' if column_type['bits'] == 32 else 'double'}({name})"
    if kind == "text":
        if column_type.get("length") is None:
            return f"text({name})"
        return f"{'char' if column_type.get('fixed') else 'varchar'}({name}, {js_string(column_type['length'])})"
    if kind == "boolean":
        return f"bool({name})"
    if kind == "date":
        imports.add(f"{JAVA_TIME}.date")
        return f"date({name})"
    if kind == "time":
        imports.add(f"{JAVA_TIME}.time")
        return f"time({name})"
    if kind == "datetime":
        call = (
            "datetime"
            if not column_type.get("timezone")
            else "timestamp"
            if database == "mariadb"
            else "timestampWithTimeZone"
        )
        imports.add(f"{JAVA_TIME}.{call}")
        return f"{call}({name})"
    if kind == "uuid":
        imports.add(f"{EXPOSED}.java.javaUUID")
        return f"javaUUID({name})"
    if kind == "binary":
        if column_type.get("length") is None and _is_mysql(context):
            imports.add(qualified(common_package(context), "longBinary"))
            return f"longBinary({name})"
        length = column_type.get("length")
        return f"binary({name}, {js_string(length)})" if length is not None else f"binary({name})"
    if kind == "enum":
        # An enum kept with a CHECK: its text, as long as its longest value
        values = next(
            (item["values"] for item in context["schema"]["enums"] if item["name"] == column_type["name"]),
            [],
        )
        length = max([1, *(len(value) for value in values)])
        return f"varchar({name}, {length})"
    if database == "postgresql":
        imports.add(qualified(common_package(context), "nativeText"))
        return f"nativeText({name}, {kt_string(type_sql(context['schema'], 'postgresql', column_type))})"
    return f"text({name})"


NOW = {
    "LocalDate": "CurrentDate",
    "LocalDateTime": "CurrentDateTime",
    "OffsetDateTime": "CurrentTimestampWithTimeZone",
    "Instant": "CurrentTimestamp",
}


def _modifiers(context: dict, info: dict, column: dict, imports: KtImports, todo: list[str]) -> str:
    """The modifiers of a column: what the database fills, its default, null."""
    db = column["column"]
    calls: list[str] = []
    primary_key = info["table"]["primaryKey"]
    single = primary_key is not None and len(primary_key) == 1 and primary_key[0] == db["name"]
    generated = db.get("generated")
    default = db.get("default")
    if generated == "identity":
        if single:
            calls.append(".autoIncrement()")
        else:
            calls.append(".databaseGenerated()")
            todo.append("// TODO: the database numbers this column; Exposed numbers only a key of one column")
    elif generated in ("now", "onUpdateNow"):
        now = NOW.get(column["kt"])
        if now:
            imports.add(f"{JAVA_TIME}.{now}")
            calls.append(f".defaultExpression({now})")
        else:
            calls.append(".databaseGenerated()")
        if generated == "onUpdateNow":
            todo.append("// TODO: the database sets it again on every change; Exposed only reads it")
    elif isinstance(generated, dict):
        definition = f"GENERATED ALWAYS AS ({generated['computed']}) STORED"
        calls += [".databaseGenerated()", f".withDefinition({kt_string(definition)})"]
    elif default is not None and default["kind"] == "literal" and default.get("value") is not None:
        if column["ktImport"]:
            imports.add(column["ktImport"])
        calls.append(f".default({kt_literal(column, default['value'])})")
    elif default is not None and default["kind"] == "expression":
        definition = f"DEFAULT {default['sql']}"
        calls += [".databaseGenerated()", f".withDefinition({kt_string(definition)})"]
        todo.append(
            f"// TODO: the database fills it with {default['sql']} on insert; Exposed never sends a value for it"
        )
    if db.get("comment") and context["settings"]["database"] != "sqlite":
        calls.append(f".comment({kt_string(db['comment'])})")
    # Last: the defaults above are of the column's own type
    if db["nullable"]:
        calls.append(".nullable()")
    return "".join(calls)


ACTIONS = {
    "cascade": "CASCADE",
    "set null": "SET_NULL",
    "set default": "SET_DEFAULT",
    "restrict": "RESTRICT",
    "no action": "NO_ACTION",
}


def table_object_file(context: dict, info: dict) -> dict:
    pkg = package_of(context, info, "entity")
    imports = KtImports(pkg).add(f"{EXPOSED}.Table")
    table = info["table"]
    column_lines: list[str] = []
    for column in info["columns"]:
        todo: list[str] = []
        call = _column_call(context, column, imports)
        mods = _modifiers(context, info, column, imports, todo)
        column_lines += [*todo, f"val {column['prop']} = {call}{mods}"]

    def members(names: list[str]) -> str:
        return ", ".join(column_of(info, name)["prop"] for name in names)

    constraints: list[str] = []
    for unique in table["uniques"]:
        constraints.append(
            f"uniqueIndex({kt_string(unique['name']) if unique.get('name') else 'null'}, {members(unique['columns'])})"
        )
    for index in table["indexes"]:
        constraints.append(
            f"index({kt_string(index['name']) if index.get('name') else 'null'}, false, {members(index['columns'])})"
        )
    for key in table["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        if not parent:
            constraints.append(
                f"// TODO: {', '.join(key['columns'])} points to {key['references']['table']}, a table this project does not have"
            )
            continue
        if parent is not info and parent["writesEntity"] != info["writesEntity"]:
            continue
        if parent is not info and package_of(context, parent, "entity") != pkg:
            imports.add(qualified(package_of(context, parent, "entity"), parent["tableObject"]))
        pairs = []
        for position, name in enumerate(key["columns"]):
            target = column_of(parent, key["references"]["columns"][position])["prop"]
            pairs.append(
                f"{column_of(info, name)['prop']} to {target if parent is info else parent['tableObject'] + '.' + target}"
            )
        args = [", ".join(pairs)]
        if key.get("onDelete"):
            imports.add(f"{EXPOSED}.ReferenceOption")
            args.append(f"onDelete = ReferenceOption.{ACTIONS[key['onDelete']]}")
        if key.get("name"):
            args.append(f"name = {kt_string(key['name'])}")
        constraints.append(f"foreignKey({', '.join(args)})")
    checks = [f" * CHECK ({check['sql']}): the services check what they understand of it." for check in table["checks"]]
    table_name = f"{table['schema']}.{table['name']}" if table.get("schema") else table["name"]
    primary_key = table["primaryKey"]
    return kt_file(
        path_of(pkg, info["tableObject"]),
        pkg,
        imports.write(),
        [
            "/**",
            f' * The "{table["name"]}" table, as the database has it. Exposed never creates or changes it: the database already exists.',
            *([" *", *checks] if checks else []),
            *([] if primary_key else [" *", " * It has no primary key: its rows are told apart by all their columns."]),
            " */",
            f"object {info['tableObject']} : Table({kt_string(table_name)}) {{",
            *(f"    {line}" for line in column_lines),
            *(["", f"    override val primaryKey = PrimaryKey({members(primary_key)})"] if primary_key else []),
            *(["", "    init {", *(f"        {line}" for line in constraints), "    }"] if constraints else []),
            "}",
        ],
    )


def enum_column_file(context: dict) -> dict | None:
    """DatabaseEnum.kt: the column type of an enum the database keeps as a type of its own; the entities keep its text."""
    if not uses_enum_columns(context):
        return None
    pkg = common_package(context)
    postgres = context["settings"]["database"] == "postgresql"
    imports = KtImports(pkg).add(f"{EXPOSED}.Column", f"{EXPOSED}.Table", f"{EXPOSED}.VarCharColumnType")
    if postgres:
        imports.add("org.postgresql.util.PGobject")
    return kt_file(
        path_of(pkg, "DatabaseEnum"),
        pkg,
        imports.write(),
        [
            "/** A value of an enum of the database, kept as its text. */",
            f"class DatabaseEnumColumnType(private val sql: String{', private val typeName: String' if postgres else ''}) : VarCharColumnType() {{",
            "    override fun sqlType(): String = sql",
            *(
                [
                    "",
                    "    // PostgreSQL takes a value of the enum, not a text",
                    "    override fun notNullValueToDB(value: String): Any = PGobject().also {",
                    "        it.type = typeName",
                    "        it.value = value",
                    "    }",
                    "",
                    "    override fun valueFromDB(value: Any): String = if (value is PGobject) value.value!! else value.toString()",
                ]
                if postgres
                else []
            ),
            "}",
            "",
            "/** A column of an enum of the database. */",
            f"fun Table.databaseEnum(name: String, sql: String{', typeName: String' if postgres else ''}): Column<String> =",
            f"    registerColumn(name, DatabaseEnumColumnType(sql{', typeName' if postgres else ''}))",
        ],
    )


def native_text_file(context: dict) -> dict | None:
    """NativeText.kt: the column type of a value kept as its text that PostgreSQL has in a type of its own (json, arrays…)."""
    if not uses_native_text(context):
        return None
    pkg = common_package(context)
    imports = KtImports(pkg).add(
        f"{EXPOSED}.Column", f"{EXPOSED}.Table", f"{EXPOSED}.TextColumnType", "org.postgresql.util.PGobject"
    )
    return kt_file(
        path_of(pkg, "NativeText"),
        pkg,
        imports.write(),
        [
            "/** A value kept as its text, in a column of another type of PostgreSQL. */",
            "class NativeTextColumnType(private val sql: String) : TextColumnType() {",
            "    override fun sqlType(): String = sql",
            "",
            "    // Of no type yet: PostgreSQL gives it the type of the column",
            "    override fun notNullValueToDB(value: String): Any = PGobject().also {",
            '        it.type = "unknown"',
            "        it.value = value",
            "    }",
            "",
            "    override fun valueFromDB(value: Any): String = if (value is PGobject) value.value!! else value.toString()",
            "}",
            "",
            "/** A column of a type Exposed does not have, read and written as text. */",
            "fun Table.nativeText(name: String, sql: String): Column<String> = registerColumn(name, NativeTextColumnType(sql))",
        ],
    )


def long_binary_file(context: dict) -> dict | None:
    """LongBinary.kt: the column type of MySQL's bytes without a length, which Exposed has only as streams."""
    if not _uses_long_binary(context):
        return None
    pkg = common_package(context)
    imports = KtImports(pkg).add(f"{EXPOSED}.BasicBinaryColumnType", f"{EXPOSED}.Column", f"{EXPOSED}.Table")
    return kt_file(
        path_of(pkg, "LongBinary"),
        pkg,
        imports.write(),
        [
            "/** Bytes without a length. */",
            "class LongBinaryColumnType : BasicBinaryColumnType() {",
            '    override fun sqlType(): String = "LONGBLOB"',
            "}",
            "",
            "/** A column of bytes without a length. */",
            "fun Table.longBinary(name: String): Column<ByteArray> = registerColumn(name, LongBinaryColumnType())",
        ],
    )
