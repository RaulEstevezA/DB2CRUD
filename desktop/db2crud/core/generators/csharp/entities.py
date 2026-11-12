"""The entity of each table (a plain class with a property per column) and AppDbContext, whose Fluent API maps every
table as the database has it: exact table and column names, lengths, precision, keys (none for a table without one),
unique indexes, indexes, CHECK constraints, foreign keys with their actions, enums of PostgreSQL, and the values the
database fills, which EF Core reads back after an insert. Mirrors web/src/core/generators/csharp/entities.ts."""

import re

from ...js import number_text
from ..types import lines
from .context import column_of, find_info, is_in, namespace_of, path_of, writes_entities
from .csharp import CsUsings, cs_string, pascal_name


def entity_file(context: dict, info: dict) -> dict:
    ns = namespace_of(context, info, "entity")
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    properties: list = []
    for index, column in enumerate(info["columns"]):
        kind = column["column"]["type"]["kind"]
        sql = column["column"]["type"]["sql"]
        initializer = " = null!;" if not column["optional"] and not column["valueType"] else ""
        properties += [
            "" if index > 0 else None,
            bool(column["column"].get("comment")) and f"    /// <summary>{column['column'].get('comment')}</summary>",
            kind == "unknown" and f'    // TODO: "{sql}" has no EF Core type here; it is mapped as text',
            kind == "array" and f'    // TODO: "{sql}" is kept as its JSON text',
            f"    public {column['propType']} {column['prop']} {{ get; set; }}{initializer}",
        ]
    content = lines(
        f"namespace {ns};",
        "",
        f'/// <summary>A row of the "{info["name"]}" table{comment}. Its mapping is in AppDbContext.</summary>',
        f"public class {info['entity']}",
        "{",
        *properties,
        "}",
        "",
    )
    return {"path": path_of(ns, info["entity"]), "content": content}


def _native_enum(context: dict, column: dict) -> dict | None:
    column_type = column["column"]["type"]
    if column_type["kind"] != "enum" or context["settings"]["database"] == "sqlite":
        return None
    item = next((item for item in context["schema"]["enums"] if item["name"] == column_type["name"]), None)
    return item if item is not None and item.get("storage") == "native" else None


