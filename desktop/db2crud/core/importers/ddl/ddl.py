"""Reads SQL DDL into the physical schema: `CREATE TABLE` (columns with their types, `NOT NULL`, defaults, identity and
computed columns, comments, and the constraints of a column or of the table), `CREATE INDEX`, `CREATE TYPE … AS
ENUM`, `ALTER TABLE` (constraints, columns, defaults and identities added or dropped) and `COMMENT ON`, as PostgreSQL,
MySQL, MariaDB and SQLite write them, also in the dumps of `pg_dump --schema-only` and `mysqldump --no-data`. Anything
else (functions, triggers, views, grants, settings) is left out. The engine is the one the text is written for, when
it shows (`SERIAL`, `AUTO_INCREMENT`, `AUTOINCREMENT`…), or the one given. Mirrors web/src/core/importers/ddl/ddl.ts."""

import re

from ...js import is_number, number
from ...schema.checks import check_of
from ..code.lexer import LexerConfig, LexError, StringRule, Token, tokenize
from ..orm.sql_types import sql_type_of

_SQL = LexerConfig(
    line_comments=("--", "#"),
    block_comments=(("/*", "*/"),),
    strings=(
        StringRule("'", "'", False, True),
        StringRule('"', '"', False, False),
        StringRule("`", "`", False, False),
        StringRule("[", "]", False, False),
    ),
)

_DOLLAR = re.compile(r"\$(\w*)\$[\s\S]*?\$\1\$")
_DELIMITER = re.compile(
    r"^[ \t]*DELIMITER[ \t]+(?!;)\S+[ \t]*$[\s\S]*?^[ \t]*DELIMITER[ \t]+;[ \t]*$", re.MULTILINE | re.IGNORECASE
)
_GO = re.compile(r"^[ \t]*GO[ \t]*$", re.MULTILINE | re.IGNORECASE)


def _prepare(text: str) -> str:
    """The text with what the lexer does not need blanked out, keeping every position: dollar-quoted bodies
    (PostgreSQL functions), `DELIMITER` blocks (MySQL triggers) and `#` comments that are not MySQL's."""

    def blank(match: re.Match) -> str:
        return re.sub(r"[^\n]", " ", match.group(0))

    text = _DOLLAR.sub(blank, text)
    text = _DELIMITER.sub(blank, text)
    return _GO.sub(lambda match: ";" + " " * max(0, len(match.group(0)) - 1), text)


# Statements as tokens


def _statements_of(text: str) -> tuple[list[list[Token]], str]:
    """The statements of the text, split at each `;` outside brackets, with the text they come from."""
    source = _prepare(text)
    try:
        tokens = tokenize(source, _SQL)
    except LexError:
        return [], source
    statements: list[list[Token]] = []
    current: list[Token] = []
    depth = 0
    for token in tokens:
        if token.kind == "punct" and token.value == "(":
            depth += 1
        if token.kind == "punct" and token.value == ")":
            depth = max(0, depth - 1)
        if token.kind == "punct" and token.value == ";" and depth == 0:
            if current:
                statements.append(current)
            current = []
            continue
        current.append(token)
    if current:
        statements.append(current)
    return statements, source


def _is_text(token: Token | None, source: str) -> bool:
    """A token that is a literal text: `'…'` (the other quotes name things)."""
    return token is not None and token.kind == "string" and source[token.start] == "'"


def _is_name(token: Token | None, source: str) -> bool:
    """A token that names something: a word, or a quoted name."""
    return token is not None and (token.kind == "ident" or (token.kind == "string" and source[token.start] != "'"))


def _word(token: Token | None) -> str:
    return token.value.upper() if token is not None and token.kind == "ident" else ""


