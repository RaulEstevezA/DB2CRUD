"""Reads EF Core models into the physical schema: the entity classes (the `DbSet<…>` of a context, or the types
`Entity<…>` configures) with their properties and data annotations (`[Table]`, `[Column]`, `[Key]`, `[Required]`,
`[MaxLength]`, `[Precision]`, `[Index]`, `[ForeignKey]`, `[NotMapped]`…), and the fluent API of `OnModelCreating` or
of `IEntityTypeConfiguration<…>` (`ToTable`, `HasKey`, `Property(…)` with its column, type, length, defaults and
generated values, `HasIndex`, `HasAlternateKey`, check constraints, `HasOne`/`HasMany` relations with their keys and
delete behaviour). What the code leaves out follows EF Core's conventions: the table is the `DbSet` name, the key is
`Id` (numbered when it is an integer), a required relation deletes in cascade. The engine is the provider the code
uses (`UseNpgsql`, `UseSqlite`…), when it uses only one. Mirrors web/src/core/importers/orm/efcore.ts.

A property is {name, type, attributes, settable, line}; a class {name, kind, attributes, bases, properties, members,
line}; a step of a fluent chain {name, generic?, args, named}."""

import json
import re

from ...js import is_number, number_text
from ...schema.checks import check_of
from ..code.csharp import CSHARP_LEXER
from ..code.lexer import Cursor, LexError, tokenize
from .expressions import (
    boolean_of,
    literal_of,
    name_of,
    number_of,
    read_arguments,
    read_expression,
    string_of,
    text_of,
)
from .sql_types import sql_type_of
from .types import OrmReader

# C# names its arguments with `name: value`, and the properties of an attribute with `Name = value`
_NAMED = ":"
_ATTRIBUTE_NAMED = "="

# Reading the declarations


def _read_attributes(cursor: Cursor, source: str) -> list[dict]:
    """`[Key, MaxLength(20)]`, after its `[`: each attribute as a call."""
    attributes: list[dict] = []
    # `[return: …]`, `[assembly: …]`
    if cursor.is_ident() and cursor.is_(":", 1):
        cursor.next()
        cursor.next()
    while not cursor.done and not cursor.is_("]"):
        if not cursor.is_ident():
            cursor.next()
            continue
        path = [cursor.next().value]
        while cursor.is_(".") and cursor.is_ident(1):
            cursor.next()
            path.append(cursor.next().value)
        name = re.sub(r"Attribute$", "", path[-1])
        args: list = []
        named: dict = {}
        if cursor.is_("("):
            cursor.next()
            # `[Index(nameof(Name), IsUnique = true)]`: the properties of an attribute take `=`
            args, named = read_arguments(cursor, source, _ATTRIBUTE_NAMED, ")")
        attributes.append({"kind": "call", "callee": {"kind": "name", "path": [name]}, "args": args, "named": named})
        cursor.eat(",")
    cursor.eat("]")
    return attributes


_MODIFIERS = {
    "public",
    "private",
    "protected",
    "internal",
    "static",
    "readonly",
    "virtual",
    "override",
    "abstract",
    "sealed",
    "partial",
    "required",
    "new",
    "const",
    "unsafe",
    "extern",
    "async",
    "volatile",
    "file",
}
_DECLARATIONS = {"class", "record", "struct", "interface", "enum"}


def _skip_angles(cursor: Cursor) -> None:
    depth = 0
    while not cursor.done:
        value = cursor.next().value
        if value == "<":
            depth += 1
        elif value == ">":
            depth -= 1
        if depth == 0:
            break


def _skip_type(cursor: Cursor) -> None:
    """Skips a type as written: `Dictionary<string, List<int>>?[]`."""
    if cursor.is_("("):
        # A tuple
        cursor.skip_group()
    else:
        if cursor.is_ident():
            cursor.next()
        while cursor.is_(".") and cursor.is_ident(1):
            cursor.next()
            cursor.next()
        if cursor.is_("<"):
            _skip_angles(cursor)
    while cursor.is_("?") or (cursor.is_("[") and cursor.is_("]", 1)):
        if cursor.eat("?"):
            continue
        cursor.next()
        cursor.next()


def _skip_member(cursor: Cursor) -> None:
    """Moves past the rest of a member: up to its `;` or past its body."""
    while not cursor.done and not cursor.is_(";") and not cursor.is_("{") and not cursor.is_("}"):
        if cursor.is_("(") or cursor.is_("["):
            cursor.skip_group()
        else:
            cursor.next()
    if cursor.is_("{"):
        cursor.skip_group()
    else:
        cursor.eat(";")


def _read_declaration(cursor: Cursor, source: str, kind: str, attributes: list, classes: list) -> None:
    token = cursor.peek()
    line = token.line if token is not None else 1
    declaration = {
        "name": cursor.next().value,
        "kind": kind,
        "attributes": attributes,
        "bases": "",
        "properties": [],
        "members": [],
        "line": line,
    }
    while not cursor.done and not cursor.is_("{") and not cursor.is_(";"):
        if cursor.is_(":"):
            start = cursor.index + 1
            while not cursor.done and not cursor.is_("{") and not cursor.is_(";") and not cursor.is_("where"):
                if cursor.is_("("):
                    cursor.skip_group()
                else:
                    cursor.next()
            declaration["bases"] = cursor.text_between(source, start, cursor.index)
        elif cursor.is_("("):
            cursor.skip_group()
        else:
            cursor.next()
    classes.append(declaration)
    if not cursor.eat("{"):
        cursor.eat(";")
        return
    if kind == "enum":
        following = 0
        while not cursor.done and not cursor.is_("}"):
            if cursor.is_("["):
                cursor.skip_group()
                continue
            if not cursor.is_ident():
                cursor.next()
                continue
            name = cursor.next().value
            if cursor.eat("="):
                value = number_of(read_expression(cursor, source, _NAMED))
                if value is not None:
                    following = value
            declaration["members"].append({"name": name, "value": following})
            following += 1
            cursor.eat(",")
        cursor.eat("}")
        return
    _read_body(cursor, source, declaration, classes)
    cursor.eat("}")


