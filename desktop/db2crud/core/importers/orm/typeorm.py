"""Reads TypeORM entities into the physical schema: classes marked `@Entity` (and the columns of the classes they
extend), their column decorators (`@Column`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`, the date and version
columns), the constraints of the class (`@Unique`, `@Index`, `@Check`), relations that own a foreign key
(`@ManyToOne`, `@OneToOne` with `@JoinColumn`), many-to-many tables (`@JoinTable`) and TypeScript enums. Names
nobody gave follow TypeORM's default naming strategy. The engine is the one the `DataSource` names, when it names
only one. Mirrors web/src/core/importers/orm/typeorm.ts.

A decorator is {name, args}; a member {name, type, decorators, line}; a class {name, base, decorators, members,
line}; an enum the value of each of its members, by name."""

import math
import re

from ...js import is_number, json_string, number_text, to_number
from ...schema.checks import check_of
from ..code.lexer import Cursor, LexError, Token, tokenize
from ..code.typescript import TYPESCRIPT_LEXER
from .expressions import boolean_of, literal_of, name_of, number_of, read_arguments, read_expression, string_of, text_of
from .types import OrmReader

_NAMED = "="

# Reading the declarations


def _read_decorator(cursor: Cursor, source: str) -> dict:
    parts = [cursor.next().value]
    while cursor.is_(".") and cursor.is_ident(1):
        cursor.next()
        parts.append(cursor.next().value)
    if not cursor.is_("("):
        return {"name": parts[-1], "args": []}
    cursor.next()
    return {"name": parts[-1], "args": read_arguments(cursor, source, _NAMED, ")")[0]}


def _is_open(token: Token) -> bool:
    return token.kind == "punct" and token.value in ("(", "[", "{")


def _skip_statement(cursor: Cursor) -> None:
    """Moves past the rest of a statement: up to a `;`, a new line or the `}` that closes its block."""
    start = cursor.index
    while not cursor.done:
        token = cursor.peek()
        if cursor.index > start and token.line_start:
            return
        if token.kind == "punct" and token.value == "}":
            return
        if token.kind == "punct" and token.value == ";":
            cursor.next()
            return
        if _is_open(token):
            cursor.skip_group()
        else:
            cursor.next()


_MODIFIERS = {
    "public",
    "private",
    "protected",
    "readonly",
    "declare",
    "static",
    "abstract",
    "override",
    "accessor",
    "get",
    "set",
    "async",
}


def _is_string(cursor: Cursor, offset: int = 0) -> bool:
    token = cursor.peek(offset)
    return token is not None and token.kind == "string"


def _read_class_body(cursor: Cursor, source: str) -> list[dict]:
    members: list[dict] = []
    decorators: list[dict] = []
    cursor.next()
    while not cursor.done and not cursor.is_("}"):
        if cursor.is_("@") and cursor.is_ident(1):
            cursor.next()
            decorators.append(_read_decorator(cursor, source))
            continue
        if cursor.is_(";") or cursor.is_(","):
            cursor.next()
            continue
        while cursor.value() in _MODIFIERS and cursor.is_ident() and (cursor.is_ident(1) or _is_string(cursor, 1)):
            cursor.next()
        if not cursor.is_ident() and not _is_string(cursor):
            if cursor.is_("(") or cursor.is_("[") or cursor.is_("{"):
                cursor.skip_group()
            else:
                cursor.next()
            decorators = []
            continue
        name = cursor.next()
        cursor.eat("!")
        cursor.eat("?")
        # `name?: Type` reads `?:` as one token
        typed = cursor.eat(":") or cursor.eat("?:")
        if not typed and (cursor.is_("(") or cursor.is_("<")):
            # A method: its parameters, its return type and its body
            while not cursor.done and not cursor.is_("("):
                cursor.next()
            cursor.skip_group()
            while not cursor.done and not cursor.is_("{") and not cursor.is_(";") and not cursor.is_("}"):
                cursor.next()
            if cursor.is_("{"):
                cursor.skip_group()
            decorators = []
            continue
        member_type = ""
        if typed:
            start = cursor.index
            while not cursor.done:
                token = cursor.peek()
                if cursor.index > start and token.line_start:
                    break
                if token.kind == "punct" and token.value in (";", "=", "}"):
                    break
                if _is_open(token):
                    cursor.skip_group()
                else:
                    cursor.next()
            member_type = cursor.text_between(source, start, cursor.index)
        if cursor.eat("="):
            _skip_statement(cursor)
        members.append({"name": name.value, "type": member_type, "decorators": decorators, "line": name.line})
        decorators = []
    cursor.eat("}")
    return members


