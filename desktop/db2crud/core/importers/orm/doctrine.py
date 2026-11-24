"""Reads Doctrine ORM entities, mapped with PHP attributes, into the physical schema: classes marked `#[ORM\\Entity]`
with the fields of their `#[ORM\\MappedSuperclass]` bases and of their `#[ORM\\Embedded]` parts, `#[ORM\\Table]`,
`#[ORM\\Index]` and `#[ORM\\UniqueConstraint]`, `#[ORM\\Column]` (type, length, precision, nullable, unique, options,
`columnDefinition`, `enumType`) or the PHP type of the property, keys and generated values, foreign keys of
`#[ORM\\ManyToOne]` and `#[ORM\\OneToOne]` with their `#[ORM\\JoinColumn]`, join tables of `#[ORM\\ManyToMany]`, PHP
enums, and the types a project registers on top of DBAL's. Names nobody gave follow Doctrine's default naming
strategy. Doctrine keeps no CHECK constraints but those of enums: a note says so. The engine is the one the
connection names (a URL or a driver), when it names only one. Mirrors web/src/core/importers/orm/doctrine.ts.

A property is {name, type, attributes, initializer?, line}; a class {name, kind, attributes, base, properties,
constants, cases, line}."""

import re

from ...js import is_number, number_text
from ...schema.checks import check_of
from .expressions import boolean_of, literal_of, name_of, number_of, string_of
from .php import class_of, entries_of, read_classes
from .sql_types import sql_type_of
from .types import OrmReader

# Reading the attributes


def _attribute_of(attributes: list, *names: str) -> dict | None:
    return next((item for item in attributes if (name_of(item) or "") in names), None)


def _argument_of(attribute: dict | None, name: str, position: int | None = None) -> dict | None:
    if attribute is None or attribute["kind"] != "call":
        return None
    found = attribute["named"].get(name)
    if found is None and position is not None and len(attribute["args"]) > position:
        found = attribute["args"][position]
    return found


def _name_in(expr: dict | None) -> str | None:
    """A name of the database: Doctrine quotes those written between backticks."""
    name = string_of(expr)
    return name[1:-1] if name is not None and len(name) > 1 and name[0] == name[-1] == "`" else name


def _strings_of(expr: dict | None) -> list[str]:
    items = expr["items"] if expr is not None and expr["kind"] == "list" else []
    return [value for value in (_name_in(item) for item in items) if value is not None]


def _simple_type(written: str) -> str:
    """The simple name of a PHP type: `?\\DateTimeImmutable` → `DateTimeImmutable`; `int|null` → `int`."""
    parts = [item for item in re.sub(r"^\?", "", written).split("|") if item.lower() != "null"]
    return parts[0].split("\\")[-1] if parts else ""


# Types


def _type_of_name(name: str, column: dict | None, dialect: str | None) -> dict | None:
    """The type a DBAL type name stands for: `datetimetz_immutable`, `string`."""
    kind = re.sub(r"_(im)?mutable$", "", name.lower())
    options = entries_of(_argument_of(column, "options"))
    length = number_of(_argument_of(column, "length"))
    sql = name
    if kind == "integer":
        return {"sql": sql, "kind": "integer", "bits": 64 if dialect == "sqlite" else 32}
    if kind == "smallint":
        return {"sql": sql, "kind": "integer", "bits": 16}
    if kind == "bigint":
        return {"sql": sql, "kind": "integer", "bits": 64}
    if kind == "boolean":
        return {"sql": sql, "kind": "boolean"}
    if kind == "decimal":
        precision = number_of(_argument_of(column, "precision"))
        scale = number_of(_argument_of(column, "scale"))
        return {
            "sql": sql,
            "kind": "decimal",
            **({"precision": precision} if precision is not None else {}),
            **({"scale": scale} if scale is not None else {}),
        }
    if kind == "float":
        return {"sql": sql, "kind": "float", "bits": 64}
    if kind == "smallfloat":
        return {"sql": sql, "kind": "float", "bits": 32}
    if kind in ("string", "ascii_string"):
        size = length if length is not None else 255
        if boolean_of(options.get("fixed")) is True:
            return {"sql": sql, "kind": "text", "length": size, "fixed": True}
        return {"sql": sql, "kind": "text", "length": size}
    if kind in ("text", "simple_array"):
        return {"sql": sql, "kind": "text"}
    if kind == "guid":
        return {"sql": sql, "kind": "uuid"}
    if kind == "json":
        return {"sql": sql, "kind": "json"}
    if kind == "date":
        return {"sql": sql, "kind": "date"}
    if kind == "time":
        return {"sql": sql, "kind": "time", "timezone": False}
    if kind == "datetime":
        return {"sql": sql, "kind": "datetime", "timezone": False}
    if kind == "datetimetz":
        return {"sql": sql, "kind": "datetime", "timezone": True}
    if kind == "binary":
        return (
            {"sql": sql, "kind": "binary", "length": length} if length is not None else {"sql": sql, "kind": "binary"}
        )
    if kind == "blob":
        return {"sql": sql, "kind": "binary"}
    return None