class _Reader:
    """A cursor over the tokens of one statement."""

    def __init__(self, tokens: list[Token], source: str):
        self.index = 0
        self.tokens = tokens
        self.source = source

    @property
    def done(self) -> bool:
        return self.index >= len(self.tokens)

    def peek(self, offset: int = 0) -> Token | None:
        position = self.index + offset
        return self.tokens[position] if 0 <= position < len(self.tokens) else None

    def word(self, offset: int = 0) -> str:
        """The word at the cursor (upper case), or ''."""
        return _word(self.peek(offset))

    def is_word(self, *words: str) -> bool:
        return self.word() in words

    def is_(self, punct: str, offset: int = 0) -> bool:
        token = self.peek(offset)
        return token is not None and token.kind == "punct" and token.value == punct

    def next(self) -> Token | None:
        token = self.peek()
        self.index += 1
        return token

    def eat(self, *words: str) -> bool:
        """Moves past these words, in order, when they all come next."""
        if not all(self.word(position) == item for position, item in enumerate(words)):
            return False
        self.index += len(words)
        return True

    def eat_punct(self, punct: str) -> bool:
        if not self.is_(punct):
            return False
        self.index += 1
        return True

    def qualified_name(self) -> list[str]:
        """A name, maybe qualified (`public.orders`): its parts."""
        parts: list[str] = []
        if not _is_name(self.peek(), self.source):
            return parts
        parts.append(self.next().value)
        while self.is_(".") and _is_name(self.peek(1), self.source):
            self.next()
            parts.append(self.next().value)
        return parts

    def group(self) -> list[Token]:
        """The tokens of a group in brackets at the cursor, without them; the cursor moves past it."""
        if not self.is_("("):
            return []
        self.index += 1
        start = self.index
        depth = 1
        while not self.done:
            token = self.next()
            if token.kind == "punct" and token.value == "(":
                depth += 1
            if token.kind == "punct" and token.value == ")":
                depth -= 1
                if depth == 0:
                    return self.tokens[start : self.index - 1]
        return self.tokens[start:]

    def text(self, tokens: list[Token]) -> str:
        """The source text of some tokens."""
        return self.source[tokens[0].start : tokens[-1].end] if tokens else ""


def _items_of(tokens: list[Token]) -> list[list[Token]]:
    """The items of a list in brackets, split at each `,` outside brackets."""
    items: list[list[Token]] = [[]]
    depth = 0
    for token in tokens:
        if token.kind == "punct" and token.value == "(":
            depth += 1
        if token.kind == "punct" and token.value == ")":
            depth -= 1
        if token.kind == "punct" and token.value == "," and depth == 0:
            items.append([])
        else:
            items[-1].append(token)
    return [item for item in items if item]


def _columns_of(tokens: list[Token], source: str) -> list[str] | None:
    """The columns a list names: `(a, "b" DESC, c(10))`; None when one is an expression."""
    columns: list[str] = []
    for item in _items_of(tokens):
        if not _is_name(item[0], source):
            return None
        # A length (`c(10)`, MySQL), then an order, a collation or an operator class may follow the name
        rest = item[1:]
        if rest and rest[0].kind == "punct" and rest[0].value == "(":
            if len(rest) < 3 or rest[1].kind != "number" or rest[2].kind != "punct" or rest[2].value != ")":
                return None
            rest = rest[3:]
        if not all(token.kind == "ident" or _is_name(token, source) for token in rest):
            return None
        columns.append(item[0].value)
    return columns


# Types

_DEFAULT_SCHEMAS = {"public", "dbo", "main", "pg_catalog"}

_ALIASES = {
    "int2": "smallint",
    "int4": "integer",
    "int8": "bigint",
    "float4": "real",
    "float8": "double precision",
    "bool": "boolean",
    "double precision": "double precision",
    "datetime2": "datetime",
    "smalldatetime": "datetime",
    "datetimeoffset": "timestamptz",
    "timestamp without time zone": "timestamp",
    "time without time zone": "time",
    "timestamp with time zone": "timestamptz",
    "time with time zone": "timetz",
    "character": "char",
    "character varying": "varchar",
    "national character varying": "nvarchar",
    "bit varying": "varbinary",
    "mediumblob": "blob",
    "tinyblob": "blob",
    "longblob": "blob",
    "binary": "binary",
    "tinytext": "text",
    "mediumtext": "text",
    "longtext": "text",
    "ntext": "text",
    "clob": "text",
    "string": "text",
    "number": "numeric",
    "dec": "decimal",
    "fixed": "decimal",
    "long": "text",
}

_ARRAY = re.compile(r"(\[\s*\d*\s*\])+$|\sarray$")
_INLINE = re.compile(r"^(enum|set)\s*\(([\s\S]*)\)", re.IGNORECASE)
_QUOTED = re.compile(r"'((?:[^']|'')*)'")
_SERIAL = re.compile(r"(small|big)?serial[248]?")
_SIZED = re.compile(r"([a-z][a-z0-9_ ]*?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)\s*([a-z ]*)")


