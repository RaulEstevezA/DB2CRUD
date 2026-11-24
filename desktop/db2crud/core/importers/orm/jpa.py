"""Reads JPA entities (Jakarta Persistence, also with Hibernate's annotations, as Spring Data JPA uses them) into the
physical schema: classes marked `@Entity`, the fields of their `@MappedSuperclass` bases and of their `@Embeddable`
parts, `@Table` with its indexes, unique and check constraints, `@Column` and the type of each field (or its
`columnDefinition`, or Hibernate's `@JdbcTypeCode`), keys (`@Id`, `@IdClass`, `@EmbeddedId`), generated values,
Hibernate's `@ColumnDefault`, `@Check`, `@OnDelete` and `@Comment`, foreign keys of `@ManyToOne` and `@OneToOne`, join
tables of `@ManyToMany`, and Java enums with the values the database keeps (by name, by a converter, or by position).
Names nobody gave follow JPA's defaults: the class and the field as written. The engine is the one the JDBC URLs in
the code name, when they name only one. Mirrors web/src/core/importers/orm/jpa.ts.

A field is {name, type, annotations, modifiers, initializer?, line}; a class {name, kind, annotations, base,
implements, fields, constants, line}; an annotation is a name or a call expression."""

import re

from ...js import is_number, number, number_text
from ...model.naming import to_snake_case
from ...schema.checks import check_of
from ..code.java import JAVA_LEXER
from ..code.lexer import Cursor, LexError, tokenize
from .expressions import boolean_of, literal_of, name_of, number_of, read_arguments, read_expression, string_of, text_of
from .sql_types import sql_type_of
from .types import OrmReader

_NAMED = "="

# Reading the declarations


def _read_annotation(cursor: Cursor, source: str) -> dict:
    """`@Name` or `@Name(args)`, after its `@`: a name or a call."""
    path = [cursor.next().value]
    while cursor.is_(".") and cursor.is_ident(1):
        cursor.next()
        path.append(cursor.next().value)
    callee = {"kind": "name", "path": path}
    if not cursor.is_("("):
        return callee
    cursor.next()
    args, named = read_arguments(cursor, source, _NAMED, ")")
    return {"kind": "call", "callee": callee, "args": args, "named": named}


_MODIFIERS = {
    "public",
    "private",
    "protected",
    "static",
    "final",
    "abstract",
    "transient",
    "volatile",
    "synchronized",
    "native",
    "strictfp",
    "default",
    "sealed",
}
_DECLARATIONS = {"class", "interface", "enum", "record"}


def _skip_type(cursor: Cursor) -> None:
    """Skips a type as written: `java.util.List<Map<String, Integer>>[]`."""
    if cursor.is_ident():
        cursor.next()
    while cursor.is_(".") and cursor.is_ident(1):
        cursor.next()
        cursor.next()
    if cursor.is_("<"):
        depth = 0
        while not cursor.done:
            value = cursor.next().value
            if value == "<":
                depth += 1
            elif value == ">":
                depth -= 1
            if depth == 0:
                break
    while cursor.is_("[") and cursor.is_("]", 1):
        cursor.next()
        cursor.next()


def _skip_method(cursor: Cursor) -> None:
    """Moves past a method or constructor: its parameters, `throws` and body."""
    cursor.skip_group()
    while not cursor.done and not cursor.is_("{") and not cursor.is_(";") and not cursor.is_("}"):
        cursor.next()
    if cursor.is_("{"):
        cursor.skip_group()
    else:
        cursor.eat(";")


def _is_annotation(cursor: Cursor) -> bool:
    return cursor.is_("@") and cursor.is_ident(1) and not cursor.is_("interface", 1)