# The DBAL types a project's own types extend: `PreciseDateTimeTzType extends DateTimeTzImmutableType`
_BASE_TYPES = {
    "IntegerType": "integer",
    "SmallIntType": "smallint",
    "BigIntType": "bigint",
    "BooleanType": "boolean",
    "DecimalType": "decimal",
    "FloatType": "float",
    "SmallFloatType": "smallfloat",
    "StringType": "string",
    "AsciiStringType": "ascii_string",
    "TextType": "text",
    "GuidType": "guid",
    "JsonType": "json",
    "DateType": "date",
    "DateImmutableType": "date",
    "TimeType": "time",
    "TimeImmutableType": "time",
    "DateTimeType": "datetime",
    "DateTimeImmutableType": "datetime",
    "DateTimeTzType": "datetimetz",
    "DateTimeTzImmutableType": "datetimetz",
    "BinaryType": "binary",
    "BlobType": "blob",
}

# The DBAL type of a PHP type, when the column names none
_PHP_TYPES = {
    "int": "integer",
    "string": "string",
    "bool": "boolean",
    "float": "float",
    "DateTime": "datetime",
    "DateTimeImmutable": "datetime_immutable",
    "DateTimeInterface": "datetime",
    "array": "json",
}

_NOW_SQL = re.compile(r"now\(\)|current_timestamp(\(\d*\))?|localtimestamp|datetime\('now'\)", re.IGNORECASE)
_UUID_SQL = re.compile(r"(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)", re.IGNORECASE)

_ACTIONS = {
    "CASCADE": "cascade",
    "SET NULL": "set null",
    "SET DEFAULT": "set default",
    "RESTRICT": "restrict",
    "NO ACTION": "no action",
}

_DRIVERS = (
    (re.compile(r"['\"](?:pdo_)?pgsql['\"]|['\"](?:postgres(?:ql)?|pgsql)://"), "postgresql"),
    (re.compile(r"['\"]mariadb://"), "mariadb"),
    (re.compile(r"['\"](?:pdo_)?mysqli?['\"]|['\"]mysql://"), "mysql"),
    (re.compile(r"['\"](?:pdo_)?sqlite3?['\"]|['\"]sqlite3?://"), "sqlite"),
    (re.compile(r"['\"](?:pdo_)?sqlsrv['\"]|['\"](?:sqlsrv|mssql)://"), "sqlserver"),
    (re.compile(r"['\"](?:pdo_)?oci8?['\"]|['\"]oci8?://"), "oracle"),
)

_DEFINITION_TAIL = re.compile(
    r"\s+(not\s+null|null|default\b.*|generated\b.*|primary\s+key.*|unique.*)$", re.IGNORECASE
)
_COMPUTED = re.compile(r"\bgenerated\s+always\s+as\s*\(([\s\S]*)\)\s*(stored|virtual)?\s*$", re.IGNORECASE)


def _quoted(values: list) -> str:
    return ", ".join(
        number_text(value) if is_number(value) else "'" + value.replace("'", "''") + "'" for value in values
    )