def _type_of(text: str, dialect: str | None, enums: dict, table: str, column: str) -> dict | None:
    """The type of a column as written: `character varying(120)`, `timestamp(3) with time zone`, `int unsigned`.
    The result is {type, enumValues?, identity?}."""
    sql = text.strip()
    lower = re.sub(r"\s+", " ", sql.lower())
    # Arrays: `text[]`, `integer ARRAY`
    array = _ARRAY.search(lower)
    if array:
        items = _type_of(sql[: array.start()], dialect, enums, table, column)
        return {"type": {"sql": sql, "kind": "array", "items": items["type"]}} if items else None
    # MySQL enums and sets: `enum('a','b')`
    inline = _INLINE.match(sql)
    if inline:
        values = [match.group(1).replace("''", "'") for match in _QUOTED.finditer(inline.group(2))]
        if inline.group(1).lower() == "set":
            return {"type": {"sql": sql, "kind": "text"}}
        return {"type": {"sql": sql, "kind": "enum", "name": f"{table}_{column}"}, "enumValues": values}
    lower = re.sub(r"\s+(unsigned|signed|zerofill)\b", "", lower)
    lower = re.sub(r"\s+(character set|charset|collate)\s+\S+", "", lower).strip()
    # A type of the schema: an enum made with CREATE TYPE
    named = enums.get(lower.split(".")[-1].replace('"', ""))
    if named is not None:
        return {"type": {"sql": sql, "kind": "enum", "name": named["name"]}}
    serial = _SERIAL.fullmatch(lower)
    if serial:
        if serial.group(1) == "small" or lower == "serial2":
            bits = 16
        elif serial.group(1) == "big" or lower == "serial8":
            bits = 64
        else:
            bits = 32
        return {"type": {"sql": sql, "kind": "integer", "bits": bits}, "identity": True}
    if dialect in ("mysql", "mariadb") and re.fullmatch(r"tinyint\s*\(\s*1\s*\)", lower):
        return {"type": {"sql": sql, "kind": "boolean"}}
    if re.fullmatch(r"bit(\s*\(\s*1\s*\))?", lower):
        return {"type": {"sql": sql, "kind": "boolean"}}
    if lower == "year":
        return {"type": {"sql": sql, "kind": "integer", "bits": 16}}
    if lower in ("money", "smallmoney"):
        return {"type": {"sql": sql, "kind": "decimal"}}
    if re.fullmatch(r"(n?varchar|varchar2|nvarchar2)\s*\(\s*max\s*\)", lower):
        return {"type": {"sql": sql, "kind": "text"}}
    if re.fullmatch(r"(varbinary)\s*\(\s*max\s*\)", lower):
        return {"type": {"sql": sql, "kind": "binary"}}
    # The size may come before the words that end the name: `timestamp(3) with time zone`
    sized = _SIZED.fullmatch(lower)
    if sized:
        base = re.sub(r"\s+", " ", f"{sized.group(1)} {sized.group(4)}".strip())
        args = f"({sized.group(2)}{f', {sized.group(3)}' if sized.group(3) is not None else ''})"
    else:
        base = lower
        args = ""
    name = _ALIASES.get(base, base)
    found = sql_type_of(f"{name}{args}", dialect)
    return {"type": {**found, "sql": sql}} if found else None


_NOW_SQL = re.compile(
    r"now\(\)|current_timestamp(\s*\(\s*\d*\s*\))?|localtimestamp(\(\d*\))?|getdate\(\)|getutcdate\(\)"
    r"|sysdatetime\(\)|datetime\('now'\)|\(datetime\('now'\)\)|\(?unixepoch\(\)\)?",
    re.IGNORECASE,
)
_UUID_SQL = re.compile(
    r"gen_random_uuid\(\)|uuid_generate_v4\(\)|uuid\(\)|newid\(\)|newsequentialid\(\)", re.IGNORECASE
)
_WRAPPED = re.compile(r"\((?:[^()]|\([^()]*\))*\)")
_CAST = re.compile(r"('(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s*::\s*[\w .\"\[\]]+")