def _read_declaration(cursor: Cursor, source: str, kind: str, annotations: list, classes: list) -> None:
    token = cursor.peek()
    line = token.line if token is not None else 1
    declaration = {
        "name": cursor.next().value,
        "kind": kind,
        "annotations": annotations,
        "base": None,
        "implements": "",
        "fields": [],
        "constants": [],
        "line": line,
    }
    # The header: type parameters, record components, `extends`, `implements`
    while not cursor.done and not cursor.is_("{"):
        if cursor.is_("extends") and cursor.is_ident(1):
            cursor.next()
            declaration["base"] = cursor.next().value
        elif cursor.is_("implements"):
            start = cursor.index + 1
            while not cursor.done and not cursor.is_("{"):
                cursor.next()
            declaration["implements"] = cursor.text_between(source, start, cursor.index)
        elif cursor.is_("("):
            cursor.skip_group()
        else:
            cursor.next()
    classes.append(declaration)
    cursor.next()
    if kind == "enum":
        # The constants, up to the `;` that ends them or the end of the body
        while not cursor.done and not cursor.is_(";") and not cursor.is_("}"):
            if _is_annotation(cursor):
                cursor.next()
                _read_annotation(cursor, source)
                continue
            if not cursor.is_ident():
                cursor.next()
                continue
            name = cursor.next().value
            args: list = []
            if cursor.is_("("):
                cursor.next()
                args = read_arguments(cursor, source, _NAMED, ")")[0]
            if cursor.is_("{"):
                cursor.skip_group()
            declaration["constants"].append({"name": name, "args": args})
            cursor.eat(",")
        cursor.eat(";")
    _read_body(cursor, source, declaration, classes)


def _read_body(cursor: Cursor, source: str, declaration: dict, classes: list) -> None:
    annotations: list = []
    modifiers: set[str] = set()

    def reset() -> None:
        nonlocal annotations
        annotations = []
        modifiers.clear()

    while not cursor.done and not cursor.is_("}"):
        if _is_annotation(cursor):
            cursor.next()
            annotations.append(_read_annotation(cursor, source))
            continue
        if cursor.is_(";"):
            cursor.next()
            reset()
            continue
        if cursor.is_("{"):
            # An initializer block
            cursor.skip_group()
            reset()
            continue
        if cursor.value() in _MODIFIERS and cursor.is_ident():
            modifiers.add(cursor.next().value)
            continue
        if cursor.value() in _DECLARATIONS and cursor.is_ident(1):
            kind = cursor.next().value
            _read_declaration(cursor, source, kind, annotations, classes)
            cursor.eat("}")
            reset()
            continue
        if cursor.is_("<"):
            # The type parameters of a generic method
            _skip_type(cursor)
            continue
        if not cursor.is_ident():
            cursor.next()
            reset()
            continue
        type_start = cursor.index
        _skip_type(cursor)
        field_type = cursor.text_between(source, type_start, cursor.index)
        if cursor.is_("("):
            _skip_method(cursor)
            reset()
            continue
        if not cursor.is_ident():
            reset()
            continue
        name = cursor.next()
        if cursor.is_("("):
            _skip_method(cursor)
            reset()
            continue
        initializer = read_expression(cursor, source, _NAMED) if cursor.eat("=") else None
        cursor.skip_until([";"])
        cursor.eat(";")
        declaration["fields"].append(
            {
                "name": name.value,
                "type": field_type,
                "annotations": annotations,
                "modifiers": set(modifiers),
                **({"initializer": initializer} if initializer is not None else {}),
                "line": name.line,
            }
        )
        reset()


def read_classes(files: list[dict]) -> list[dict]:
    classes: list[dict] = []
    for file in files:
        try:
            tokens = tokenize(file["text"], JAVA_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)
        annotations: list = []
        while not cursor.done:
            if _is_annotation(cursor):
                cursor.next()
                annotations.append(_read_annotation(cursor, file["text"]))
            elif cursor.value() in _DECLARATIONS and cursor.is_ident() and cursor.is_ident(1):
                kind = cursor.next().value
                _read_declaration(cursor, file["text"], kind, annotations, classes)
                cursor.eat("}")
                annotations = []
            elif cursor.is_("package") or cursor.is_("import"):
                cursor.skip_until([";"])
                cursor.eat(";")
            else:
                cursor.next()
    return classes


# Reading the annotations


def annotation_of(annotations: list, *names: str) -> dict | None:
    return next((item for item in annotations if (name_of(item) or "") in names), None)


def argument_of(annotation: dict | None, name: str) -> dict | None:
    """An argument of an annotation: named, or `value` (the first one without a name)."""
    if annotation is None or annotation["kind"] != "call":
        return None
    found = annotation["named"].get(name)
    if found is None and name == "value" and annotation["args"]:
        found = annotation["args"][0]
    return found


def _items(expr: dict | None) -> list:
    if expr is None:
        return []
    return expr["items"] if expr["kind"] == "list" else [expr]


def calls_of(expr: dict | None) -> list[dict]:
    """The annotations an argument holds: one, or a list of them."""
    return [item for item in _items(expr) if item["kind"] == "call"]