def _to_snake(name: str) -> str:
    """`OrderStatus` → `order_status`."""
    return re.sub(r"([a-z\d])([A-Z])", r"\1_\2", name).lower()


_RELATIONS = ("ManyToOne", "OneToOne", "OneToMany", "ManyToMany")

# Building the tables


def _read_doctrine(files: list[dict]) -> dict:
    notes: list[dict] = []
    classes = read_classes(files)
    by_name = {cls["name"]: cls for cls in classes}
    text = "\n".join(file["text"] for file in files)
    found = [dialect for pattern, dialect in _DRIVERS if pattern.search(text)]
    dialect = found[0] if len(set(found)) == 1 else None
    db_enums: list[dict] = []

    # The project's own types: `const NAME = 'precise_datetimetz'` in a class that extends a DBAL type
    custom_types: dict[str, str] = {}
    for cls in classes:
        name = string_of(cls["constants"].get("NAME"))
        base = _BASE_TYPES.get(cls["base"]) if cls["base"] else None
        if name and base:
            custom_types[name] = base

    def properties_of(cls: dict, seen: set | None = None) -> list[dict]:
        """The properties of a class and of the `#[ORM\\MappedSuperclass]` classes it extends."""
        seen = seen if seen is not None else set()
        seen.add(cls["name"])
        base = by_name.get(cls["base"]) if cls["base"] else None
        inherited = (
            properties_of(base, seen)
            if base is not None and base["name"] not in seen and _attribute_of(base["attributes"], "MappedSuperclass")
            else []
        )
        return [*inherited, *cls["properties"]]

    models: list[dict] = []
    by_class: dict[str, dict] = {}
    for cls in classes:
        if not _attribute_of(cls["attributes"], "Entity"):
            continue
        table_attribute = _attribute_of(cls["attributes"], "Table")
        table_name = _name_in(_argument_of(table_attribute, "name", 0))
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
        schema = string_of(_argument_of(table_attribute, "schema"))
        if schema:
            table["schema"] = schema
        comment = string_of(entries_of(_argument_of(table_attribute, "options")).get("comment"))
        if comment:
            table["comment"] = comment
        model = {"cls": cls, "table": table, "columns": {}, "properties": properties_of(cls)}
        primary: list[str] = []

        def add_column(
            prop: dict,
            prefix: str,
            attribute_prefix: str,
            table: dict = table,
            model: dict = model,
            primary: list = primary,
        ) -> None:
            embedded = _attribute_of(prop["attributes"], "Embedded")
            if embedded is not None:
                part = by_name.get(class_of(_argument_of(embedded, "class", 0)) or _simple_type(prop["type"]))
                if part is None:
                    return
                given = _argument_of(embedded, "columnPrefix")
                if boolean_of(given) is False:
                    own = ""
                else:
                    own = string_of(given)
                    own = own if own is not None else f"{prop['name']}_"
                for inner in properties_of(part):
                    add_column(inner, f"{prefix}{own}", f"{attribute_prefix}{prop['name']}.")
                return
            column = _attribute_of(prop["attributes"], "Column")
            if column is None:
                return
            given_name = _name_in(_argument_of(column, "name"))
            name = f"{prefix}{given_name if given_name is not None else prop['name']}"
            options = entries_of(_argument_of(column, "options"))
            definition = string_of(_argument_of(column, "columnDefinition"))
            type_expr = _argument_of(column, "type", 0)
            enum_class = by_name.get(class_of(_argument_of(column, "enumType")) or "")
            if enum_class is None:
                candidate = by_name.get(_simple_type(prop["type"]))
                enum_class = candidate if candidate is not None and candidate["kind"] == "enum" else None
            # `Types::BIGINT`, `'bigint'`, or the PHP type of the property
            type_name = string_of(type_expr)
            if type_name is None and type_expr is not None and type_expr["kind"] == "name":
                type_name = re.sub(r"_mutable$", "", type_expr["path"][-1].lower())
            if type_name is None:
                if enum_class is not None:
                    numeric = any(is_number(item.get("value")) for item in enum_class["cases"])
                    type_name = "integer" if numeric else "string"
                else:
                    type_name = _PHP_TYPES.get(_simple_type(prop["type"]))
            column_type = None
            if definition:
                column_type = sql_type_of(_DEFINITION_TAIL.sub("", definition), dialect)
                if column_type is not None:
                    column_type = {**column_type, "sql": definition}
            elif type_name:
                column_type = _type_of_name(custom_types.get(type_name, type_name), column, dialect)
            if column_type is not None and (type_name or "") in custom_types:
                column_type = {**column_type, "sql": type_name}
            if column_type is None:
                notes.append(
                    {
                        "code": "orm.unknownType",
                        "params": {
                            "table": table["name"],
                            "column": name,
                            "type": definition or type_name or prop["type"],
                        },
                    }
                )
            is_key = bool(_attribute_of(prop["attributes"], "Id"))
            db_column = {
                "name": name,
                "type": column_type
                if column_type is not None
                else {"sql": definition or type_name or prop["type"], "kind": "unknown"},
                "nullable": not is_key and boolean_of(_argument_of(column, "nullable")) is True,
            }
            if enum_class is not None:
                values = [item["value"] if "value" in item else item["name"] for item in enum_class["cases"]]
                enum_name = _to_snake(enum_class["name"])
                if not any(item["name"] == enum_name for item in db_enums):
                    db_enums.append(
                        {
                            "name": enum_name,
                            "values": [value if isinstance(value, str) else number_text(value) for value in values],
                            "storage": "check",
                        }
                    )
                declared = any(
                    (check.get("parsed") or {}).get("kind") == "in" and check["parsed"]["column"] == name
                    for check in table["checks"]
                )
                if not declared:
                    table["checks"].append(check_of(f"{name} IN ({_quoted(values)})"))
            default_value = options.get("default")
            if default_value is not None:
                value = literal_of(default_value)
                sql = value.strip() if isinstance(value, str) else None
                if sql is not None and _NOW_SQL.fullmatch(sql):
                    db_column["generated"] = "now"
                elif sql is not None and _UUID_SQL.fullmatch(sql):
                    db_column["generated"] = "uuid"
                elif value is not None:
                    db_column["default"] = {"kind": "literal", "value": value}
                elif (
                    default_value["kind"] == "name"
                    and len(default_value["path"]) == 1
                    and default_value["path"][0].lower() == "null"
                ):
                    db_column["default"] = {"kind": "literal", "value": None}
            elif prop.get("initializer") is not None:
                # The value a new object starts with: a literal, or a case of its enum
                initializer = prop["initializer"]
                value = literal_of(initializer)
                enum_case = None
                if (
                    initializer["kind"] == "name"
                    and len(initializer["path"]) == 2
                    and enum_class is not None
                    and initializer["path"][0] == enum_class["name"]
                ):
                    enum_case = next(
                        (item for item in enum_class["cases"] if item["name"] == initializer["path"][1]), None
                    )
                if value is not None:
                    db_column["default"] = {"kind": "literal", "value": value}
                elif enum_case is not None:
                    db_column["default"] = {"kind": "literal", "value": enum_case.get("value", enum_case["name"])}
            generated_value = _attribute_of(prop["attributes"], "GeneratedValue")
            if is_key and generated_value is not None:
                strategy = (string_of(_argument_of(generated_value, "strategy", 0)) or "AUTO").upper()
                if strategy not in ("NONE", "CUSTOM"):
                    db_column["generated"] = "uuid" if db_column["type"]["kind"] == "uuid" else "identity"
            generated = string_of(_argument_of(column, "generated"))
            computed = _COMPUTED.search(definition) if definition else None
            if generated is not None and generated.upper() == "ALWAYS" and computed:
                db_column["generated"] = {"computed": computed.group(1).strip()}
            column_comment = string_of(options.get("comment"))
            if column_comment:
                db_column["comment"] = column_comment
            attribute = f"{attribute_prefix}{prop['name']}"
            if name != attribute:
                db_column["attribute"] = attribute
            table["columns"].append(db_column)
            model["columns"][attribute] = name
            if is_key:
                primary.append(name)
            if boolean_of(_argument_of(column, "unique")) is True:
                table["uniques"].append({"columns": [name]})

        for prop in model["properties"]:
            if _attribute_of(prop["attributes"], *_RELATIONS):
                continue
            add_column(prop, "", "")
        if primary:
            table["primaryKey"] = primary

        # Indexes and unique constraints: on the class, or inside #[ORM\Table]
        def columns_of(attribute: dict, model: dict = model) -> list[str]:
            columns = _strings_of(_argument_of(attribute, "columns"))
            if columns:
                return columns
            return [model["columns"].get(field, field) for field in _strings_of(_argument_of(attribute, "fields"))]

        def nested(name: str, table_attribute: dict | None = table_attribute) -> list:
            found = _argument_of(table_attribute, name)
            return found["items"] if found is not None and found["kind"] == "list" else []

        for index in [*(item for item in cls["attributes"] if name_of(item) == "Index"), *nested("indexes")]:
            columns = columns_of(index)
            name = _name_in(_argument_of(index, "name"))
            unique = "unique" in _strings_of(_argument_of(index, "flags"))
            if columns:
                (table["uniques"] if unique else table["indexes"]).append(
                    {**({"name": name} if name else {}), "columns": columns}
                )
        for unique in [
            *(item for item in cls["attributes"] if name_of(item) == "UniqueConstraint"),
            *nested("uniqueConstraints"),
        ]:
            columns = columns_of(unique)
            name = _name_in(_argument_of(unique, "name"))
            if columns:
                table["uniques"].append({**({"name": name} if name else {}), "columns": columns})
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
        for prop in model["properties"]:
            relation = _attribute_of(prop["attributes"], "ManyToOne", "OneToOne", "ManyToMany")
            if relation is None or _argument_of(relation, "mappedBy") is not None:
                continue
            target = by_class.get(class_of(_argument_of(relation, "targetEntity", 0)) or _simple_type(prop["type"]))
            if target is None:
                continue
            kind = name_of(relation)
            join_columns = [
                item for item in prop["attributes"] if item["kind"] == "call" and name_of(item) == "JoinColumn"
            ]
            if kind == "ManyToMany":
                joins.append(_join_table_of(model, target, prop, key_column))
                continue
            join_list = join_columns if join_columns else [None for _ in target["table"]["primaryKey"] or []]
            columns: list[str] = []
            references: list[str] = []
            is_key = bool(_attribute_of(prop["attributes"], "Id"))
            for position, join in enumerate(join_list):
                parent = key_column(target, string_of(_argument_of(join, "referencedColumnName")), position)
                if parent is None:
                    continue
                given = _name_in(_argument_of(join, "name"))
                name = given if given is not None else f"{prop['name']}_{parent['name']}"
                if not any(item["name"] == name for item in table["columns"]):
                    nullable = not is_key and boolean_of(_argument_of(join, "nullable")) is not False
                    table["columns"].append({"name": name, "type": parent["type"], "nullable": nullable})
                    if is_key:
                        table["primaryKey"] = [*(table["primaryKey"] or []), name]
                if boolean_of(_argument_of(join, "unique")) is True:
                    table["uniques"].append({"columns": [name]})
                columns.append(name)
                references.append(parent["name"])
            if not columns:
                continue
            first_join = join_columns[0] if join_columns else None
            on_delete = _ACTIONS.get((string_of(_argument_of(first_join, "onDelete")) or "").upper())
            inverse = string_of(_argument_of(relation, "inversedBy"))
            target_table = target["table"]
            table["foreignKeys"].append(
                {
                    "columns": columns,
                    "references": {
                        "table": target_table["name"],
                        **({"schema": target_table["schema"]} if target_table.get("schema") else {}),
                        "columns": references,
                    },
                    **({"onDelete": on_delete} if on_delete else {}),
                    "attribute": prop["name"],
                    **({"inverse": inverse} if inverse else {}),
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
    # The other side of each relation: `#[ORM\OneToMany(mappedBy: 'order', …)]`
    for model in models:
        for prop in model["properties"]:
            relation = _attribute_of(prop["attributes"], "OneToMany", "OneToOne")
            mapped_by = string_of(_argument_of(relation, "mappedBy"))
            if relation is None or not mapped_by:
                continue
            target = by_class.get(class_of(_argument_of(relation, "targetEntity", 0)) or _simple_type(prop["type"]))
            key = (
                next((item for item in target["table"]["foreignKeys"] if item.get("attribute") == mapped_by), None)
                if target is not None
                else None
            )
            if key is None:
                continue
            if not key.get("inverse"):
                key["inverse"] = prop["name"]
            # Rows the parent removes with it (cascade: ['remove'], orphanRemoval): deleted with their parent
            cascades = _strings_of(_argument_of(relation, "cascade"))
            orphans = boolean_of(_argument_of(relation, "orphanRemoval")) is True
            if not key.get("onDelete") and ("remove" in cascades or "all" in cascades or orphans):
                key["onDelete"] = "cascade"
    if models:
        notes.append({"code": "orm.checksNotKept"})
    return {
        "format": "db-schema",
        "version": 1,
        "dialect": dialect,
        "source": {"kind": "orm", "format": "doctrine"},
        "tables": [*(model["table"] for model in models), *joins],
        "enums": db_enums,
        "notes": notes,
    }


def _join_table_of(model: dict, target: dict, prop: dict, key_column) -> dict:
    """The join table of a `#[ORM\\ManyToMany]`: as `#[ORM\\JoinTable]` names it, or as Doctrine does
    (`<source>_<target>` in lower case, with columns `<class>_<key>`), keyed by both and deleted with either row."""
    join_table = _attribute_of(prop["attributes"], "JoinTable")
    name = _name_in(_argument_of(join_table, "name", 0))
    table = {
        "name": name if name is not None else f"{model['cls']['name']}_{target['cls']['name']}".lower(),
        "columns": [],
        "primaryKey": [],
        "foreignKeys": [],
        "uniques": [],
        "indexes": [],
        "checks": [],
        "origin": {"line": prop["line"], "column": 1},
    }
    schema = string_of(_argument_of(join_table, "schema"))
    if schema:
        table["schema"] = schema

    def calls(kind: str) -> list[dict]:
        return [item for item in prop["attributes"] if item["kind"] == "call" and name_of(item) == kind]

    for given, side in ((calls("JoinColumn"), model), (calls("InverseJoinColumn"), target)):
        count = len(given) if given else len(side["table"]["primaryKey"] or [])
        for position in range(count):
            join = given[position] if position < len(given) else None
            parent = key_column(side, string_of(_argument_of(join, "referencedColumnName")), position)
            if parent is None:
                continue
            given_name = _name_in(_argument_of(join, "name"))
            column = given_name if given_name is not None else f"{side['cls']['name'].lower()}_{parent['name']}"
            table["columns"].append({"name": column, "type": parent["type"], "nullable": False})
            table["primaryKey"].append(column)
            table["indexes"].append({"columns": [column]})
            on_delete = _ACTIONS.get((string_of(_argument_of(join, "onDelete")) or "CASCADE").upper())
            side_table = side["table"]
            table["foreignKeys"].append(
                {
                    "columns": [column],
                    "references": {
                        "table": side_table["name"],
                        **({"schema": side_table["schema"]} if side_table.get("schema") else {}),
                        "columns": [parent["name"]],
                    },
                    **({"onDelete": on_delete} if on_delete else {}),
                }
            )
    return table


_MAPPING = re.compile(r"\bDoctrine\\ORM\\Mapping\b")
_ENTITY = re.compile(r"#\[(ORM\\)?Entity\b")


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if _MAPPING.search(text) and _ENTITY.search(text) else 0


DOCTRINE_READER = OrmReader(id="doctrine", label="Doctrine", language="php", detect=_detect, read=_read_doctrine)