_SETTABLE = re.compile(r"\b(set|init)\b")


def _read_body(cursor: Cursor, source: str, declaration: dict, classes: list) -> None:
    attributes: list = []
    while not cursor.done and not cursor.is_("}"):
        if cursor.is_("["):
            cursor.next()
            attributes.extend(_read_attributes(cursor, source))
            continue
        if cursor.value() in _MODIFIERS and cursor.is_ident():
            cursor.next()
            continue
        if cursor.value() in _DECLARATIONS and cursor.is_ident(1):
            kind = cursor.next().value
            _read_declaration(cursor, source, kind, attributes, classes)
            attributes = []
            continue
        if not cursor.is_ident() and not cursor.is_("("):
            if cursor.is_("{"):
                cursor.skip_group()
            else:
                cursor.next()
            attributes = []
            continue
        type_start = cursor.index
        _skip_type(cursor)
        written = re.sub(r"\s+", "", cursor.text_between(source, type_start, cursor.index))
        if not cursor.is_ident():
            # A constructor (`Name(…)`) or an operator
            _skip_member(cursor)
            attributes = []
            continue
        name = cursor.next()
        if cursor.is_("{"):
            # A property with accessors: `{ get; set; }`, maybe followed by `= value;`
            start = cursor.index
            cursor.skip_group()
            accessors = cursor.text_between(source, start, cursor.index)
            if cursor.eat("="):
                cursor.skip_until([";"])
            cursor.eat(";")
            declaration["properties"].append(
                {
                    "name": name.value,
                    "type": written,
                    "attributes": attributes,
                    "settable": bool(_SETTABLE.search(accessors)),
                    "line": name.line,
                }
            )
        else:
            _skip_member(cursor)
        attributes = []


def _read_classes(files: list[dict]) -> list[dict]:
    classes: list[dict] = []
    for file in files:
        try:
            tokens = tokenize(file["text"], CSHARP_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)
        attributes: list = []
        while not cursor.done:
            if cursor.is_("["):
                cursor.next()
                attributes.extend(_read_attributes(cursor, file["text"]))
            elif cursor.value() in _DECLARATIONS and cursor.is_ident() and cursor.is_ident(1):
                kind = cursor.next().value
                _read_declaration(cursor, file["text"], kind, attributes, classes)
                attributes = []
            elif cursor.is_("using") or cursor.is_("namespace"):
                cursor.skip_until([";", "{"])
                cursor.eat(";")
                cursor.eat("{")
            elif cursor.value() in _MODIFIERS:
                cursor.next()
            else:
                cursor.next()
                if not cursor.is_("["):
                    attributes = []
    return classes


# Reading the fluent API


def _read_chain(cursor: Cursor, source: str) -> list[dict]:
    """The chain after `builder.`: each call with its type argument and arguments, up to the end of the statement."""
    steps: list[dict] = []
    while cursor.is_ident():
        name = cursor.next().value
        generic = None
        if cursor.is_("<"):
            start = cursor.index + 1
            _skip_angles(cursor)
            generic = cursor.text_between(source, start, cursor.index - 1).strip()
        args: list = []
        named: dict = {}
        if cursor.is_("("):
            cursor.next()
            args, named = read_arguments(cursor, source, _NAMED, ")")
        steps.append({"name": name, **({"generic": generic} if generic else {}), "args": args, "named": named})
        if not cursor.eat("."):
            break
    return steps


def _read_block(cursor: Cursor, source: str, parameter: str) -> list[list[dict]]:
    """The statements of a lambda's block that start with its parameter: `entity.Property(…)…;`."""
    chains: list[list[dict]] = []
    cursor.next()
    while not cursor.done and not cursor.is_("}"):
        if cursor.is_(parameter) and cursor.is_(".", 1) and cursor.is_ident(2):
            cursor.next()
            cursor.next()
            chains.append(_read_chain(cursor, source))
            cursor.skip_until([";"])
            cursor.eat(";")
        elif cursor.is_("{") or cursor.is_("("):
            cursor.skip_group()
        else:
            cursor.next()
    cursor.eat("}")
    return chains