def _read_enum(cursor: Cursor, source: str) -> dict:
    """The value of each member of a TypeScript enum: a text, or a number counted on from the last one."""
    members: dict = {}
    following = 0
    cursor.next()
    while not cursor.done and not cursor.is_("}"):
        if not cursor.is_ident() and not _is_string(cursor):
            cursor.next()
            continue
        name = cursor.next().value
        if cursor.eat("="):
            value = literal_of(read_expression(cursor, source, _NAMED))
            if is_number(value):
                following = value
            members[name] = value if isinstance(value, str) else following
        else:
            members[name] = following
        following += 1
        cursor.eat(",")
    cursor.eat("}")
    return members


def _read_files(files: list[dict]) -> tuple[dict, dict, list]:
    classes: dict[str, dict] = {}
    enums: dict[str, dict] = {}
    order: list[dict] = []
    for file in files:
        try:
            tokens = tokenize(file["text"], TYPESCRIPT_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)
        pending: list[dict] = []
        while not cursor.done:
            if cursor.is_("@") and cursor.is_ident(1):
                cursor.next()
                pending.append(_read_decorator(cursor, file["text"]))
            elif cursor.is_("enum") and cursor.is_ident(1) and cursor.is_("{", 2):
                cursor.next()
                name = cursor.next().value
                enums[name] = _read_enum(cursor, file["text"])
                pending = []
            elif cursor.is_("class") and cursor.is_ident(1):
                line = cursor.next().line
                definition = {
                    "name": cursor.next().value,
                    "base": None,
                    "decorators": pending,
                    "members": [],
                    "line": line,
                }
                while not cursor.done and not cursor.is_("{"):
                    if cursor.is_("extends") and cursor.is_ident(1):
                        cursor.next()
                        definition["base"] = cursor.next().value
                    else:
                        cursor.next()
                definition["members"] = _read_class_body(cursor, file["text"])
                classes[definition["name"]] = definition
                order.append(definition)
                pending = []
            elif cursor.value() in ("export", "default", "abstract", "declare", "const") and cursor.is_ident():
                cursor.next()
            else:
                pending = []
                if cursor.is_("(") or cursor.is_("[") or cursor.is_("{"):
                    cursor.skip_group()
                else:
                    cursor.next()
    return classes, enums, order


# TypeORM's default naming strategy

_SNAKE = re.compile(r"(?:([a-z])([A-Z]))|(?:((?!^)[A-Z])([a-z]))")
_CAMEL = re.compile(r"^([A-Z])|[\s\-_](\w)", re.ASCII)


def _snake_case(text: str) -> str:
    return _SNAKE.sub(
        lambda match: f"{match.group(1) or ''}_{match.group(3) or ''}{match.group(2) or ''}{match.group(4) or ''}", text
    ).lower()


def _camel_case(text: str) -> str:
    return _CAMEL.sub(lambda match: match.group(2).upper() if match.group(2) else match.group(1).lower(), text)


# Reading the arguments


def _decorator_of(decorators: list[dict], *names: str) -> dict | None:
    return next((item for item in decorators if item["name"] in names), None)


def _options_of(args: list) -> dict:
    """The options of a decorator: the entries of its first object argument."""
    options: dict = {}
    found = next((arg for arg in args if arg["kind"] == "dict"), None)
    if found is not None:
        for entry in found["entries"]:
            key = name_of(entry["key"])
            key = key if key is not None else string_of(entry["key"])
            if key:
                options[key] = entry["value"]
    return options


_CLASS_NAME = re.compile(r"=>\s*\(?\s*([A-Za-z_$][\w$]*)", re.ASCII)
_INVERSE = re.compile(r"=>\s*\(?\s*[\w$]+\s*\.\s*([\w$]+)\s*\)?\s*$", re.ASCII)
_PROPERTY = re.compile(r"\.\s*([\w$]+)", re.ASCII)