def _default_of(text: str, dialect: str | None) -> dict:
    """A default as written: a literal, the time, a new UUID, a sequence (an identity) or an expression. The
    result is {default?} or {generated?}."""
    sql = text.strip()
    while _WRAPPED.fullmatch(sql):
        sql = sql[1:-1].strip()
    # PostgreSQL casts: `'draft'::status`, `'{}'::jsonb`
    cast = _CAST.fullmatch(sql)
    if cast:
        sql = cast.group(1)
    if re.match(r"nextval\(", sql, re.IGNORECASE):
        return {"generated": "identity"}
    if _NOW_SQL.fullmatch(sql):
        return {"generated": "now"}
    if _UUID_SQL.fullmatch(sql):
        return {"generated": "uuid"}
    if re.fullmatch(r"null", sql, re.IGNORECASE):
        return {"default": {"kind": "literal", "value": None}}
    if re.fullmatch(r"true|false", sql, re.IGNORECASE):
        return {"default": {"kind": "literal", "value": sql.lower() == "true"}}
    if re.fullmatch(r"b'[01]'", sql, re.IGNORECASE):
        return {"default": {"kind": "literal", "value": sql[2] == "1"}}
    if re.fullmatch(r"[+-]?\d+(\.\d+)?", sql):
        return {"default": {"kind": "literal", "value": number(sql)}}
    if re.fullmatch(r"[EN]?'(?:[^']|'')*'", sql, re.IGNORECASE):
        return {
            "default": {
                "kind": "literal",
                "value": re.sub(r"^[EN]", "", sql, flags=re.IGNORECASE)[1:-1].replace("''", "'"),
            }
        }
    # MySQL writes texts in double quotes too
    if dialect in ("mysql", "mariadb") and re.fullmatch(r'"(?:[^"]|"")*"', sql):
        return {"default": {"kind": "literal", "value": sql[1:-1].replace('""', '"')}}
    return {"default": {"kind": "expression", "sql": sql}}


_ACTIONS = {
    "CASCADE": "cascade",
    "SET NULL": "set null",
    "SET DEFAULT": "set default",
    "RESTRICT": "restrict",
    "NO ACTION": "no action",
}

# What the text is written for

_MARKS = (
    (
        re.compile(
            r"\b(big|small)?serial\b|::\s*\w|\btimestamptz\b|\bjsonb\b|\bbytea\b|\bcreate\s+type\s+\S+\s+as\s+enum\b"
            r"|\bnextval\s*\(|\bpg_catalog\b|\bowner\s+to\b",
            re.IGNORECASE,
        ),
        "postgresql",
    ),
    (re.compile(r"-- MariaDB dump|/\*M!|\bmariadb\b", re.IGNORECASE), "mariadb"),
    (
        re.compile(
            r"`\w+`|\bauto_increment\b|\bengine\s*=|\btinyint\s*\(\s*1\s*\)|\bunsigned\b|/\*!\d{5}", re.IGNORECASE
        ),
        "mysql",
    ),
    (re.compile(r"\bautoincrement\b|\bwithout\s+rowid\b|\bpragma\b|\bsqlite_sequence\b", re.IGNORECASE), "sqlite"),
    (
        re.compile(
            r"\bidentity\s*\(\s*\d+\s*,\s*\d+\s*\)|\bnvarchar\b|^\s*go\s*$|\[\w+\]\.\[\w+\]",
            re.IGNORECASE | re.MULTILINE,
        ),
        "sqlserver",
    ),
)


def ddl_dialect(text: str) -> str | None:
    """The engine the DDL is written for, when it shows: the first mark found, MariaDB before MySQL."""
    clean = _prepare(text)
    return next((dialect for pattern, dialect in _MARKS if pattern.search(clean)), None)


# Reading the statements


def _find_table(builder: dict, parts: list[str]) -> dict | None:
    name = parts[-1] if parts else None
    return next((table for table in builder["tables"] if table["name"] == name), None)


def _schema_of(parts: list[str]) -> str | None:
    return parts[-2] if len(parts) > 1 and parts[-2].lower() not in _DEFAULT_SCHEMAS else None


def _read_reference(reader: _Reader, columns: list[str], builder: dict, name: str | None = None) -> dict:
    """`REFERENCES parent (id) ON DELETE CASCADE`, at the cursor after REFERENCES."""
    target = reader.qualified_name()
    referenced = (_columns_of(reader.group(), reader.source) or []) if reader.is_("(") else []
    schema = _schema_of(target)
    key = {
        **({"name": name} if name else {}),
        "columns": columns,
        "references": {
            "table": target[-1] if target else "",
            **({"schema": schema} if schema else {}),
            "columns": referenced,
        },
    }
    while not reader.done:
        if reader.eat("ON", "DELETE") or reader.eat("ON", "UPDATE"):
            which = "onDelete" if _word(reader.tokens[reader.index - 1]) == "DELETE" else "onUpdate"
            if reader.eat("SET", "NULL"):
                action = "SET NULL"
            elif reader.eat("SET", "DEFAULT"):
                action = "SET DEFAULT"
            elif reader.eat("NO", "ACTION"):
                action = "NO ACTION"
            else:
                action = _word(reader.next())
            if action in _ACTIONS:
                key[which] = _ACTIONS[action]
        elif reader.eat("MATCH"):
            reader.next()
        elif reader.is_word("DEFERRABLE", "NOT", "INITIALLY", "IMMEDIATE", "DEFERRED", "ENFORCED", "VALID"):
            reader.next()
        else:
            break
    if not referenced:
        builder["pending"].append((key, key["references"]["table"]))
    return key