def _read_fluent(files: list[dict]) -> dict[str, list]:
    """Every chain that configures an entity, by its class: `modelBuilder.Entity<X>(e => { … })`,
    `modelBuilder.Entity<X>().…;` and `Configure(EntityTypeBuilder<X> builder) { … }`."""
    chains: dict[str, list] = {}

    def add(entity: str, found: list) -> None:
        chains[entity] = [*chains.get(entity, []), *found]

    for file in files:
        try:
            tokens = tokenize(file["text"], CSHARP_LEXER)
        except LexError:
            continue
        cursor = Cursor(tokens)

        def at(position: int, tokens: list = tokens):
            return tokens[position] if 0 <= position < len(tokens) else None

        def value_at(position: int) -> str | None:
            token = at(position)
            return token.value if token is not None else None

        for index, token in enumerate(tokens):
            generic_token = at(index + 2)
            generic_entity = (
                generic_token.value
                if value_at(index + 1) == "<"
                and generic_token is not None
                and generic_token.kind == "ident"
                and value_at(index + 3) == ">"
                else None
            )
            if token.value == "Entity" and value_at(index - 1) == "." and generic_entity and value_at(index + 4) == "(":
                cursor.index = index + 5
                if cursor.is_ident() and cursor.is_("=>", 1):
                    # Entity<X>(entity => { … }) or Entity<X>(entity => entity.…)
                    parameter = cursor.next().value
                    cursor.next()
                    if cursor.is_("{"):
                        add(generic_entity, _read_block(cursor, file["text"], parameter))
                    elif cursor.is_(parameter) and cursor.is_(".", 1):
                        cursor.next()
                        cursor.next()
                        add(generic_entity, [_read_chain(cursor, file["text"])])
                elif cursor.is_(")") and cursor.is_(".", 1):
                    cursor.next()
                    cursor.next()
                    add(generic_entity, [_read_chain(cursor, file["text"])])
            elif token.value == "EntityTypeBuilder" and generic_entity:
                parameter_token = at(index + 4)
                if parameter_token is None or parameter_token.kind != "ident":
                    continue
                # Configure(EntityTypeBuilder<X> builder) { … }
                cursor.index = index + 5
                cursor.eat(")")
                if cursor.is_("{"):
                    add(generic_entity, _read_block(cursor, file["text"], parameter_token.value))
    return chains


# The properties a lambda names

_ARROW_HEAD = re.compile(r"^[^=]*=>")
_MEMBER = re.compile(r"\.\s*(\w+)", re.ASCII)


def _properties_of(args: list) -> list[str]:
    """`e => e.Id` → [Id]; `e => new { e.OrderId, e.Line }` → [OrderId, Line]; `"Id"` → [Id]."""
    names: list[str] = []
    for arg in args:
        text = string_of(arg)
        if text is not None:
            names.append(text)
        elif arg["kind"] == "other":
            names.extend(_MEMBER.findall(_ARROW_HEAD.sub("", arg["text"], count=1)))
        elif arg["kind"] == "call" and name_of(arg) == "nameof":
            names.append((name_of(arg["args"][0]) if arg["args"] else None) or "")
    return [name for name in names if name]


# Types

_CS_TYPES = {
    "long": {"sql": "long", "kind": "integer", "bits": 64},
    "Int64": {"sql": "long", "kind": "integer", "bits": 64},
    "int": {"sql": "int", "kind": "integer", "bits": 32},
    "Int32": {"sql": "int", "kind": "integer", "bits": 32},
    "short": {"sql": "short", "kind": "integer", "bits": 16},
    "Int16": {"sql": "short", "kind": "integer", "bits": 16},
    "byte": {"sql": "byte", "kind": "integer", "bits": 16},
    "sbyte": {"sql": "sbyte", "kind": "integer", "bits": 16},
    "double": {"sql": "double", "kind": "float", "bits": 64},
    "Double": {"sql": "double", "kind": "float", "bits": 64},
    "float": {"sql": "float", "kind": "float", "bits": 32},
    "Single": {"sql": "float", "kind": "float", "bits": 32},
    "decimal": {"sql": "decimal", "kind": "decimal"},
    "Decimal": {"sql": "decimal", "kind": "decimal"},
    "bool": {"sql": "bool", "kind": "boolean"},
    "Boolean": {"sql": "bool", "kind": "boolean"},
    "string": {"sql": "string", "kind": "text"},
    "String": {"sql": "string", "kind": "text"},
    "DateTime": {"sql": "DateTime", "kind": "datetime", "timezone": False},
    "DateTimeOffset": {"sql": "DateTimeOffset", "kind": "datetime", "timezone": True},
    "DateOnly": {"sql": "DateOnly", "kind": "date"},
    "TimeOnly": {"sql": "TimeOnly", "kind": "time", "timezone": False},
    "TimeSpan": {"sql": "TimeSpan", "kind": "time", "timezone": False},
    "Guid": {"sql": "Guid", "kind": "uuid"},
    "byte[]": {"sql": "byte[]", "kind": "binary"},
    "char": {"sql": "char", "kind": "text", "length": 1, "fixed": True},
}

_NAMESPACE = re.compile(r"^(global::)?([\w]+\.)+(?=\w)", re.ASCII)
_ELEMENT = re.compile(
    r"^(?:I?List|I?Collection|ICollection|IEnumerable|HashSet|ISet|IReadOnlyCollection|IReadOnlyList)<\s*([\w.]+)\s*>\??$",
    re.ASCII,
)


def _bare_type(written: str) -> str:
    """The type without `?` and namespaces: `System.DateTime?` → `DateTime`."""
    return _NAMESPACE.sub("", re.sub(r"\?$", "", written), count=1)


def _element_type(written: str) -> str | None:
    """The element type of a collection navigation: `List<OrderLine>` → `OrderLine`."""
    match = _ELEMENT.match(written)
    return match.group(1) if match else None


_NOW_SQL = re.compile(
    r"now\(\)|current_timestamp(\(\d*\))?|localtimestamp|getdate\(\)|getutcdate\(\)|sysdatetime\(\)|datetime\('now'\)",
    re.IGNORECASE,
)
_UUID_SQL = re.compile(r"(gen_random_uuid|uuid_generate_v4|uuid|newid|newsequentialid)\(\)", re.IGNORECASE)

_DELETE_BEHAVIOURS = {
    "Cascade": "cascade",
    "Restrict": "restrict",
    "NoAction": "no action",
    "SetNull": "set null",
    "ClientSetNull": None,
    "ClientCascade": None,
    "ClientNoAction": None,
}