def _class_name_of(expr: dict | None) -> str | None:
    """`() => Order`, `(type) => Order`, `'Order'`: the class a relation points to."""
    if expr is None:
        return None
    if expr["kind"] == "string":
        return expr["value"]
    if expr["kind"] == "name":
        return expr["path"][-1]
    if expr["kind"] == "other":
        match = _CLASS_NAME.search(expr["text"])
        return match.group(1) if match else None
    return None


def _inverse_of(expr: dict | None) -> str | None:
    """`(other) => other.lines` or `'lines'`: the property on the other side of a relation."""
    if expr is None:
        return None
    if expr["kind"] == "string":
        return expr["value"]
    if expr["kind"] == "other":
        match = _INVERSE.search(expr["text"])
        return match.group(1) if match else None
    return None


def _properties_of(expr: dict | None) -> list[str]:
    """The properties a list names: `['customerId', 'createdAt']` or `(row) => [row.customerId]`."""
    if expr is None:
        return []
    if expr["kind"] == "list":
        return [value for value in (string_of(item) for item in expr["items"]) if value is not None]
    if expr["kind"] == "other":
        return _PROPERTY.findall(re.sub(r"^[^=]*=>", "", expr["text"], count=1))
    return []


# Types

_DRIVERS = {
    "postgres": "postgresql",
    "aurora-postgres": "postgresql",
    "cockroachdb": "postgresql",
    "mysql": "mysql",
    "aurora-mysql": "mysql",
    "mariadb": "mariadb",
    "sqlite": "sqlite",
    "better-sqlite3": "sqlite",
    "sqljs": "sqlite",
    "capacitor": "sqlite",
    "cordova": "sqlite",
    "expo": "sqlite",
    "nativescript": "sqlite",
    "react-native": "sqlite",
    "mssql": "sqlserver",
    "oracle": "oracle",
}

_INTEGERS = {
    "smallint": 16,
    "int2": 16,
    "tinyint": 16,
    "mediumint": 32,
    "int": 32,
    "integer": 32,
    "int4": 32,
    "bigint": 64,
    "int8": 64,
}

_SIMPLE = {
    "text": "text",
    "tinytext": "text",
    "mediumtext": "text",
    "longtext": "text",
    "ntext": "text",
    "citext": "text",
    "simple-array": "text",
    "boolean": "boolean",
    "bool": "boolean",
    "date": "date",
    "uuid": "uuid",
    "uniqueidentifier": "uuid",
    "json": "json",
    "jsonb": "json",
    "simple-json": "json",
    "bytea": "binary",
    "blob": "binary",
    "tinyblob": "binary",
    "mediumblob": "binary",
    "longblob": "binary",
    "image": "binary",
}


def _length_of(options: dict):
    value = options.get("length")
    length = number_of(value)
    if length is None and string_of(value) is not None:
        length = to_number(string_of(value))
    return length if length is not None and math.isfinite(length) else None