_CONSTRAINT_WORDS = {
    "NOT",
    "NULL",
    "DEFAULT",
    "PRIMARY",
    "UNIQUE",
    "REFERENCES",
    "CHECK",
    "CONSTRAINT",
    "GENERATED",
    "AUTO_INCREMENT",
    "AUTOINCREMENT",
    "IDENTITY",
    "COLLATE",
    "COMMENT",
    "ON",
    "AS",
    "VISIBLE",
    "INVISIBLE",
    "STORAGE",
    "COLUMN_FORMAT",
    "SRID",
    "KEY",
}


def _read_column(tokens: list[Token], source: str, table: dict, builder: dict) -> None:
    """One column of CREATE TABLE or ALTER TABLE … ADD COLUMN: its name, type and constraints."""
    reader = _Reader(tokens, source)
    name = reader.next().value
    type_start = reader.index
    depth = 0
    while not reader.done:
        token = reader.peek()
        if token.kind == "punct" and token.value == "(":
            depth += 1
        if token.kind == "punct" and token.value == ")":
            depth -= 1
        if depth == 0 and token.kind == "ident" and token.value.upper() in _CONSTRAINT_WORDS:
            # `CHARACTER SET x` and `WITH TIME ZONE` belong to the type; `ON UPDATE` does not
            break
        reader.next()
    type_text = reader.text(tokens[type_start : reader.index])
    read = _type_of(type_text, builder["dialect"], builder["enums"], table["name"], name) if type_text else None
    if read is None:
        builder["notes"].append(
            {"code": "ddl.unknownType", "params": {"table": table["name"], "column": name, "type": type_text}}
        )
    column = {"name": name, "type": read["type"] if read else {"sql": type_text, "kind": "unknown"}, "nullable": True}
    if read and read.get("enumValues") is not None:
        enum_name = read["type"]["name"]
        if enum_name not in builder["enums"]:
            builder["enums"][enum_name] = {"name": enum_name, "values": read["enumValues"], "storage": "native"}
    if read and read.get("identity"):
        column["generated"] = "identity"
        column["nullable"] = False
    constraint = None
    while not reader.done:
        if reader.eat("CONSTRAINT"):
            token = reader.next()
            constraint = token.value if token is not None else None
            continue
        if reader.eat("NOT", "NULL"):
            column["nullable"] = False
        elif reader.eat("NULL"):
            column["nullable"] = True
        elif reader.eat("DEFAULT"):
            start = reader.index
            level = 0
            while not reader.done:
                token = reader.peek()
                if token.kind == "punct" and token.value == "(":
                    level += 1
                if token.kind == "punct" and token.value == ")":
                    level -= 1
                if (
                    level == 0
                    and reader.index > start
                    and token.kind == "ident"
                    and token.value.upper() in _CONSTRAINT_WORDS
                    and token.value.upper() != "ON"
                ):
                    break
                if level == 0 and reader.index > start and reader.eat("ON", "UPDATE"):
                    reader.index -= 2
                    break
                reader.next()
            value = _default_of(reader.text(tokens[start : reader.index]), builder["dialect"])
            if value.get("generated"):
                column["generated"] = value["generated"]
            elif value.get("default") and column.get("generated") != "identity":
                column["default"] = value["default"]
        elif reader.eat("PRIMARY", "KEY"):
            column["nullable"] = False
            table["primaryKey"] = [name]
            if not reader.eat("ASC"):
                reader.eat("DESC")
            # SQLite numbers an INTEGER PRIMARY KEY declared on its column (it is the rowid)
            rowid = builder["dialect"] == "sqlite" and type_text.strip().lower() == "integer"
            if reader.eat("AUTOINCREMENT") or rowid:
                column["generated"] = "identity"
        elif reader.eat("UNIQUE"):
            reader.eat("KEY")
            table["uniques"].append({**({"name": constraint} if constraint else {}), "columns": [name]})
        elif reader.eat("REFERENCES"):
            table["foreignKeys"].append(_read_reference(reader, [name], builder, constraint))
        elif reader.eat("CHECK"):
            table["checks"].append(check_of(reader.text(reader.group()), constraint))
        elif reader.eat("GENERATED"):
            if (
                reader.eat("ALWAYS", "AS", "IDENTITY")
                or reader.eat("BY", "DEFAULT", "AS", "IDENTITY")
                or reader.eat("BY", "DEFAULT", "ON", "NULL", "AS", "IDENTITY")
            ):
                column["generated"] = "identity"
                column["nullable"] = False
                if reader.is_("("):
                    reader.group()
            elif reader.eat("ALWAYS", "AS"):
                column["generated"] = {"computed": reader.text(reader.group()).strip()}
                if not reader.eat("STORED"):
                    reader.eat("VIRTUAL")
        elif reader.eat("AS"):
            # MySQL and SQLite: `AS (expression) [STORED|VIRTUAL]`
            column["generated"] = {"computed": reader.text(reader.group()).strip()}
            if not reader.eat("STORED") and not reader.eat("VIRTUAL"):
                reader.eat("PERSISTENT")
        elif reader.eat("AUTO_INCREMENT") or reader.eat("AUTOINCREMENT"):
            column["generated"] = "identity"
        elif reader.eat("IDENTITY"):
            column["generated"] = "identity"
            if reader.is_("("):
                reader.group()
        elif reader.eat("ON", "UPDATE"):
            start = reader.index
            reader.next()
            if reader.is_("("):
                reader.group()
            if _NOW_SQL.fullmatch(reader.text(tokens[start : reader.index])):
                column["generated"] = "onUpdateNow"
        elif reader.eat("COMMENT"):
            token = reader.next()
            if _is_text(token, source):
                column["comment"] = token.value
        elif reader.eat("COLLATE"):
            reader.next()
        else:
            reader.next()
        if not reader.is_word("CONSTRAINT"):
            constraint = None
    if column.get("generated") in ("now", "onUpdateNow", "uuid"):
        column.pop("default", None)
    # MySQL dumps write numbers in quotes: `DEFAULT '0.00'`, and booleans as `'1'`
    default = column.get("default")
    value = default["value"] if default is not None and default["kind"] == "literal" else None
    if isinstance(value, str) and re.fullmatch(r"[+-]?\d+(\.\d+)?", value):
        kind = column["type"]["kind"]
        if kind in ("integer", "decimal", "float"):
            column["default"] = {"kind": "literal", "value": number(value)}
        elif kind == "boolean" and value in ("0", "1"):
            column["default"] = {"kind": "literal", "value": value == "1"}
    default = column.get("default")
    if (
        column["type"]["kind"] == "boolean"
        and default is not None
        and default["kind"] == "literal"
        and is_number(default["value"])
        and default["value"] in (0, 1)
    ):
        column["default"] = {"kind": "literal", "value": default["value"] == 1}
    table["columns"].append(column)