def _quote_sql(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _default_literal(column: dict, value) -> str:
    """A literal default in the property's C# type."""
    if isinstance(value, bool):
        return "true" if value else "false"
    text = value if isinstance(value, str) else number_text(value)
    cs = column["cs"]
    if cs == "long":
        return f"{text}L"
    if cs == "short":
        return f"(short){text}"
    if cs == "decimal":
        return f"{text}m"
    if cs == "float":
        return f"{text}f"
    if cs == "double":
        return text if "." in text else f"{text}.0"
    if cs in ("int", "bool"):
        return text
    return cs_string(text)


def _mysql(context: dict) -> bool:
    return context["settings"]["database"] in ("mysql", "mariadb")


def _property_lines(context: dict, info: dict, column: dict) -> list[str]:
    """The calls that map one property."""
    db = column["column"]
    column_type = db["type"]
    kind = column_type["kind"]
    calls = [f"entity.Property(e => e.{column['prop']})", f".HasColumnName({cs_string(db['name'])})"]
    if kind == "text" and column_type.get("length") is not None:
        calls.append(f".HasMaxLength({column_type['length']})")
    if kind == "text" and column_type.get("fixed"):
        calls.append(".IsFixedLength()")
    if kind == "binary" and column_type.get("length") is not None:
        calls.append(f".HasMaxLength({column_type['length']})")
    if kind == "decimal" and column_type.get("precision") is not None:
        scale = column_type.get("scale")
        calls.append(f".HasPrecision({column_type['precision']}, {scale if scale is not None else 0})")
    database = context["settings"]["database"]
    if kind in ("json", "array") and database != "sqlite":
        json_type = (
            "jsonb"
            if database == "postgresql" and not re.fullmatch(r"json", column_type["sql"], re.IGNORECASE)
            else "json"
        )
        calls.append(f".HasColumnType({cs_string(json_type)})")
    # Npgsql maps a DateTime to a timestamp with a time zone unless told otherwise
    if kind == "datetime" and not column_type.get("timezone") and database == "postgresql":
        calls.append('.HasColumnType("timestamp without time zone")')
    enum_type = _native_enum(context, column)
    if enum_type:
        if database == "postgresql":
            definition = enum_type["name"]
        else:
            definition = f"enum({', '.join(_quote_sql(value) for value in enum_type['values'])})"
        calls.append(f".HasColumnType({cs_string(definition)})")
    # Npgsql sends a value of an enum of PostgreSQL as that type only when it is a C# enum: the property keeps the text
    if enum_type and database == "postgresql":
        name = enum_type_name(context, enum_type)
        calls.append(f".HasConversion(value => PgEnums.To{name}(value), value => PgEnums.From{name}(value))")
    if column["optional"] and not db["nullable"]:
        calls.append(".IsRequired()")
    generated = db.get("generated")
    if generated == "identity" and not is_in(column, info["key"]):
        calls.append(".ValueGeneratedOnAdd()")
    default = db.get("default")
    if generated in ("now", "onUpdateNow"):
        # MySQL's datetime(6) takes the current time with the same precision
        now = "CURRENT_TIMESTAMP(6)" if _mysql(context) else "CURRENT_TIMESTAMP"
        calls.append(f".HasDefaultValueSql({cs_string(now)})")
    elif isinstance(generated, dict):
        calls.append(f".HasComputedColumnSql({cs_string(generated['computed'])}, stored: true)")
    elif default and default["kind"] == "literal" and default["value"] is not None:
        calls.append(f".HasDefaultValue({_default_literal(column, default['value'])})")
    elif default and default["kind"] == "expression":
        calls.append(f".HasDefaultValueSql({cs_string(default['sql'])})")
    if db.get("comment"):
        calls.append(f".HasComment({cs_string(db['comment'])})")
    return [f"{calls[0]}{''.join(calls[1:])};"]


DELETE = {"cascade": "Cascade", "set null": "SetNull", "restrict": "Restrict", "no action": "NoAction"}


def _members(info: dict, names: list[str]) -> str:
    if len(names) == 1:
        return f"e => e.{column_of(info, names[0])['prop']}"
    return f"e => new {{ {', '.join('e.' + column_of(info, name)['prop'] for name in names)} }}"


def _entity_block(context: dict, info: dict) -> list:
    table = info["table"]
    checks = []
    for position, check in enumerate(table["checks"]):
        name = check.get("name") or "ck_" + table["name"] + "_" + str(position + 1)
        checks.append(f"t.HasCheckConstraint({cs_string(name)}, {cs_string(check['sql'])})")
    schema = f", {cs_string(table['schema'])}" if table.get("schema") else ""
    if checks:
        inner = "\n".join(f"                {check};" for check in checks)
        tail = f", t =>\n            {{\n{inner}\n            }}"
    else:
        tail = ""
    result: list = [
        f"        model.Entity<{info['entity']}>(entity =>",
        "        {",
        f"            entity.ToTable({cs_string(table['name'])}{schema}{tail});",
    ]
    primary_key = table.get("primaryKey")
    if primary_key:
        result.append(f"            entity.HasKey({_members(info, primary_key)});")
    else:
        result += [
            "            // The table has no primary key: EF Core reads it, and never writes it",
            "            entity.HasNoKey();",
        ]
    for column in info["columns"]:
        result += [f"            {line}" for line in _property_lines(context, info, column)]
    for unique in table["uniques"]:
        name = f".HasDatabaseName({cs_string(unique['name'])})" if unique.get("name") else ""
        result.append(f"            entity.HasIndex({_members(info, unique['columns'])}).IsUnique(){name};")
    for index in table["indexes"]:
        name = f".HasDatabaseName({cs_string(index['name'])})" if index.get("name") else ""
        result.append(f"            entity.HasIndex({_members(info, index['columns'])}){name};")
    if primary_key:
        for key in table["foreignKeys"]:
            parent = find_info(context, key["references"]["table"])
            if not parent or not parent["table"].get("primaryKey"):
                continue
            to_key = ",".join(parent["table"]["primaryKey"]) == ",".join(key["references"]["columns"])
            action = DELETE.get(key.get("onDelete") or "no action")
            chain = [
                f"            entity.HasOne<{parent['entity']}>()",
                "                .WithMany()",
                f"                .HasForeignKey({_members(info, key['columns'])})",
            ]
            if not to_key:
                chain.append(f"                .HasPrincipalKey({_members(parent, key['references']['columns'])})")
            if key.get("onDelete") == "set default":
                chain.append(
                    "                // TODO: the database sets the default on delete; EF Core has no such action"
                )
            chain.append(f"                .OnDelete(DeleteBehavior.{action or 'NoAction'})")
            if key.get("name"):
                chain.append(f"                .HasConstraintName({cs_string(key['name'])})")
            chain[-1] = f"{chain[-1]};"
            result += chain
    result.append("        });")
    return result


def pg_enums(context: dict) -> list[dict]:
    """The enums of PostgreSQL the tables use."""
    if context["settings"]["database"] != "postgresql":
        return []
    return [
        item
        for item in context["schema"]["enums"]
        if any(_native_enum(context, column) is item for info in context["tables"] for column in info["columns"])
    ]


def enum_type_name(context: dict, item: dict) -> str:
    """The C# enum of an enum of PostgreSQL: TicketState, or TicketStateEnum when a table has that name."""
    name = pascal_name(item["name"])
    return f"{name}Enum" if any(info["entity"] == name for info in context["tables"]) else name


def _enum_members(item: dict) -> list[str]:
    """The members of a C# enum, one per value, each a valid and distinct name."""
    used: set[str] = set()
    result = []
    for value in item["values"]:
        pascal = pascal_name(value)
        base = pascal if re.match(r"[A-Za-z_]", pascal) else f"Value{pascal}"
        name = base
        index = 2
        while name in used:
            name = f"{base}{index}"
            index += 1
        used.add(name)
        result.append(name)
    return result


def pg_enums_file(context: dict) -> dict | None:
    """PgEnums.cs: a C# enum per enum of PostgreSQL and the conversions from the text the entities keep."""
    enums = pg_enums(context)
    if not enums or not writes_entities(context):
        return None
    types: list = []
    conversions: list = []
    for item in enums:
        name = enum_type_name(context, item)
        members = _enum_members(item)
        types += [
            "",
            f'/// <summary>The "{item["name"]}" enum of the database.</summary>',
            f"public enum {name}",
            "{",
            *(f"    [PgName({cs_string(value)})] {members[index]}," for index, value in enumerate(item["values"])),
            "}",
        ]
        error = cs_string(f"not a value of {item['name']}")
        conversions += [
            "",
            f"    public static {name} To{name}(string value) => value switch",
            "    {",
            *(f"        {cs_string(value)} => {name}.{members[index]}," for index, value in enumerate(item["values"])),
            f"        _ => throw new ArgumentOutOfRangeException(nameof(value), value, {error}),",
            "    };",
            "",
            f"    public static string From{name}({name} value) => value switch",
            "    {",
            *(f"        {name}.{members[index]} => {cs_string(value)}," for index, value in enumerate(item["values"])),
            f"        _ => throw new ArgumentOutOfRangeException(nameof(value), value, {error}),",
            "    };",
        ]
    return {
        "path": path_of(context["base"], "PgEnums"),
        "content": lines(
            "using NpgsqlTypes;",
            "",
            f"namespace {context['base']};",
            *types,
            "",
            "/// <summary>The values of the enums of the database as the entities keep them (text), and back.</summary>",
            "public static class PgEnums",
            "{",
            *conversions[1:],
            "}",
            "",
        ),
    }


def db_context_file(context: dict) -> dict:
    """AppDbContext: a DbSet per table and the mapping of every table."""
    ns = context["base"]
    usings = CsUsings(ns).add("Microsoft.EntityFrameworkCore")
    for info in context["tables"]:
        usings.add(namespace_of(context, info, "entity"))
    enums = pg_enums(context)
    blocks: list = []
    if writes_entities(context):
        for index, info in enumerate(context["tables"]):
            blocks += ["" if index > 0 else None, *_entity_block(context, info)]
    content = lines(
        usings.write(),
        "",
        f"namespace {ns};",
        "",
        "/// <summary>The tables of the database, mapped as the database has them. It never migrates: the database already exists.</summary>",
        "public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)",
        "{",
        *(
            f"    public DbSet<{info['entity']}> {info['attr']} => Set<{info['entity']}>();"
            for info in context["tables"]
        ),
        "",
        "    protected override void OnModelCreating(ModelBuilder model)",
        "    {",
        *(
            f"        model.HasPostgresEnum({cs_string(item['name'])}, new[] {{ {', '.join(cs_string(value) for value in item['values'])} }});"
            for item in enums
        ),
        bool(enums) and "",
        *blocks,
        "    }",
        "}",
        "",
    )
    return {"path": path_of(ns, "AppDbContext"), "content": content}