def _type_of_name(name: str, options: dict, dialect: str | None) -> dict | None:
    """The database type of a TypeORM column type (`varchar`, `timestamptz`…) with its options."""
    kind = name.lower()
    length = _length_of(options)
    sql = f"{kind}({number_text(length)})" if length is not None else kind
    if kind in _INTEGERS:
        return {"sql": sql, "kind": "integer", "bits": _INTEGERS[kind]}
    if kind == "float":
        return {"sql": sql, "kind": "float", "bits": 64 if dialect in ("postgresql", "sqlite") else 32}
    if kind == "real":
        return {"sql": sql, "kind": "float", "bits": 64 if dialect == "sqlite" else 32}
    if kind == "float4":
        return {"sql": sql, "kind": "float", "bits": 32}
    if kind in ("double", "double precision", "float8"):
        return {"sql": sql, "kind": "float", "bits": 64}
    if kind in ("decimal", "numeric", "dec"):
        precision = number_of(options.get("precision"))
        scale = number_of(options.get("scale"))
        return {
            "sql": sql,
            "kind": "decimal",
            **({"precision": precision} if precision is not None else {}),
            **({"scale": scale} if scale is not None else {}),
        }
    if kind in ("varchar", "character varying", "nvarchar", "varchar2", "nvarchar2"):
        return {"sql": sql, "kind": "text", "length": length} if length is not None else {"sql": sql, "kind": "text"}
    if kind in ("char", "character", "nchar"):
        if length is not None:
            return {"sql": sql, "kind": "text", "length": length, "fixed": True}
        return {"sql": sql, "kind": "text", "fixed": True}
    if kind in ("time", "time without time zone"):
        return {"sql": sql, "kind": "time", "timezone": False}
    if kind in ("timetz", "time with time zone"):
        return {"sql": sql, "kind": "time", "timezone": True}
    if kind in ("timestamp", "datetime", "datetime2", "smalldatetime", "timestamp without time zone"):
        return {"sql": sql, "kind": "datetime", "timezone": False}
    if kind in ("timestamptz", "timestamp with time zone", "datetimeoffset"):
        return {"sql": sql, "kind": "datetime", "timezone": True}
    if kind in ("binary", "varbinary"):
        return (
            {"sql": sql, "kind": "binary", "length": length} if length is not None else {"sql": sql, "kind": "binary"}
        )
    simple = _SIMPLE.get(kind)
    return {"sql": sql, "kind": simple} if simple else None


_NULLABLE = re.compile(r"\|\s*(null|undefined)\b")


def _plain_type(member: dict) -> str:
    return _NULLABLE.sub("", member["type"]).strip()


def _type_of_property(member: dict, options: dict, dialect: str | None) -> dict | None:
    """The type TypeORM gives a column from its TypeScript type, when the decorator names none."""
    plain = _plain_type(member)
    by_type = {"string": "varchar", "number": "int", "boolean": "boolean", "Date": "timestamp"}
    if plain in by_type:
        return _type_of_name(by_type[plain], options, dialect)
    if plain in ("Buffer", "Uint8Array"):
        return {"sql": plain, "kind": "binary"}
    return None


_NOW_SQL = re.compile(r"now\(\)|current_timestamp(\(\d*\))?|localtimestamp|datetime\('now'\)", re.IGNORECASE)
_UUID_SQL = re.compile(r"(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)", re.IGNORECASE)
_QUOTED = re.compile(r"(['\"`])([\s\S]*)\1")


def _apply_default(expr: dict, column: dict, enums: dict) -> None:
    """A default as the database applies it: a literal, an enum member, or SQL (`() => 'CURRENT_TIMESTAMP'`)."""
    if expr["kind"] == "other" and "=>" in expr["text"]:
        body = expr["text"][expr["text"].index("=>") + 2 :].strip()
        quoted = _QUOTED.fullmatch(body)
        sql = quoted.group(2) if quoted else body
        if _NOW_SQL.fullmatch(sql.strip()):
            column["generated"] = "now"
        elif _UUID_SQL.fullmatch(sql.strip()):
            column["generated"] = "uuid"
        else:
            column["default"] = {"kind": "expression", "sql": sql}
        return
    if expr["kind"] == "name" and expr["path"] == ["null"]:
        column["default"] = {"kind": "literal", "value": None}
        return
    if expr["kind"] == "name" and len(expr["path"]) == 2 and expr["path"][0] in enums:
        value = enums[expr["path"][0]].get(expr["path"][1])
        if value is not None:
            column["default"] = {"kind": "literal", "value": value}
        return
    value = literal_of(expr)
    if value is not None:
        column["default"] = {"kind": "literal", "value": value}
    elif expr["kind"] in ("list", "dict"):
        column["default"] = {"kind": "literal", "value": _to_json(expr)}


def _json_value(value) -> str:
    if isinstance(value, str):
        return json_string(value)
    return number_text(value)


def _to_json(expr: dict) -> str:
    """An array or object literal as JSON, for the default of a JSON column."""
    if expr["kind"] == "list":
        return f"[{','.join(_to_json(item) for item in expr['items'])}]"
    if expr["kind"] == "dict":
        entries = []
        for entry in expr["entries"]:
            key = name_of(entry["key"])
            key = key if key is not None else string_of(entry["key"])
            entries.append(f"{json_string(key if key is not None else '')}:{_to_json(entry['value'])}")
        return "{" + ",".join(entries) + "}"
    value = literal_of(expr)
    return "null" if value is None else _json_value(value)