def _read_constraint(reader: _Reader, table: dict, builder: dict) -> bool:
    """A constraint of the table (CREATE TABLE or ALTER TABLE … ADD): PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK, or a
    MySQL KEY/INDEX. Returns False when the item is not one."""
    start = reader.index
    name = None
    if reader.eat("CONSTRAINT"):
        if _is_name(reader.peek(), reader.source) and not reader.is_word("PRIMARY", "UNIQUE", "FOREIGN", "CHECK"):
            name = reader.next().value
    if reader.eat("PRIMARY", "KEY"):
        if _is_name(reader.peek(), reader.source) and not reader.is_("("):
            reader.next()
        if reader.eat("USING"):
            reader.next()
        columns = _columns_of(reader.group(), reader.source)
        if columns is not None:
            table["primaryKey"] = columns
            for column in table["columns"]:
                if column["name"] in columns:
                    column["nullable"] = False
        return True
    if reader.is_word("UNIQUE"):
        reader.next()
        if not reader.eat("KEY"):
            reader.eat("INDEX")
        if _is_name(reader.peek(), reader.source) and not reader.is_("("):
            name = reader.next().value
        if reader.eat("USING"):
            reader.next()
        columns = _columns_of(reader.group(), reader.source)
        if columns is not None:
            table["uniques"].append({**({"name": name} if name else {}), "columns": columns})
        return True
    if reader.eat("FOREIGN", "KEY"):
        if _is_name(reader.peek(), reader.source) and not reader.is_("("):
            token = reader.next()
            name = name if name is not None else token.value
        columns = _columns_of(reader.group(), reader.source) or []
        if reader.eat("REFERENCES"):
            table["foreignKeys"].append(_read_reference(reader, columns, builder, name))
        return True
    if reader.eat("CHECK"):
        table["checks"].append(check_of(reader.text(reader.group()), name))
        return True
    if not name and reader.is_word("KEY", "INDEX"):
        reader.next()
        if _is_name(reader.peek(), reader.source) and not reader.is_("("):
            name = reader.next().value
        if reader.eat("USING"):
            reader.next()
        columns = _columns_of(reader.group(), reader.source)
        if columns is not None:
            table["indexes"].append({**({"name": name} if name else {}), "columns": columns})
        return True
    if not name and reader.is_word("FULLTEXT", "SPATIAL", "EXCLUDE", "LIKE", "PERIOD"):
        return True
    reader.index = start
    return False