_PROVIDERS = (
    (re.compile(r"\bUseNpgsql\b|\bNpgsql\.EntityFrameworkCore\b"), "postgresql"),
    (re.compile(r"\bMariaDbServerVersion\b"), "mariadb"),
    (
        re.compile(r"\bUseMySql\b|\bUseMySQL\b|\bPomelo\.EntityFrameworkCore\.MySql\b|\bMySql\.EntityFrameworkCore\b"),
        "mysql",
    ),
    (re.compile(r"\bUseSqlite\b|\bMicrosoft\.EntityFrameworkCore\.Sqlite\b"), "sqlite"),
    (re.compile(r"\bUseSqlServer\b|\bMicrosoft\.EntityFrameworkCore\.SqlServer\b"), "sqlserver"),
    (re.compile(r"\bUseOracle\b|\bOracle\.EntityFrameworkCore\b"), "oracle"),
)

_DB_SET = re.compile(r"\bDbSet<\s*(\w+)\s*>\??\s+(\w+)", re.ASCII)
_HAS_CHECK = re.compile(r'HasCheckConstraint\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"')
_HAS_COMMENT = re.compile(r'HasComment\(\s*"((?:[^"\\]|\\.)*)"')
_TO_TABLE = re.compile(r'ToTable\(\s*"([^"]+)"')


def _quoted(values: list) -> str:
    return ", ".join(
        number_text(value) if is_number(value) else "'" + value.replace("'", "''") + "'" for value in values
    )


def _step_of(steps: list[dict], *names: str) -> dict | None:
    return next((step for step in steps if step["name"] in names), None)


def _attribute_of(attributes: list[dict], *names: str) -> dict | None:
    return next((item for item in attributes if (name_of(item) or "") in names), None)


def _first(item: dict | None, position: int = 0) -> dict | None:
    """An argument of a step or an attribute, by position."""
    if item is None or len(item["args"]) <= position:
        return None
    return item["args"][position]


def _coalesce(*values):
    return next((value for value in values if value is not None), None)


def _to_snake(name: str) -> str:
    """`OrderStatus` → `order_status`."""
    return re.sub(r"([a-z\d])([A-Z])", r"\1_\2", name).lower()


# Building the tables