_ACTIONS = {
    "CASCADE": "cascade",
    "SET NULL": "set null",
    "SET DEFAULT": "set default",
    "RESTRICT": "restrict",
    "NO ACTION": "no action",
}


def _action_of(expr: dict | None) -> str | None:
    return _ACTIONS.get((string_of(expr) or "").upper())


def _quoted_values(values: list) -> str:
    return ", ".join(
        number_text(value) if is_number(value) else "'" + value.replace("'", "''") + "'" for value in values
    )


def _enum_values(items: list) -> list:
    return [
        value for value in (literal_of(item) for item in items) if value is not None and not isinstance(value, bool)
    ]


# Building the tables

_COLUMNS = {
    "Column",
    "PrimaryColumn",
    "PrimaryGeneratedColumn",
    "CreateDateColumn",
    "UpdateDateColumn",
    "DeleteDateColumn",
    "VersionColumn",
}

_DATA_SOURCE = re.compile(
    r"\b(?:DataSource|createConnection|forRoot)\s*\(\s*\{[^{}]*?\btype\s*:\s*['\"]([\w-]+)['\"]", re.ASCII
)


def _read_typeorm(files: list[dict]) -> dict:
    notes: list[dict] = []
    classes, enums, order = _read_files(files)
    # The engine, when the data sources name only one
    drivers: list[str] = []
    for file in files:
        for match in _DATA_SOURCE.finditer(file["text"]):
            if match.group(1) not in drivers:
                drivers.append(match.group(1))
    for driver in drivers:
        if driver not in _DRIVERS:
            notes.append({"code": "orm.unsupportedEngine", "params": {"engine": driver}})
    dialects = {_DRIVERS[driver] for driver in drivers if driver in _DRIVERS}
    dialect = next(iter(dialects)) if len(dialects) == 1 else None
    native_enums = dialect != "sqlite"
    db_enums: list[dict] = []

    def add_enum(name: str, values: list, storage: str) -> None:
        if not any(item["name"] == name for item in db_enums):
            db_enums.append({"name": name, "values": [_json_text(value) for value in values], "storage": storage})

    def members_of(definition: dict, seen: set | None = None) -> list[dict]:
        seen = seen if seen is not None else set()
        seen.add(definition["name"])
        base = classes.get(definition["base"]) if definition["base"] else None
        inherited = members_of(base, seen) if base is not None and base["name"] not in seen else []
        return [*inherited, *definition["members"]]

    models: dict[str, dict] = {}
    for definition in order:
        entity = _decorator_of(definition["decorators"], "Entity")
        if entity is None:
            continue
        options = _options_of(entity["args"])
        name = string_of(entity["args"][0]) if entity["args"] else None
        if name is None:
            name = string_of(options.get("name"))
        table = {
            "name": name if name is not None else _snake_case(definition["name"]),
            "columns": [],
            "primaryKey": None,
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
            "entity": definition["name"],
            "origin": {"line": definition["line"], "column": 1},
        }
        schema = string_of(options.get("schema"))
        if schema:
            table["schema"] = schema
        comment = string_of(options.get("comment"))
        if comment:
            table["comment"] = comment
        model = {"def": definition, "table": table, "columns": {}, "members": members_of(definition), "enumChecks": []}
        primary: list[str] = []
        for member in model["members"]:
            decorator = next((item for item in member["decorators"] if item["name"] in _COLUMNS), None)
            if decorator is None:
                continue
            first = decorator["args"][0] if decorator["args"] else None
            if first is not None and first["kind"] == "other" and "=>" in first["text"]:
                notes.append(
                    {
                        "code": "orm.unknownType",
                        "params": {"table": table["name"], "column": member["name"], "type": text_of(first)},
                    }
                )
                continue
            column_options = _options_of(decorator["args"])
            column_name = string_of(column_options.get("name")) or member["name"]
            generated = None
            if decorator["name"] == "PrimaryGeneratedColumn":
                generated = string_of(first) or "increment"
                type_name = string_of(column_options.get("type"))
            else:
                type_name = string_of(first)
                type_name = type_name if type_name is not None else string_of(column_options.get("type"))
            enum_option = column_options.get("enum")
            if type_name in ("enum", "simple-enum") or enum_option is not None:
                values: list = []
                if enum_option is not None and enum_option["kind"] == "list":
                    values = _enum_values(enum_option["items"])
                elif enum_option is not None and enum_option["kind"] == "name":
                    values = list(enums.get(enum_option["path"][-1], {}).values())
                elif enum_option is not None and enum_option["kind"] == "dict":
                    values = _enum_values([entry["value"] for entry in enum_option["entries"]])
                enum_name = string_of(column_options.get("enumName")) or f"{table['name']}_{column_name}_enum"
                native = type_name != "simple-enum" and native_enums
                add_enum(enum_name, values, "native" if native else "check")
                if native:
                    column_type = {"sql": type_name or "enum", "kind": "enum", "name": enum_name}
                else:
                    column_type = {"sql": type_name or "simple-enum", "kind": "text"}
                    table["checks"].append(check_of(f"{column_name} IN ({_quoted_values(values)})"))
            elif generated == "uuid":
                column_type = (
                    _type_of_name(type_name, column_options, dialect) if type_name else {"sql": "uuid", "kind": "uuid"}
                )
            elif generated:
                column_type = _type_of_name(type_name or "int", column_options, dialect)
            elif decorator["name"] == "VersionColumn" and not type_name:
                column_type = _type_of_name("int", column_options, dialect)
            elif type_name:
                column_type = _type_of_name(type_name, column_options, dialect)
            else:
                column_type = _type_of_property(member, column_options, dialect)
            # A property typed with a TypeScript enum keeps its values in a text column: an enum checked by a CHECK
            ts_enum = _plain_type(member)
            if enum_option is None and column_type is not None and column_type["kind"] == "text" and ts_enum in enums:
                values = list(enums[ts_enum].values())
                add_enum(_snake_case(ts_enum), values, "check")
                model["enumChecks"].append((column_name, values))
            if column_type is not None and boolean_of(column_options.get("array")):
                column_type = {"sql": f"{column_type['sql']}[]", "kind": "array", "items": column_type}
            if column_type is None:
                notes.append(
                    {
                        "code": "orm.unknownType",
                        "params": {
                            "table": table["name"],
                            "column": column_name,
                            "type": type_name if type_name is not None else member["type"],
                        },
                    }
                )
            is_primary = (
                decorator["name"] == "PrimaryColumn"
                or bool(generated)
                or boolean_of(column_options.get("primary")) is True
            )
            column = {
                "name": column_name,
                "type": column_type
                if column_type is not None
                else {"sql": type_name if type_name is not None else member["type"], "kind": "unknown"},
                "nullable": not is_primary
                and (decorator["name"] == "DeleteDateColumn" or boolean_of(column_options.get("nullable")) is True),
            }
            value = column_options.get("default")
            if value is not None:
                _apply_default(value, column, enums)
            on_update = string_of(column_options.get("onUpdate"))
            made = None
            if generated == "uuid":
                made = "uuid"
            elif generated:
                made = "identity"
            elif decorator["name"] == "CreateDateColumn":
                made = "now"
            elif decorator["name"] == "UpdateDateColumn" or (on_update and _NOW_SQL.fullmatch(on_update.strip())):
                made = "onUpdateNow"
            marker = _decorator_of(member["decorators"], "Generated")
            if marker is not None:
                made = "uuid" if (string_of(marker["args"][0]) if marker["args"] else None) == "uuid" else "identity"
            expression = string_of(column_options.get("asExpression"))
            if expression:
                made = {"computed": expression}
            if made:
                column["generated"] = made
                if made in ("now", "onUpdateNow", "uuid"):
                    column.pop("default", None)
            column_comment = string_of(column_options.get("comment"))
            if column_comment:
                column["comment"] = column_comment
            if column_name != member["name"]:
                column["attribute"] = member["name"]
            table["columns"].append(column)
            model["columns"][member["name"]] = column_name
            if is_primary:
                primary.append(column_name)
            if boolean_of(column_options.get("unique")) is True:
                table["uniques"].append({"columns": [column_name]})
            index = _decorator_of(member["decorators"], "Index")
            if index is not None:
                index_name = string_of(index["args"][0]) if index["args"] else None
                target = table["uniques"] if boolean_of(_options_of(index["args"]).get("unique")) else table["indexes"]
                target.append({**({"name": index_name} if index_name else {}), "columns": [column_name]})
        if primary:
            table["primaryKey"] = primary
        models[definition["name"]] = model

    def columns_of(model: dict, expr: dict | None) -> list[str]:
        return [model["columns"].get(name, name) for name in _properties_of(expr)]

    for model in models.values():
        table = model["table"]
        for decorator in model["def"]["decorators"]:
            args = decorator["args"]
            named = string_of(args[0]) if args else None
            rest = args[1:] if named is not None else args
            name = {"name": named} if named is not None else {}
            if decorator["name"] == "Unique":
                columns = columns_of(model, rest[0] if rest else None)
                if columns:
                    table["uniques"].append({**name, "columns": columns})
            elif decorator["name"] == "Index":
                columns = columns_of(model, rest[0] if rest else None)
                target = table["uniques"] if boolean_of(_options_of(args).get("unique")) else table["indexes"]
                if columns:
                    target.append({**name, "columns": columns})
            elif decorator["name"] == "Check":
                sql = string_of(args[1]) if len(args) > 1 else None
                sql = sql if sql is not None else named
                if sql:
                    table["checks"].append(check_of(sql, named if len(args) > 1 else None))
        # The CHECK of an enum kept as text, unless the class declares one for the column
        for column, values in model["enumChecks"]:
            declared = any(
                (check.get("parsed") or {}).get("kind") == "in" and check["parsed"]["column"] == column
                for check in table["checks"]
            )
            if not declared:
                table["checks"].append(check_of(f"{column} IN ({_quoted_values(values)})"))
        # TypeORM does not create the table: its key may live only in the entity
        entity = _decorator_of(model["def"]["decorators"], "Entity")
        if boolean_of(_options_of(entity["args"]).get("synchronize")) is False:
            notes.append({"code": "orm.unmanagedTable", "params": {"table": table["name"]}})

    def referenced(target: dict, prop: str | None, position: int) -> dict | None:
        if prop is not None:
            column = target["columns"].get(prop, prop)
        else:
            key = target["table"]["primaryKey"] or []
            column = key[position] if position < len(key) else None
        return next((item for item in target["table"]["columns"] if item["name"] == column), None)

    joins: list[dict] = []
    for model in models.values():
        table = model["table"]
        for member in model["members"]:
            relation = _decorator_of(member["decorators"], "ManyToOne", "OneToOne", "ManyToMany")
            if relation is None:
                continue
            args = relation["args"]
            target = models.get(_class_name_of(args[0] if args else None) or "")
            if target is None:
                continue
            options = _options_of(args)
            second = args[1] if len(args) > 1 else None
            inverse = None if second is not None and second["kind"] == "dict" else _inverse_of(second)
            if relation["name"] == "ManyToMany":
                join_table = _decorator_of(member["decorators"], "JoinTable")
                if join_table is not None:
                    joins.append(
                        _join_table_of(model, target, member, _options_of(join_table["args"]), options, referenced)
                    )
                continue
            join_column = _decorator_of(member["decorators"], "JoinColumn")
            if relation["name"] == "OneToOne" and join_column is None:
                continue
            join_arg = join_column["args"][0] if join_column is not None and join_column["args"] else None
            if join_arg is not None and join_arg["kind"] == "list":
                join_options = [_options_of([item]) for item in join_arg["items"]]
            elif join_arg is not None:
                join_options = [_options_of([join_arg])]
            else:
                join_options = []
            if not join_options:
                join_options = [{} for _ in target["table"]["primaryKey"] or []]
            columns: list[str] = []
            references: list[str] = []
            for position, join in enumerate(join_options):
                parent = referenced(target, string_of(join.get("referencedColumnName")), position)
                if parent is None:
                    continue
                name = string_of(join.get("name")) or _camel_case(f"{member['name']}_{parent['name']}")
                if not any(item["name"] == name for item in table["columns"]):
                    primary = bool(boolean_of(options.get("primary")))
                    nullable = boolean_of(options.get("nullable")) is not False and not primary
                    table["columns"].append({"name": name, "type": parent["type"], "nullable": nullable})
                    if primary:
                        table["primaryKey"] = [*(table["primaryKey"] or []), name]
                columns.append(name)
                references.append(parent["name"])
            if not columns:
                continue
            constraint = string_of(join_options[0].get("foreignKeyConstraintName")) if join_options else None
            on_delete = _action_of(options.get("onDelete"))
            on_update = _action_of(options.get("onUpdate"))
            target_table = target["table"]
            table["foreignKeys"].append(
                {
                    **({"name": constraint} if constraint else {}),
                    "columns": columns,
                    "references": {
                        "table": target_table["name"],
                        **({"schema": target_table["schema"]} if target_table.get("schema") else {}),
                        "columns": references,
                    },
                    **({"onDelete": on_delete} if on_delete else {}),
                    **({"onUpdate": on_update} if on_update else {}),
                    "attribute": member["name"],
                    **({"inverse": inverse} if inverse else {}),
                }
            )

            # TypeORM makes the columns of a one-to-one relation unique
            def same(items: list[str], columns: list[str] = columns) -> bool:
                return len(items) == len(columns) and all(item in columns for item in items)

            if (
                relation["name"] == "OneToOne"
                and not any(same(item["columns"]) for item in table["uniques"])
                and not same(table["primaryKey"] or [])
            ):
                table["uniques"].append({"columns": columns})
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": dialect,
        "source": {"kind": "orm", "format": "typeorm"},
        "tables": [*(model["table"] for model in models.values()), *joins],
        "enums": db_enums,
        "notes": notes,
    }