def _strings_of(expr: dict | None) -> list[str]:
    return [value for value in (string_of(item) for item in _items(expr)) if value is not None]


def simple_type(text: str) -> str:
    """The simple name of a Java type: `java.util.List<OrderLine>` → `List`."""
    return re.sub(r"<[\s\S]*$", "", text).split(".")[-1].strip()


# Types

_JAVA_TYPES = {
    "Long": ("integer", 64),
    "long": ("integer", 64),
    "Integer": ("integer", 32),
    "int": ("integer", 32),
    "Short": ("integer", 16),
    "short": ("integer", 16),
    "Byte": ("integer", 16),
    "byte": ("integer", 16),
    "Double": ("float", 64),
    "double": ("float", 64),
    "Float": ("float", 32),
    "float": ("float", 32),
    "BigDecimal": "decimal",
    "BigInteger": "decimal",
    "Boolean": "boolean",
    "boolean": "boolean",
    "LocalDate": "date",
    "UUID": "uuid",
    "Blob": "binary",
    "Clob": "text",
}

_PRIMITIVES = {"long", "int", "short", "byte", "double", "float", "boolean", "char"}

# The types `@JdbcTypeCode(SqlTypes.…)` names
_JDBC_TYPES = {
    "TINYINT": "tinyint",
    "SMALLINT": "smallint",
    "INTEGER": "integer",
    "BIGINT": "bigint",
    "REAL": "real",
    "FLOAT": "float",
    "DOUBLE": "double",
    "NUMERIC": "numeric",
    "DECIMAL": "decimal",
    "CHAR": "char",
    "NCHAR": "char",
    "VARCHAR": "varchar",
    "NVARCHAR": "varchar",
    "LONGVARCHAR": "text",
    "LONG32VARCHAR": "text",
    "CLOB": "text",
    "BOOLEAN": "boolean",
    "BIT": "boolean",
    "DATE": "date",
    "TIME": "time",
    "TIMESTAMP": "timestamp",
    "TIMESTAMP_WITH_TIMEZONE": "timestamptz",
    "TIMESTAMP_UTC": "timestamptz",
    "UUID": "uuid",
    "JSON": "json",
    "JSON_ARRAY": "json",
    "BINARY": "binary",
    "VARBINARY": "varbinary",
    "LONGVARBINARY": "blob",
    "BLOB": "blob",
}


def _java_type_of(field: dict, column: dict | None, dialect: str | None) -> dict | None:
    """The type of a field from its Java type and its `@Column`."""
    written = re.sub(r"\s+", "", field["type"])
    name = simple_type(written)
    sql = written
    length = number_of(argument_of(column, "length"))
    if written in ("byte[]", "Byte[]"):
        return {"sql": sql, "kind": "binary", **({"length": length} if length is not None else {})}
    if name == "String":
        if annotation_of(field["annotations"], "Lob"):
            return {"sql": sql, "kind": "text"}
        return {"sql": sql, "kind": "text", "length": length if length is not None else 255}
    if name in ("char", "Character"):
        return {"sql": sql, "kind": "text", "length": 1, "fixed": True}
    if name in ("LocalTime", "OffsetTime"):
        return {"sql": sql, "kind": "time", "timezone": name == "OffsetTime"}
    if name == "LocalDateTime":
        return {"sql": sql, "kind": "datetime", "timezone": False}
    if name in ("OffsetDateTime", "ZonedDateTime", "Instant"):
        return {"sql": sql, "kind": "datetime", "timezone": True}
    if name in ("Date", "Calendar", "Timestamp"):
        temporal = name_of(argument_of(annotation_of(field["annotations"], "Temporal"), "value"))
        if temporal == "DATE" or written == "java.sql.Date":
            return {"sql": sql, "kind": "date"}
        if temporal == "TIME":
            return {"sql": sql, "kind": "time", "timezone": False}
        return {"sql": sql, "kind": "datetime", "timezone": False}
    known = _JAVA_TYPES.get(name)
    if known is None:
        return None
    if isinstance(known, tuple):
        kind, bits = known
        if kind == "integer":
            return {"sql": sql, "kind": kind, "bits": max(bits, 32) if dialect == "sqlite" else bits}
        return {"sql": sql, "kind": "float", "bits": bits}
    if known == "decimal":
        precision = number_of(argument_of(column, "precision"))
        scale = number_of(argument_of(column, "scale"))
        return {
            "sql": sql,
            "kind": "decimal",
            **({"precision": precision} if precision is not None else {}),
            **({"scale": scale} if scale is not None else {}),
        }
    return {"sql": sql, "kind": known}