def _read_efcore(files: list[dict]) -> dict:
    notes: list[dict] = []
    classes = _read_classes(files)
    by_name = {cls["name"]: cls for cls in classes}
    fluent = _read_fluent(files)
    text = "\n".join(file["text"] for file in files)
    dialects = [dialect for pattern, dialect in _PROVIDERS if pattern.search(text)]
    # MariaDB is used through the MySQL provider
    engines = set(item for item in dialects if item != "mysql") if "mariadb" in dialects else set(dialects)
    dialect = next(iter(engines)) if len(engines) == 1 else None
    db_enums: list[dict] = []

    # The entities: the DbSet<…> of the contexts (named by their property) and the types the fluent API configures
    set_names: dict[str, str] = {}
    for match in _DB_SET.finditer(text):
        set_names.setdefault(match.group(1), match.group(2))
    entity_names: list[str] = []
    for name in [*set_names, *fluent]:
        if name not in entity_names and (by_name.get(name) or {}).get("kind") != "enum":
            entity_names.append(name)
    entity_classes = [cls for cls in classes if cls["name"] in entity_names and cls["kind"] != "enum"]

    def is_entity(written: str) -> bool:
        return _bare_type(written) in entity_names

    def all_properties(cls: dict, seen: set | None = None) -> list[dict]:
        """The properties of a class and of the classes it extends that are not entities."""
        seen = seen if seen is not None else set()
        seen.add(cls["name"])
        first_base = cls["bases"].split(",")[0].strip() if cls["bases"] else ""
        base = by_name.get(re.sub(r"<.*$", "", first_base))
        inherited = (
            all_properties(base, seen)
            if base is not None and base["name"] not in seen and base["kind"] != "interface"
            else []
        )
        return [*inherited, *cls["properties"]]

    def enum_values(enum_class: dict, steps: list[dict]) -> tuple[list, bool]:
        """The values the database keeps for a property typed with a C# enum, from its conversion."""
        conversion = _step_of(steps, "HasConversion")
        if conversion is not None and conversion.get("generic") == "string":
            return [item["name"] for item in enum_class["members"]], True
        if conversion is not None:
            # A conversion through a method: the text each member is written as (`OrderStatus.Paid => "paid"`)
            pattern = re.compile(rf'\b{re.escape(enum_class["name"])}\.(\w+)\s*=>\s*"((?:[^"\\]|\\.)*)"')
            arms = {match.group(1): match.group(2) for match in pattern.finditer(text)}
            if all(item["name"] in arms for item in enum_class["members"]):
                return [arms[item["name"]] for item in enum_class["members"]], True
        return [item["value"] for item in enum_class["members"]], False

    models: list[dict] = []
    by_class: dict[str, dict] = {}
    never_generated: list[dict] = []
    for cls in entity_classes:
        chains = fluent.get(cls["name"], [])
        table_step = next((chain[0] for chain in chains if chain[0]["name"] == "ToTable"), None)
        table_attribute = _attribute_of(cls["attributes"], "Table")
        table = {
            "name": _coalesce(
                string_of(_first(table_step)),
                string_of(_first(table_attribute)),
                set_names.get(cls["name"]),
                cls["name"],
            ),
            "columns": [],
            "primaryKey": None,
            "foreignKeys": [],
            "uniques": [],
            "indexes": [],
            "checks": [],
            "entity": cls["name"],
            "origin": {"line": cls["line"], "column": 1},
        }
        schema = _coalesce(
            string_of(table_step["named"].get("schema")) if table_step else None,
            string_of(_first(table_step, 1)),
            string_of(table_attribute["named"].get("Schema")) if table_attribute else None,
        )
        if schema:
            table["schema"] = schema
        table_lambdas = [text_of(arg) for arg in (table_step["args"] if table_step else []) if arg["kind"] == "other"]
        lambda_comment = next(
            (match.group(1) for match in (_HAS_COMMENT.search(item) for item in table_lambdas) if match), None
        )
        comment_chain = next((chain for chain in chains if chain[0]["name"] == "HasComment"), None)
        comment = _coalesce(
            string_of(_first(comment_chain[0])) if comment_chain else None,
            json.loads(f'"{lambda_comment}"') if lambda_comment is not None else None,
            string_of(_first(_attribute_of(cls["attributes"], "Comment"))),
        )
        if comment:
            table["comment"] = comment
        # Check constraints of ToTable(…, t => t.HasCheckConstraint(…)) and of the entity
        check_texts = [
            *table_lambdas,
            *(
                f"HasCheckConstraint({', '.join(text_of(arg) for arg in chain[0]['args'])})"
                for chain in chains
                if chain[0]["name"] == "HasCheckConstraint"
            ),
        ]
        for source in check_texts:
            for match in _HAS_CHECK.finditer(source):
                table["checks"].append(check_of(json.loads(f'"{match.group(2)}"'), json.loads(f'"{match.group(1)}"')))

        ignored = {
            name for chain in chains if chain[0]["name"] == "Ignore" for name in _properties_of(chain[0]["args"])
        }
        configs: dict[str, list] = {}
        for chain in chains:
            if chain[0]["name"] == "Property":
                for name in _properties_of(chain[0]["args"]):
                    configs.setdefault(name, []).extend(chain[1:])
        properties = [
            item
            for item in all_properties(cls)
            if item["settable"]
            and item["name"] not in ignored
            and not _attribute_of(item["attributes"], "NotMapped")
            and not is_entity(item["type"])
            and not (_element_type(item["type"]) and is_entity(_element_type(item["type"])))
        ]
        model = {"cls": cls, "table": table, "columns": {}, "properties": properties, "chains": chains}

        # The key: HasKey, [Key], or the convention (Id, <Class>Id); HasNoKey or [Keyless] say there is none
        key_chain = next((chain for chain in chains if chain[0]["name"] == "HasKey"), None)
        no_key = any(chain[0]["name"] == "HasNoKey" for chain in chains) or bool(
            _attribute_of(cls["attributes"], "Keyless")
        )
        annotated_keys = [item["name"] for item in properties if _attribute_of(item["attributes"], "Key")]
        if no_key:
            key_properties: list[str] = []
        elif key_chain is not None:
            key_properties = _properties_of(key_chain[0]["args"])
        elif annotated_keys:
            key_properties = annotated_keys
        else:
            key_properties = [
                item["name"]
                for item in properties
                if item["name"].lower() == "id" or item["name"].lower() == f"{cls['name'].lower()}id"
            ][:1]

        for prop in properties:
            steps = configs.get(prop["name"], [])
            column_attribute = _attribute_of(prop["attributes"], "Column")
            name = _coalesce(
                string_of(_first(_step_of(steps, "HasColumnName"))), string_of(_first(column_attribute)), prop["name"]
            )
            column_type = _coalesce(
                string_of(_first(_step_of(steps, "HasColumnType"))),
                string_of(column_attribute["named"].get("TypeName")) if column_attribute else None,
            )
            max_length = _coalesce(
                number_of(_first(_step_of(steps, "HasMaxLength"))),
                number_of(_first(_attribute_of(prop["attributes"], "MaxLength", "StringLength"))),
            )
            precision_step = _step_of(steps, "HasPrecision")
            precision_attribute = _attribute_of(prop["attributes"], "Precision")
            precision = _coalesce(number_of(_first(precision_step)), number_of(_first(precision_attribute)))
            scale = _coalesce(number_of(_first(precision_step, 1)), number_of(_first(precision_attribute, 1)))
            bare = _bare_type(prop["type"])
            enum_class = by_name.get(bare)
            column_kind = None
            if column_type:
                column_kind = sql_type_of(column_type, dialect)
                if column_kind is not None and column_kind["kind"] == "text" and "length" not in column_kind:
                    if max_length is not None:
                        column_kind = {**column_kind, "length": max_length}
                if column_kind is not None:
                    column_kind = {**column_kind, "sql": column_type}
            elif enum_class is not None and enum_class["kind"] == "enum":
                values, as_text = enum_values(enum_class, steps)
                if as_text:
                    column_kind = {
                        "sql": prop["type"],
                        "kind": "text",
                        **({"length": max_length} if max_length is not None else {}),
                    }
                    enum_name = _to_snake(enum_class["name"])
                    if not any(item["name"] == enum_name for item in db_enums):
                        db_enums.append(
                            {
                                "name": enum_name,
                                "values": [value if isinstance(value, str) else number_text(value) for value in values],
                                "storage": "check",
                            }
                        )
                else:
                    column_kind = {"sql": prop["type"], "kind": "integer", "bits": 32}
                declared = any(
                    (check.get("parsed") or {}).get("kind") == "in" and check["parsed"]["column"] == name
                    for check in table["checks"]
                )
                if not declared:
                    table["checks"].append(check_of(f"{name} IN ({_quoted(values)})"))
            elif bare in _CS_TYPES:
                column_kind = {**_CS_TYPES[bare], "sql": prop["type"]}
                if column_kind["kind"] == "text" and max_length is not None:
                    column_kind = {**column_kind, "length": max_length}
                if column_kind["kind"] == "text" and _step_of(steps, "IsFixedLength"):
                    column_kind = {**column_kind, "fixed": True}
                if column_kind["kind"] == "binary" and max_length is not None:
                    column_kind = {**column_kind, "length": max_length}
                if column_kind["kind"] == "decimal":
                    column_kind = {
                        **column_kind,
                        **({"precision": precision} if precision is not None else {}),
                        **({"scale": scale} if scale is not None else {}),
                    }
            if column_kind is None:
                notes.append(
                    {
                        "code": "orm.unknownType",
                        "params": {"table": table["name"], "column": name, "type": column_type or prop["type"]},
                    }
                )
            is_key = prop["name"] in key_properties
            required_step = _step_of(steps, "IsRequired")
            required = boolean_of(_first(required_step)) is not False if required_step is not None else None
            if is_key:
                nullable = False
            elif required is not None:
                nullable = not required
            elif _attribute_of(prop["attributes"], "Required"):
                nullable = False
            else:
                nullable = prop["type"].endswith("?")
            column = {
                "name": name,
                "type": column_kind
                if column_kind is not None
                else {"sql": column_type or prop["type"], "kind": "unknown"},
                "nullable": nullable,
            }
            default_value = _first(_step_of(steps, "HasDefaultValue"))
            if default_value is not None:
                value = literal_of(default_value)
                if (
                    default_value["kind"] == "name"
                    and len(default_value["path"]) == 2
                    and enum_class is not None
                    and enum_class["kind"] == "enum"
                ):
                    values, _as_text = enum_values(enum_class, steps)
                    index = next(
                        (
                            position
                            for position, item in enumerate(enum_class["members"])
                            if item["name"] == default_value["path"][1]
                        ),
                        -1,
                    )
                    if index >= 0:
                        column["default"] = {"kind": "literal", "value": values[index]}
                elif default_value["kind"] == "name" and default_value["path"] == ["null"]:
                    column["default"] = {"kind": "literal", "value": None}
                elif value is not None:
                    column["default"] = {"kind": "literal", "value": value}
            default_sql = string_of(_first(_step_of(steps, "HasDefaultValueSql")))
            if default_sql is not None:
                if _NOW_SQL.fullmatch(default_sql.strip()):
                    column["generated"] = "now"
                elif _UUID_SQL.fullmatch(default_sql.strip()):
                    column["generated"] = "uuid"
                else:
                    column["default"] = {"kind": "expression", "sql": default_sql}
            computed = string_of(_first(_step_of(steps, "HasComputedColumnSql")))
            if computed:
                column["generated"] = {"computed": computed}
            generated_attribute = name_of(_first(_attribute_of(prop["attributes"], "DatabaseGenerated")))
            identity_step = _step_of(
                steps, "UseIdentityColumn", "UseIdentityAlwaysColumn", "UseIdentityByDefaultColumn", "UseSerialColumn"
            )
            if identity_step is not None or generated_attribute == "Identity":
                column["generated"] = "identity"
            if _step_of(steps, "ValueGeneratedOnAdd") and not column.get("generated"):
                kind = column["type"]["kind"]
                generated = "uuid" if kind == "uuid" else "identity" if kind == "integer" else None
                if generated:
                    column["generated"] = generated
            if not column.get("generated"):
                column.pop("generated", None)
            if _step_of(steps, "ValueGeneratedNever") or generated_attribute == "None":
                never_generated.append(column)
            column_comment = _coalesce(
                string_of(_first(_step_of(steps, "HasComment"))),
                string_of(_first(_attribute_of(prop["attributes"], "Comment"))),
            )
            if column_comment:
                column["comment"] = column_comment
            if name != prop["name"]:
                column["attribute"] = prop["name"]
            table["columns"].append(column)
            model["columns"][prop["name"]] = name
        if key_properties:
            table["primaryKey"] = [model["columns"].get(item, item) for item in key_properties]
        models.append(model)
        by_class[cls["name"]] = model

    # Indexes and alternate keys
    for model in models:
        table = model["table"]

        def columns_of(names: list[str], model: dict = model) -> list[str]:
            return [model["columns"].get(name, name) for name in names]

        for chain in model["chains"]:
            first, rest = chain[0], chain[1:]
            if first["name"] not in ("HasIndex", "HasAlternateKey"):
                continue
            columns = columns_of(_properties_of(first["args"]))
            if not columns:
                continue
            name = string_of(_first(_step_of(rest, "HasDatabaseName", "HasName")))
            unique_step = _step_of(rest, "IsUnique")
            unique = first["name"] == "HasAlternateKey" or (
                unique_step is not None and boolean_of(_first(unique_step)) is not False
            )
            (table["uniques"] if unique else table["indexes"]).append(
                {**({"name": name} if name else {}), "columns": columns}
            )
        for attribute in [item for item in model["cls"]["attributes"] if name_of(item) == "Index"]:
            columns = columns_of(_properties_of(attribute["args"]))
            if not columns:
                continue
            name = string_of(attribute["named"].get("Name"))
            target = table["uniques"] if boolean_of(attribute["named"].get("IsUnique")) is True else table["indexes"]
            target.append({**({"name": name} if name else {}), "columns": columns})

    # Relations: the fluent API first, then the navigations it does not configure
    configured: set[str] = set()
    joins: list[dict] = []

    def add_key(
        dependent: dict, principal: dict, key_properties: list[str], principal_properties: list[str], **options
    ) -> None:
        principal_table = principal["table"]
        if principal_properties:
            principal_columns = [principal["columns"].get(name, name) for name in principal_properties]
        else:
            principal_columns = principal_table["primaryKey"] or []
        dependent_table = dependent["table"]
        columns: list[str] = []
        for position, prop in enumerate(key_properties):
            column = dependent["columns"].get(prop)
            if not column:
                # A shadow property: the column exists in the database but not in the class
                wanted = principal_columns[position] if position < len(principal_columns) else None
                parent = next((item for item in principal_table["columns"] if item["name"] == wanted), None)
                column = prop
                if not any(item["name"] == column for item in dependent_table["columns"]):
                    dependent_table["columns"].append(
                        {
                            "name": column,
                            "type": parent["type"] if parent is not None else {"sql": "", "kind": "unknown"},
                            "nullable": options.get("required") is not True,
                        }
                    )
                dependent["columns"][prop] = column
            columns.append(column)
        if not columns:
            return
        if any(item["columns"] == columns for item in dependent_table["foreignKeys"]):
            return
        nullable = any(
            next((item for item in dependent_table["columns"] if item["name"] == column), {}).get("nullable")
            for column in columns
        )
        required = options.get("required")
        required = required if required is not None else not nullable
        # EF Core deletes the rows of a required relation with their parent unless told otherwise
        on_delete = options.get("onDelete", "unset")
        if on_delete is None:
            on_delete = None
        elif on_delete == "unset":
            on_delete = "cascade" if required else None
        key = {
            **({"name": options["name"]} if options.get("name") else {}),
            "columns": columns,
            "references": {
                "table": principal_table["name"],
                **({"schema": principal_table["schema"]} if principal_table.get("schema") else {}),
                "columns": principal_columns,
            },
            **({"onDelete": on_delete} if on_delete else {}),
            **({"attribute": options["attribute"]} if options.get("attribute") else {}),
            **({"inverse": options["inverse"]} if options.get("inverse") else {}),
        }
        dependent_table["foreignKeys"].append(key)

        def same(items: list[str]) -> bool:
            return len(items) == len(columns) and all(item in columns for item in items)

        if (
            options.get("unique")
            and not any(same(item["columns"]) for item in dependent_table["uniques"])
            and not same(dependent_table["primaryKey"] or [])
        ):
            dependent_table["uniques"].append({"columns": columns})

    def navigation_target(model: dict, navigation: str | None) -> str | None:
        prop = next((item for item in model["cls"]["properties"] if item["name"] == navigation), None)
        if prop is None:
            return None
        return _element_type(prop["type"]) or _bare_type(prop["type"])

    def behaviour(steps: list[dict]):
        """The delete behaviour a chain gives: an action, None (the client's), or "unset" when it gives none."""
        step = _step_of(steps, "OnDelete")
        if step is None:
            return "unset"
        name = name_of(_first(step)) or ""
        return _DELETE_BEHAVIOURS[name] if name in _DELETE_BEHAVIOURS else "unset"

    for model in models:
        for chain in model["chains"]:
            first, rest = chain[0], chain[1:]
            if first["name"] not in ("HasOne", "HasMany"):
                continue
            navigations = _properties_of(first["args"])
            navigation = navigations[0] if navigations else None
            other = by_class.get(first.get("generic") or navigation_target(model, navigation) or "")
            if other is None:
                continue
            with_step = _step_of(rest, "WithMany", "WithOne")
            inverses = _properties_of(with_step["args"]) if with_step is not None else []
            inverse = inverses[0] if inverses else None
            foreign_key = _step_of(rest, "HasForeignKey")
            principal_key = _step_of(rest, "HasPrincipalKey")
            name = string_of(_first(_step_of(rest, "HasConstraintName")))
            required_step = _step_of(rest, "IsRequired")
            required = boolean_of(_first(required_step)) is not False if required_step is not None else None
            if first["name"] == "HasMany" and with_step is not None and with_step["name"] == "WithMany":
                using = _step_of(rest, "UsingEntity")
                using_text = " ".join(text_of(arg) for arg in using["args"]) if using is not None else ""
                to_table = _TO_TABLE.search(using_text)
                join_name = _coalesce(
                    string_of(_first(using)),
                    to_table.group(1) if to_table else None,
                    f"{model['cls']['name']}{other['cls']['name']}",
                )
                if not any(item["name"] == join_name for item in joins):
                    joins.append(_join_table_of(join_name, model, other, navigation, inverse))
                configured.add(f"{model['cls']['name']}.{navigation}")
                if inverse:
                    configured.add(f"{other['cls']['name']}.{inverse}")
                continue
            # HasOne(…).WithMany(…): the key is on this entity; HasMany(…).WithOne(…): on the other one. A one-to-one
            # relation says where with HasForeignKey<Dependent>
            has_one = first["name"] == "HasOne"
            dependent = model if has_one else other
            principal = other if has_one else model
            if (
                has_one
                and with_step is not None
                and with_step["name"] == "WithOne"
                and foreign_key
                and foreign_key.get("generic")
            ):
                dependent = by_class.get(foreign_key["generic"], model)
                principal = other if dependent is model else model
            if dependent is model:
                dependent_navigation = navigation if has_one else inverse
                principal_navigation = inverse if has_one else navigation
            else:
                dependent_navigation = inverse if has_one else navigation
                principal_navigation = navigation if has_one else inverse
            if foreign_key is not None:
                key_properties = _properties_of(foreign_key["args"])
            else:
                key_properties = _convention_key(dependent, principal, dependent_navigation)
            options = {"onDelete": behaviour(rest), "unique": with_step is not None and with_step["name"] == "WithOne"}
            if name:
                options["name"] = name
            if dependent_navigation:
                options["attribute"] = dependent_navigation
            if principal_navigation:
                options["inverse"] = principal_navigation
            if required is not None:
                options["required"] = required
            add_key(
                dependent,
                principal,
                key_properties,
                _properties_of(principal_key["args"]) if principal_key is not None else [],
                **options,
            )
            if dependent_navigation:
                configured.add(f"{dependent['cls']['name']}.{dependent_navigation}")
            if principal_navigation:
                configured.add(f"{principal['cls']['name']}.{principal_navigation}")
    # Navigations by convention: a reference to an entity has its key in this table; a collection, in the other one
    for model in models:
        for prop in all_properties(model["cls"]):
            if f"{model['cls']['name']}.{prop['name']}" in configured or _attribute_of(prop["attributes"], "NotMapped"):
                continue
            collection = _element_type(prop["type"])
            target = by_class.get(collection or _bare_type(prop["type"]))
            if target is None or not (collection or is_entity(prop["type"])):
                continue

            def points_back(item: dict, model: dict = model, target: dict = target) -> bool:
                pointed = _element_type(item["type"]) or _bare_type(item["type"])
                return pointed == model["cls"]["name"] and f"{target['cls']['name']}.{item['name']}" not in configured

            inverse = next((item for item in target["cls"]["properties"] if points_back(item)), None)
            if collection:
                # A collection with a reference on the other side is configured from that side
                if inverse is not None:
                    continue
                add_key(target, model, _convention_key(target, model, None), [], inverse=prop["name"], required=False)
            else:
                key_attribute = string_of(_first(_attribute_of(prop["attributes"], "ForeignKey")))
                annotated = next(
                    (
                        item
                        for item in model["properties"]
                        if string_of(_first(_attribute_of(item["attributes"], "ForeignKey"))) == prop["name"]
                    ),
                    None,
                )
                if key_attribute:
                    key_properties = [item.strip() for item in key_attribute.split(",")]
                elif annotated is not None:
                    key_properties = [annotated["name"]]
                else:
                    key_properties = _convention_key(model, target, prop["name"])
                options = {"attribute": prop["name"]}
                if inverse is not None:
                    options["inverse"] = inverse["name"]
                add_key(model, target, key_properties, [], **options)
                if inverse is not None:
                    configured.add(f"{target['cls']['name']}.{inverse['name']}")
            configured.add(f"{model['cls']['name']}.{prop['name']}")
    # EF Core numbers a key of one integer column (and fills a Guid one) unless told not to, or it is a foreign key
    for model in models:
        table = model["table"]
        if not table["primaryKey"] or len(table["primaryKey"]) != 1:
            continue
        key = next((item for item in table["columns"] if item["name"] == table["primaryKey"][0]), None)
        if key is None or key.get("generated") or any(key is item for item in never_generated):
            continue
        if any(key["name"] in item["columns"] for item in table["foreignKeys"]):
            continue
        if key["type"]["kind"] == "integer":
            key["generated"] = "identity"
        elif key["type"]["kind"] == "uuid":
            key["generated"] = "uuid"
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": dialect,
        "source": {"kind": "orm", "format": "efcore"},
        "tables": [*(model["table"] for model in models), *joins],
        "enums": db_enums,
        "notes": notes,
    }