def _create_table(reader: _Reader, builder: dict) -> None:
    reader.eat("IF", "NOT", "EXISTS")
    parts = reader.qualified_name()
    if not parts or not reader.is_("("):
        return
    schema = _schema_of(parts)
    table = {
        "name": parts[-1],
        **({"schema": schema} if schema else {}),
        "columns": [],
        "primaryKey": None,
        "foreignKeys": [],
        "uniques": [],
        "indexes": [],
        "checks": [],
        "origin": {"line": reader.tokens[0].line, "column": reader.tokens[0].column},
    }
    for item in _items_of(reader.group()):
        inner = _Reader(item, reader.source)
        if not _read_constraint(inner, table, builder):
            _read_column(item, reader.source, table, builder)
    # Table options: MySQL's COMMENT='…'
    while not reader.done:
        if reader.eat("COMMENT"):
            reader.eat_punct("=")
            token = reader.next()
            if _is_text(token, reader.source):
                table["comment"] = token.value
        else:
            reader.next()
    builder["tables"] = [
        item for item in builder["tables"] if item["name"] != table["name"] or item.get("schema") != table.get("schema")
    ]
    builder["tables"].append(table)


def _create_index(reader: _Reader, unique: bool, builder: dict) -> None:
    reader.eat("CONCURRENTLY")
    reader.eat("IF", "NOT", "EXISTS")
    names = reader.qualified_name() if not reader.is_word("ON") else []
    name = names[-1] if names else None
    if not reader.eat("ON"):
        return
    reader.eat("ONLY")
    table = _find_table(builder, reader.qualified_name())
    if reader.eat("USING"):
        reader.next()
    columns = _columns_of(reader.group(), reader.source)
    if table is None:
        return
    if columns is None:
        builder["notes"].append(
            {"code": "ddl.expressionIndex", "params": {"table": table["name"], **({"index": name} if name else {})}}
        )
        return
    (table["uniques"] if unique else table["indexes"]).append({**({"name": name} if name else {}), "columns": columns})


def _alter_table(reader: _Reader, builder: dict) -> None:
    reader.eat("IF", "EXISTS")
    reader.eat("ONLY")
    table = _find_table(builder, reader.qualified_name())
    if table is None:
        return
    for item in _items_of(reader.tokens[reader.index :]):
        action = _Reader(item, reader.source)
        if action.eat("ADD"):
            if _read_constraint(action, table, builder):
                continue
            if action.is_word("INDEX", "KEY"):
                continue
            action.eat("COLUMN")
            action.eat("IF", "NOT", "EXISTS")
            _read_column(item[action.index :], reader.source, table, builder)
        elif action.eat("ALTER"):
            action.eat("COLUMN")
            target = action.peek()
            column = next(
                (entry for entry in table["columns"] if target is not None and entry["name"] == target.value), None
            )
            action.next()
            if column is None:
                continue
            if action.eat("SET", "DEFAULT"):
                value = _default_of(action.text(item[action.index :]), builder["dialect"])
                column.pop("default", None)
                if value.get("generated"):
                    column["generated"] = value["generated"]
                elif value.get("default"):
                    column["default"] = value["default"]
            elif action.eat("DROP", "DEFAULT"):
                column.pop("default", None)
            elif action.eat("SET", "NOT", "NULL"):
                column["nullable"] = False
            elif action.eat("DROP", "NOT", "NULL"):
                column["nullable"] = True
            elif action.eat("ADD", "GENERATED"):
                column["generated"] = "identity"
        elif action.eat("DROP"):
            if action.eat("CONSTRAINT"):
                action.eat("IF", "EXISTS")
                token = action.next()
                name = token.value if token is not None else None
                table["checks"] = [entry for entry in table["checks"] if entry.get("name") != name]
                table["uniques"] = [entry for entry in table["uniques"] if entry.get("name") != name]
                table["foreignKeys"] = [entry for entry in table["foreignKeys"] if entry.get("name") != name]
            elif action.eat("PRIMARY", "KEY"):
                table["primaryKey"] = None
            else:
                action.eat("COLUMN")
                action.eat("IF", "EXISTS")
                token = action.next()
                name = token.value if token is not None else None
                table["columns"] = [entry for entry in table["columns"] if entry["name"] != name]
        elif action.eat("MODIFY") or action.eat("CHANGE"):
            # MySQL: the column again, whole (CHANGE names it twice)
            action.eat("COLUMN")
            changed = _word(item[0]) == "CHANGE"
            token = action.next()
            old = token.value if token is not None else None
            position = next((index for index, entry in enumerate(table["columns"]) if entry["name"] == old), -1)
            if position < 0:
                continue
            rest = item[action.index :] if changed else item[action.index - 1 :]
            scratch = {**table, "columns": []}
            _read_column(rest, reader.source, scratch, builder)
            if scratch["columns"]:
                table["columns"][position] = scratch["columns"][0]