def _json_text(value) -> str:
    """String(value) of an enum value."""
    return value if isinstance(value, str) else number_text(value)


def _join_table_of(model: dict, target: dict, member: dict, options: dict, relation: dict, referenced) -> dict:
    """The table of a many-to-many relation (`@JoinTable`): its name and columns as given, or as TypeORM names them
    (`<table>_<property>_<other table>`, with `<table>Id`-like columns), keyed by both and deleted with either row."""
    name = string_of(options.get("name"))
    table = {
        "name": name
        if name is not None
        else _snake_case(f"{model['table']['name']}_{member['name']}_{target['table']['name']}"),
        "columns": [],
        "primaryKey": [],
        "foreignKeys": [],
        "uniques": [],
        "indexes": [],
        "checks": [],
        "origin": {"line": member["line"], "column": 1},
    }
    schema = string_of(options.get("schema"))
    if schema:
        table["schema"] = schema
    sides = (
        (
            options.get("joinColumn"),
            model,
            _action_of(relation.get("onDelete")) or "cascade",
            _action_of(relation.get("onUpdate")) or "cascade",
        ),
        (options.get("inverseJoinColumn"), target, "cascade", "cascade"),
    )
    for join, side, on_delete, on_update in sides:
        join_options = _options_of([join]) if join is not None else {}
        parent = referenced(side, string_of(join_options.get("referencedColumnName")), 0)
        if parent is None:
            continue
        column = string_of(join_options.get("name")) or _camel_case(f"{side['table']['name']}_{parent['name']}")
        table["columns"].append({"name": column, "type": parent["type"], "nullable": False})
        table["primaryKey"].append(column)
        table["indexes"].append({"columns": [column]})
        side_table = side["table"]
        table["foreignKeys"].append(
            {
                "columns": [column],
                "references": {
                    "table": side_table["name"],
                    **({"schema": side_table["schema"]} if side_table.get("schema") else {}),
                    "columns": [parent["name"]],
                },
                "onDelete": on_delete,
                "onUpdate": on_update,
            }
        )
    return table


_IMPORTS = re.compile(r"\bfrom\s+['\"]typeorm['\"]|\brequire\(\s*['\"]typeorm['\"]\s*\)")
_ENTITY = re.compile(r"@Entity\s*\(")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if _IMPORTS.search(text) and _ENTITY.search(text) else 0


TYPEORM_READER = OrmReader(id="typeorm", label="TypeORM", language="typescript", detect=_detect, read=_read_typeorm)