_NOW_SQL = re.compile(r"now\(\)|current_timestamp(\(\d*\))?|localtimestamp|datetime\('now'\)", re.IGNORECASE)
_UUID_SQL = re.compile(r"(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)", re.IGNORECASE)


def _apply_default(sql: str, column: dict) -> None:
    """A default written in SQL (`@ColumnDefault("1")`): a literal when it is one."""
    text = sql.strip()
    if _NOW_SQL.fullmatch(text):
        column["generated"] = "now"
    elif _UUID_SQL.fullmatch(text):
        column["generated"] = "uuid"
    elif re.fullmatch(r"-?\d+(\.\d+)?", text):
        column["default"] = {"kind": "literal", "value": number(text)}
    elif re.fullmatch(r"'(?:[^']|'')*'", text):
        column["default"] = {"kind": "literal", "value": text[1:-1].replace("''", "'")}
    elif re.fullmatch(r"true|false", text, re.IGNORECASE):
        column["default"] = {"kind": "literal", "value": text.lower() == "true"}
    elif re.fullmatch(r"null", text, re.IGNORECASE):
        column["default"] = {"kind": "literal", "value": None}
    else:
        column["default"] = {"kind": "expression", "sql": text}


_ACTIONS = {
    "CASCADE": "cascade",
    "SET_NULL": "set null",
    "SET_DEFAULT": "set default",
    "RESTRICT": "restrict",
    "NO_ACTION": "no action",
}

_DIALECTS = {
    "postgresql": "postgresql",
    "mysql": "mysql",
    "mariadb": "mariadb",
    "sqlite": "sqlite",
    "sqlserver": "sqlserver",
    "oracle": "oracle",
}


def _quoted(values: list) -> str:
    return ", ".join(
        number_text(value) if is_number(value) else "'" + value.replace("'", "''") + "'" for value in values
    )


_RELATIONS = ("ManyToOne", "OneToOne", "OneToMany", "ManyToMany", "ElementCollection")
_JDBC_URL = re.compile(r"jdbc:(\w+):", re.ASCII)
_CONVERTER = re.compile(r"AttributeConverter\s*<\s*([\w.]+)\s*,", re.ASCII)
_GENERIC = re.compile(r"<\s*([\w.]+)\s*>", re.ASCII)
_DEFINITION_TAIL = re.compile(r"\s+(not\s+null|null|default\b.*|primary\s+key.*|unique.*)$", re.IGNORECASE)
_NOT_NULL = re.compile(r"\bnot\s+null\b", re.IGNORECASE)


def _target_name(relation: dict, field: dict) -> str:
    target_entity = string_of(argument_of(relation, "targetEntity"))
    if target_entity is not None:
        return simple_type(target_entity)
    generic = _GENERIC.search(field["type"])
    return simple_type(generic.group(1) if generic else field["type"])


# Building the tables