def _comment_on(reader: _Reader, builder: dict) -> None:
    """`COMMENT ON TABLE t IS '…'`, `COMMENT ON COLUMN t.c IS '…'`."""
    kind = reader.word()
    reader.next()
    parts = reader.qualified_name()
    if not reader.eat("IS"):
        return
    token = reader.next()
    text = token.value if _is_text(token, reader.source) else None
    if kind == "TABLE":
        table = _find_table(builder, parts)
        if table is not None and text:
            table["comment"] = text
    elif kind == "COLUMN":
        table = _find_table(builder, parts[:-1])
        column = (
            next((item for item in table["columns"] if item["name"] == parts[-1]), None) if table is not None else None
        )
        if column is not None and text:
            column["comment"] = text


def read_ddl(text: str, dialect: str | None = None) -> dict:
    """The schema the DDL declares. `dialect` is the engine when the caller knows it."""
    builder = {
        "dialect": dialect if dialect is not None else ddl_dialect(text),
        "tables": [],
        "enums": {},
        "notes": [],
        "pending": [],
    }
    statements, source = _statements_of(text)
    for tokens in statements:
        reader = _Reader(tokens, source)
        if reader.eat("CREATE"):
            reader.eat("OR", "REPLACE")
            while reader.is_word("TEMP", "TEMPORARY", "UNLOGGED", "GLOBAL", "LOCAL", "VIRTUAL"):
                reader.next()
            if reader.eat("TABLE"):
                _create_table(reader, builder)
            elif reader.eat("UNIQUE"):
                if not reader.eat("CLUSTERED"):
                    reader.eat("NONCLUSTERED")
                if reader.eat("INDEX"):
                    _create_index(reader, True, builder)
            elif reader.eat("CLUSTERED", "INDEX") or reader.eat("NONCLUSTERED", "INDEX") or reader.eat("INDEX"):
                _create_index(reader, False, builder)
            elif reader.eat("TYPE"):
                parts = reader.qualified_name()
                if reader.eat("AS", "ENUM") and parts:
                    values = [token.value for token in reader.group() if _is_text(token, reader.source)]
                    builder["enums"][parts[-1]] = {"name": parts[-1], "values": values, "storage": "native"}
        elif reader.eat("ALTER", "TABLE"):
            _alter_table(reader, builder)
        elif reader.eat("COMMENT", "ON"):
            _comment_on(reader, builder)
    # References with no columns point to the key of their table
    for key, table_name in builder["pending"]:
        target = next((item for item in builder["tables"] if item["name"] == table_name), None)
        if target is not None and target["primaryKey"]:
            key["references"]["columns"] = list(target["primaryKey"])
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": builder["dialect"],
        "source": {"kind": "ddl", "format": f"{builder['dialect'] or 'sql'}-ddl"},
        "tables": builder["tables"],
        "enums": list(builder["enums"].values()),
        "notes": builder["notes"],
    }


_CREATE_TABLE = re.compile(r"\bcreate\s+(?:(?:global|local|temporary|temp|unlogged)\s+)*table\b", re.IGNORECASE)


def detect_ddl(text: str) -> int:
    """How likely the text is SQL DDL: it creates a table."""
    return 1 if _CREATE_TABLE.search(_prepare(text)) else 0