def _convention_key(dependent: dict, principal: dict, navigation: str | None) -> list[str]:
    """The key EF Core finds by convention: `<navigation><key>`, `<navigation>Id`, `<principal><key>` or
    `<principal>Id`, a shadow `<navigation><key>` when the class has none of them."""
    keys = principal["table"]["primaryKey"] or []
    names = [item["name"].lower() for item in dependent["properties"]]
    found_keys: list[str] = []
    for column in keys:
        key = next((prop for prop, name in principal["columns"].items() if name == column), column)
        candidates = [
            *([f"{navigation}{key}", f"{navigation}Id"] if navigation else []),
            f"{principal['cls']['name']}{key}",
            f"{principal['cls']['name']}Id",
        ]
        found = next((item for item in candidates if item.lower() in names), None)
        if found is not None:
            found_keys.append(
                next(item["name"] for item in dependent["properties"] if item["name"].lower() == found.lower())
            )
        else:
            found_keys.append(candidates[0])
    return found_keys


def _join_table_of(
    name: str, left: dict, right: dict, left_navigation: str | None, right_navigation: str | None
) -> dict:
    """The join table of a many-to-many relation: `<Entity><Entity>` (or as `UsingEntity` names it), with a column
    `<navigation><key>` to each side, keyed by both and deleted with either row."""
    table = {
        "name": name,
        "columns": [],
        "primaryKey": [],
        "foreignKeys": [],
        "uniques": [],
        "indexes": [],
        "checks": [],
    }
    sides = ((left, right_navigation or left["cls"]["name"]), (right, left_navigation or right["cls"]["name"]))
    for side, prefix in sides:
        side_table = side["table"]
        key = side_table["primaryKey"][0] if side_table["primaryKey"] else None
        parent = next((item for item in side_table["columns"] if item["name"] == key), None)
        if parent is None:
            continue
        prop = next((prop for prop, column in side["columns"].items() if column == parent["name"]), parent["name"])
        column = f"{prefix}{prop}"
        table["columns"].append({"name": column, "type": parent["type"], "nullable": False})
        table["primaryKey"].append(column)
        table["foreignKeys"].append(
            {
                "columns": [column],
                "references": {
                    "table": side_table["name"],
                    **({"schema": side_table["schema"]} if side_table.get("schema") else {}),
                    "columns": [parent["name"]],
                },
                "onDelete": "cascade",
            }
        )
    table["indexes"].extend({"columns": [column["name"]]} for column in table["columns"][1:])
    return table


_EF = re.compile(r"\bMicrosoft\.EntityFrameworkCore\b")
_CONTEXT = re.compile(r"\b(DbContext|DbSet<|IEntityTypeConfiguration<)")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if _EF.search(text) and _CONTEXT.search(text) else 0


EFCORE_READER = OrmReader(id="efcore", label="EF Core", language="csharp", detect=_detect, read=_read_efcore)