def _read_jpa(files: list[dict]) -> dict:
    notes: list[dict] = []
    classes = read_classes(files)
    by_name = {cls["name"]: cls for cls in classes}
    engines: list[str] = []
    for file in files:
        for match in _JDBC_URL.finditer(file["text"]):
            if match.group(1) not in engines:
                engines.append(match.group(1))
    dialects = {_DIALECTS[engine] for engine in engines if engine in _DIALECTS}
    dialect = next(iter(dialects)) if len(dialects) == 1 else None
    db_enums: list[dict] = []

    # Converters that apply to every field of a type:
    # `@Converter(autoApply = true) … AttributeConverter<Status, String>`
    converters: dict[str, dict] = {}
    for cls in classes:
        match = _CONVERTER.search(cls["implements"])
        if match:
            converters[cls["name"]] = cls
            auto = argument_of(annotation_of(cls["annotations"], "Converter"), "autoApply")
            if boolean_of(auto) is True:
                converters[f"auto:{simple_type(match.group(1))}"] = cls

    def fields_of(cls: dict, seen: set | None = None) -> list[dict]:
        """The fields of a class and of the `@MappedSuperclass` classes it extends."""
        seen = seen if seen is not None else set()
        seen.add(cls["name"])
        base = by_name.get(cls["base"]) if cls["base"] else None
        inherited = (
            fields_of(base, seen)
            if base is not None and base["name"] not in seen and annotation_of(base["annotations"], "MappedSuperclass")
            else []
        )
        return [
            field
            for field in [*inherited, *cls["fields"]]
            if "static" not in field["modifiers"]
            and "transient" not in field["modifiers"]
            and not annotation_of(field["annotations"], "Transient")
        ]

    def enum_of(field: dict, enum_class: dict) -> tuple[list, bool]:
        """The values the database keeps for a field typed with a Java enum, and whether they are positions."""
        enumerated = name_of(argument_of(annotation_of(field["annotations"], "Enumerated"), "value"))
        convert = annotation_of(field["annotations"], "Convert")
        converter_expr = argument_of(convert, "converter")
        converter_text = text_of(converter_expr) if converter_expr is not None else ""
        converter_name = simple_type(re.sub(r"\.class$", "", converter_text))
        converter = converters.get(converter_name)
        if converter is None and not enumerated:
            converter = converters.get(f"auto:{enum_class['name']}")
        if converter is not None:
            # A converter usually keeps the text each constant is built with
            values = [
                string_of(constant["args"][0]) if constant["args"] else None for constant in enum_class["constants"]
            ]
            if all(value is not None for value in values):
                return values, False
            return [item["name"] for item in enum_class["constants"]], False
        if enumerated == "STRING":
            return [item["name"] for item in enum_class["constants"]], False
        return list(range(len(enum_class["constants"]))), True

    models: list[dict] = []
    by_class: dict[str, dict] = {}
    for cls in classes:
        entity = annotation_of(cls["annotations"], "Entity")
        if entity is None:
            continue
        table_annotation = annotation_of(cls["annotations"], "Table")
        table_name = string_of(argument_of(table_annotation, "name"))
        if table_name is None:
            table_name = string_of(argument_of(entity, "name"))
        table = {
            "name": table_name if table_name is not None else cls["name"],
            "columns": [],
            "primaryKey": None,
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
            "entity": cls["name"],
            "origin": {"line": cls["line"], "column": 1},
        }
        schema = string_of(argument_of(table_annotation, "schema"))
        if schema:
            table["schema"] = schema
        comment = string_of(argument_of(annotation_of(cls["annotations"], "Comment"), "value"))
        if comment:
            table["comment"] = comment
        model = {"cls": cls, "table": table, "columns": {}, "fields": fields_of(cls)}
        primary: list[str] = []
        enum_checks: list[tuple[str, list]] = []

        def add_column(
            field: dict,
            overrides: dict,
            key: bool,
            prefix: str = "",
            table: dict = table,
            model: dict = model,
            primary: list = primary,
            enum_checks: list = enum_checks,
        ) -> None:
            embeddable = by_name.get(simple_type(field["type"]))
            embedded = annotation_of(field["annotations"], "Embedded", "EmbeddedId") or (
                embeddable is not None and annotation_of(embeddable["annotations"], "Embeddable")
            )
            if embedded and embeddable is not None:
                # The fields of an embedded part are columns of the table, renamed by @AttributeOverride
                own = dict(overrides)
                many = calls_of(argument_of(annotation_of(field["annotations"], "AttributeOverrides"), "value"))
                single = [
                    item
                    for item in field["annotations"]
                    if item["kind"] == "call" and name_of(item) == "AttributeOverride"
                ]
                for override in [*many, *single]:
                    name = string_of(argument_of(override, "name"))
                    column = argument_of(override, "column")
                    if name and column is not None:
                        own[f"{prefix}{field['name']}.{name}"] = column
                is_key = key or bool(annotation_of(field["annotations"], "EmbeddedId"))
                for part in fields_of(embeddable):
                    add_column(part, own, is_key, f"{prefix}{field['name']}.")
                return
            column_annotation = overrides.get(f"{prefix}{field['name']}")
            if column_annotation is None:
                column_annotation = annotation_of(field["annotations"], "Column")
            given_name = string_of(argument_of(column_annotation, "name"))
            name = given_name if given_name is not None else field["name"]
            definition = string_of(argument_of(column_annotation, "columnDefinition"))
            jdbc = name_of(argument_of(annotation_of(field["annotations"], "JdbcTypeCode"), "value"))
            enum_class = by_name.get(simple_type(field["type"]))
            column_type = None
            if definition:
                column_type = sql_type_of(_DEFINITION_TAIL.sub("", definition), dialect)
            elif jdbc and jdbc in _JDBC_TYPES:
                base = sql_type_of(_JDBC_TYPES[jdbc], dialect)
                length = number_of(argument_of(column_annotation, "length"))
                column_type = (
                    {**base, "length": length}
                    if base is not None
                    and base["kind"] == "text"
                    and _JDBC_TYPES[jdbc] != "text"
                    and length is not None
                    else base
                )
                if base is not None and base["kind"] == "decimal":
                    precision = number_of(argument_of(column_annotation, "precision"))
                    scale = number_of(argument_of(column_annotation, "scale"))
                    column_type = {
                        **base,
                        **({"precision": precision} if precision is not None else {}),
                        **({"scale": scale} if scale is not None else {}),
                    }
            elif enum_class is not None and enum_class["kind"] == "enum":
                values, ordinal = enum_of(field, enum_class)
                if ordinal:
                    column_type = {"sql": field["type"], "kind": "integer", "bits": 16}
                else:
                    length = number_of(argument_of(column_annotation, "length"))
                    column_type = {
                        "sql": field["type"],
                        "kind": "text",
                        "length": length if length is not None else 255,
                    }
                    enum_name = to_snake_case(enum_class["name"])
                    if not any(item["name"] == enum_name for item in db_enums):
                        db_enums.append(
                            {
                                "name": enum_name,
                                "values": [value if isinstance(value, str) else number_text(value) for value in values],
                                "storage": "check",
                            }
                        )
                enum_checks.append((name, values))
            else:
                column_type = _java_type_of(field, column_annotation, dialect)
            if definition and column_type is not None:
                column_type = {**column_type, "sql": definition}
            if column_type is None:
                notes.append(
                    {
                        "code": "orm.unknownType",
                        "params": {"table": table["name"], "column": name, "type": definition or field["type"]},
                    }
                )
            is_key = key or bool(annotation_of(field["annotations"], "Id"))
            required = (
                is_key
                or field["type"].strip() in _PRIMITIVES
                or bool(_NOT_NULL.search(definition or ""))
                or boolean_of(argument_of(column_annotation, "nullable")) is False
                or boolean_of(argument_of(annotation_of(field["annotations"], "Basic"), "optional")) is False
                or bool(annotation_of(field["annotations"], "NotNull", "NonNull"))
            )
            column = {
                "name": name,
                "type": column_type
                if column_type is not None
                else {"sql": definition or field["type"], "kind": "unknown"},
                "nullable": not required,
            }
            column_default = string_of(argument_of(annotation_of(field["annotations"], "ColumnDefault"), "value"))
            if column_default is not None:
                _apply_default(column_default, column)
            elif field.get("initializer") is not None:
                # The value a new row starts with: a literal, or a constant of its enum
                initializer = field["initializer"]
                value = literal_of(initializer)
                constant = -1
                if (
                    initializer["kind"] == "name"
                    and len(initializer["path"]) == 2
                    and enum_class is not None
                    and enum_class["kind"] == "enum"
                    and initializer["path"][0] == enum_class["name"]
                ):
                    constant = next(
                        (
                            index
                            for index, item in enumerate(enum_class["constants"])
                            if item["name"] == initializer["path"][1]
                        ),
                        -1,
                    )
                if value is not None:
                    column["default"] = {"kind": "literal", "value": value}
                elif constant >= 0 and enum_class is not None:
                    column["default"] = {"kind": "literal", "value": enum_of(field, enum_class)[0][constant]}
            generated_value = annotation_of(field["annotations"], "GeneratedValue")
            if generated_value is not None:
                strategy = name_of(argument_of(generated_value, "strategy"))
                column["generated"] = "uuid" if strategy == "UUID" or column["type"]["kind"] == "uuid" else "identity"
            if annotation_of(field["annotations"], "UuidGenerator"):
                column["generated"] = "uuid"
            if annotation_of(field["annotations"], "CreationTimestamp"):
                column["generated"] = "now"
            if annotation_of(field["annotations"], "UpdateTimestamp"):
                column["generated"] = "onUpdateNow"
            computed = string_of(argument_of(annotation_of(field["annotations"], "GeneratedColumn"), "value"))
            if computed:
                column["generated"] = {"computed": computed}
            if column.get("generated") in ("now", "onUpdateNow", "uuid"):
                column.pop("default", None)
            column_comment = string_of(argument_of(annotation_of(field["annotations"], "Comment"), "value"))
            if column_comment:
                column["comment"] = column_comment
            attribute = f"{prefix}{field['name']}"
            if name != attribute:
                column["attribute"] = attribute
            table["columns"].append(column)
            model["columns"][attribute] = name
            if is_key:
                primary.append(name)
            if boolean_of(argument_of(column_annotation, "unique")) is True:
                table["uniques"].append({"columns": [name]})
            check = string_of(argument_of(annotation_of(field["annotations"], "Check"), "constraints"))
            if check:
                table["checks"].append(check_of(check))

        for field in model["fields"]:
            if annotation_of(field["annotations"], *_RELATIONS):
                continue
            add_column(field, {}, False)
        if primary:
            table["primaryKey"] = primary

        # The constraints of @Table, and Hibernate's @Check
        for index in calls_of(argument_of(table_annotation, "indexes")):
            column_list = string_of(argument_of(index, "columnList")) or ""
            columns = [
                item
                for item in (
                    re.sub(r"\s+(asc|desc)$", "", part.strip(), flags=re.IGNORECASE) for part in column_list.split(",")
                )
                if item
            ]
            if not columns:
                continue
            name = string_of(argument_of(index, "name"))
            target = table["uniques"] if boolean_of(argument_of(index, "unique")) is True else table["indexes"]
            target.append({**({"name": name} if name else {}), "columns": columns})
        for unique in calls_of(argument_of(table_annotation, "uniqueConstraints")):
            columns = _strings_of(argument_of(unique, "columnNames"))
            name = string_of(argument_of(unique, "name"))
            if columns:
                table["uniques"].append({**({"name": name} if name else {}), "columns": columns})
        for check in calls_of(argument_of(table_annotation, "check")):
            sql = string_of(argument_of(check, "constraint"))
            name = string_of(argument_of(check, "name"))
            if sql:
                table["checks"].append(check_of(sql, name))
        for check in [item for item in cls["annotations"] if name_of(item) == "Check"]:
            sql = string_of(argument_of(check, "constraints"))
            name = string_of(argument_of(check, "name"))
            if sql:
                table["checks"].append(check_of(sql, name))
        # Hibernate checks the values of an enum: the CHECK of a column with none declared
        for column, values in enum_checks:
            declared = any(
                (check.get("parsed") or {}).get("kind") == "in" and check["parsed"]["column"] == column
                for check in table["checks"]
            )
            if not declared:
                table["checks"].append(check_of(f"{column} IN ({_quoted(values)})"))
        models.append(model)
        by_class[cls["name"]] = model

    def key_column(target: dict, name: str | None, position: int) -> dict | None:
        if name is not None:
            column = name
        else:
            key = target["table"]["primaryKey"] or []
            column = key[position] if position < len(key) else None
        return next((item for item in target["table"]["columns"] if item["name"] == column), None)

    joins: list[dict] = []
    for model in models:
        table = model["table"]
        for field in model["fields"]:
            relation = annotation_of(field["annotations"], "ManyToOne", "OneToOne", "ManyToMany")
            if relation is None:
                continue
            kind = name_of(relation)
            target = by_class.get(_target_name(relation, field))
            if target is None or argument_of(relation, "mappedBy") is not None:
                continue
            if kind == "ManyToMany":
                joins.append(
                    _join_table_of(model, target, field, annotation_of(field["annotations"], "JoinTable"), key_column)
                )
                continue
            join_columns = annotation_of(field["annotations"], "JoinColumns")
            if join_columns is not None:
                given = calls_of(argument_of(join_columns, "value"))
            else:
                given = calls_of(annotation_of(field["annotations"], "JoinColumn"))
            join_list = given if given else [None for _ in target["table"]["primaryKey"] or []]
            columns: list[str] = []
            references: list[str] = []
            is_id = bool(annotation_of(field["annotations"], "Id"))
            for position, join in enumerate(join_list):
                parent = key_column(target, string_of(argument_of(join, "referencedColumnName")), position)
                if parent is None:
                    continue
                given_name = string_of(argument_of(join, "name"))
                name = given_name if given_name is not None else f"{field['name']}_{parent['name']}"
                if not any(item["name"] == name for item in table["columns"]):
                    optional = boolean_of(argument_of(relation, "optional")) is not False
                    stated = boolean_of(argument_of(join, "nullable"))
                    nullable = stated if stated is not None else optional
                    table["columns"].append({"name": name, "type": parent["type"], "nullable": nullable and not is_id})
                    if is_id:
                        table["primaryKey"] = [*(table["primaryKey"] or []), name]
                columns.append(name)
                references.append(parent["name"])
            if not columns:
                continue
            foreign_key = argument_of(given[0] if given else None, "foreignKey")
            constraint = string_of(argument_of(foreign_key, "name"))
            action = name_of(argument_of(annotation_of(field["annotations"], "OnDelete"), "action"))
            on_delete = _ACTIONS.get(action or "")
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
                    "attribute": field["name"],
                }
            )

            # The columns of a one-to-one relation are unique
            def same(items: list[str], columns: list[str] = columns) -> bool:
                return len(items) == len(columns) and all(item in columns for item in items)

            if (
                kind == "OneToOne"
                and not any(same(item["columns"]) for item in table["uniques"])
                and not same(table["primaryKey"] or [])
            ):
                table["uniques"].append({"columns": columns})
    # The other side of each relation: `@OneToMany(mappedBy = "order")` names the foreign key of Order.order
    for model in models:
        for field in model["fields"]:
            relation = annotation_of(field["annotations"], "OneToMany", "OneToOne")
            mapped_by = string_of(argument_of(relation, "mappedBy"))
            if relation is None or not mapped_by:
                continue
            target = by_class.get(_target_name(relation, field))
            key = (
                next((item for item in target["table"]["foreignKeys"] if item.get("attribute") == mapped_by), None)
                if target is not None
                else None
            )
            if key is None:
                continue
            if not key.get("inverse"):
                key["inverse"] = field["name"]
            # Rows the parent removes with it (cascade = ALL or REMOVE, orphanRemoval): deleted with their parent
            cascades = [name_of(item) for item in _items(argument_of(relation, "cascade"))]
            orphans = boolean_of(argument_of(relation, "orphanRemoval")) is True
            if not key.get("onDelete") and ("ALL" in cascades or "REMOVE" in cascades or orphans):
                key["onDelete"] = "cascade"
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": dialect,
        "source": {"kind": "orm", "format": "jpa"},
        "tables": [*(model["table"] for model in models), *joins],
        "enums": db_enums,
        "notes": notes,
    }


def _join_table_of(model: dict, target: dict, field: dict, join_table: dict | None, key_column) -> dict:
    """The join table of a `@ManyToMany`: as `@JoinTable` names it, or as JPA does (`<owner table>_<target table>`,
    with columns `<side>_<key>`), keyed by both columns."""
    name = string_of(argument_of(join_table, "name"))
    table = {
        "name": name if name is not None else f"{model['table']['name']}_{target['table']['name']}",
        "columns": [],
        "primaryKey": [],
        "foreignKeys": [],
        "uniques": [],
        "indexes": [],
        "checks": [],
        "origin": {"line": field["line"], "column": 1},
    }
    schema = string_of(argument_of(join_table, "schema"))
    if schema:
        table["schema"] = schema
    # The field on the other side that maps this relation names the owner's columns
    inverse = next(
        (
            item
            for item in target["fields"]
            if string_of(argument_of(annotation_of(item["annotations"], "ManyToMany"), "mappedBy")) == field["name"]
        ),
        None,
    )
    sides = (
        (
            calls_of(argument_of(join_table, "joinColumns")),
            model,
            inverse["name"] if inverse else model["cls"]["name"],
        ),
        (calls_of(argument_of(join_table, "inverseJoinColumns")), target, field["name"]),
    )
    for given, side, prefix in sides:
        count = len(given) if given else len(side["table"]["primaryKey"] or [])
        for position in range(count):
            join = given[position] if position < len(given) else None
            parent = key_column(side, string_of(argument_of(join, "referencedColumnName")), position)
            if parent is None:
                continue
            given_name = string_of(argument_of(join, "name"))
            column = given_name if given_name is not None else f"{prefix}_{parent['name']}"
            table["columns"].append({"name": column, "type": parent["type"], "nullable": False})
            table["primaryKey"].append(column)
            side_table = side["table"]
            table["foreignKeys"].append(
                {
                    "columns": [column],
                    "references": {
                        "table": side_table["name"],
                        **({"schema": side_table["schema"]} if side_table.get("schema") else {}),
                        "columns": [parent["name"]],
                    },
                }
            )
    return table


_PERSISTENCE = re.compile(r"\b(jakarta|javax)\.persistence\b")
_ENTITY = re.compile(r"@Entity\b")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if _PERSISTENCE.search(text) and _ENTITY.search(text) else 0


JPA_READER = OrmReader(id="jpa", label="JPA / Hibernate", language="java", detect=_detect, read=_read_jpa)
