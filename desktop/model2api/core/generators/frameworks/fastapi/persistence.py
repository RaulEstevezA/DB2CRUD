"""Storage of each resource in the FastAPI project: the repository interface the service depends on (a Protocol),
and the implementation of the chosen persistence. Mirrors web/src/core/generators/frameworks/fastapi/persistence.ts.

- memory: a dictionary, to run the API without a database
- none: every method raises "not implemented", with a TODO where the storage goes
- sqlalchemy: a SQLAlchemy 2 table and a repository on a session

Repositories store and return plain dictionaries keyed by the Python names of the fields, so services never
depend on how the data is kept.
"""

from ....js import is_number, js_string, number_text
from ...common.text import file_text, lines
from ...languages.python.python import PyImports, py_docstring, py_string
from .context import FastApiContext, attr, classes, key_field, table_name


def _key_type(resource: dict, imports: PyImports) -> str:
    """The Python type of a key, for signatures."""
    scalar = resource["key"]["type"]["scalar"]
    if scalar == "uuid":
        imports.add("uuid", "UUID")
        return "UUID"
    return "int" if scalar == "integer" else "str"


def _protocol_block(resource: dict, key: str) -> str:
    name = classes(resource)
    return lines(
        f"class {name['repository']}(Protocol):",
        f'    """Where {resource["plural"]} are kept. The service depends only on this interface."""',
        "",
        "    def list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:",
        '        """Items equal to every filter, sorted by (field, descending), from `offset`, at most `limit`; and how many match."""',
        "        ...",
        "",
        f"    def get(self, key: {key}) -> dict[str, Any] | None:",
        '        """The item with this key, or None."""',
        "        ...",
        "",
        "    def add(self, values: dict[str, Any]) -> dict[str, Any]:",
        '        """Stores a new item; a key the server generates is assigned here. Returns the stored item."""',
        "        ...",
        "",
        f"    def update(self, key: {key}, values: dict[str, Any]) -> dict[str, Any]:",
        '        """Changes the given fields of an existing item and returns it."""',
        "        ...",
        "",
        f"    def delete(self, key: {key}) -> None:",
        '        """Removes an existing item."""',
        "        ...",
    )


def _memory_block(resource: dict, key: str, imports: PyImports) -> str:
    name = classes(resource)
    key_attr = attr(key_field(resource))
    imports.add("copy", "deepcopy")
    generated = resource["key"]["generated"]
    assign: list[str] = []
    if generated == "increment":
        assign = [f"        values[{py_string(key_attr)}] = self._next_key", "        self._next_key += 1"]
    if generated == "uuid":
        imports.add("uuid", "uuid4")
        value = "uuid4()" if resource["key"]["type"]["scalar"] == "uuid" else "str(uuid4())"
        assign = [f"        values[{py_string(key_attr)}] = {value}"]
    return lines(
        f"class {name['memory']}:",
        f'    """Keeps {resource["plural"]} in memory: they are lost when the application stops. Use it to try the API."""',
        "",
        "    def __init__(self) -> None:",
        f"        self._items: dict[{key}, dict[str, Any]] = {{}}",
        generated == "increment" and "        self._next_key = 1",
        "",
        "    def list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:",
        "        items = [item for item in self._items.values() if all(item.get(name) == value for name, value in filters.items())]",
        "        if sort is not None:",
        "            name, descending = sort",
        "            # Items without a value go last, whatever the order",
        "            present = sorted((item for item in items if item.get(name) is not None), key=lambda item: item[name], reverse=descending)",
        "            items = present + [item for item in items if item.get(name) is None]",
        "        end = None if limit is None else offset + limit",
        "        return [deepcopy(item) for item in items[offset:end]], len(items)",
        "",
        f"    def get(self, key: {key}) -> dict[str, Any] | None:",
        "        item = self._items.get(key)",
        "        return deepcopy(item) if item is not None else None",
        "",
        "    def add(self, values: dict[str, Any]) -> dict[str, Any]:",
        "        values = deepcopy(values)",
        assign,
        f"        self._items[values[{py_string(key_attr)}]] = values",
        "        return deepcopy(values)",
        "",
        f"    def update(self, key: {key}, values: dict[str, Any]) -> dict[str, Any]:",
        "        self._items[key].update(deepcopy(values))",
        "        return deepcopy(self._items[key])",
        "",
        f"    def delete(self, key: {key}) -> None:",
        "        del self._items[key]",
    )


def _pending_block(resource: dict, key: str) -> str:
    name = classes(resource)
    message = py_string(f"The storage of {resource['plural']} is not written yet")

    def method(signature: str) -> list[str]:
        return [
            f"    def {signature}:",
            f"        # TODO: store {resource['plural']} in your database",
            f"        raise NotImplementedError({message})",
        ]

    return lines(
        f"class {name['pendingRepository']}:",
        f'    """Storage of {resource["plural"]} to write: every method answers 501 until it is implemented."""',
        "",
        method(
            "list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]"
        ),
        "",
        method(f"get(self, key: {key}) -> dict[str, Any] | None"),
        "",
        method("add(self, values: dict[str, Any]) -> dict[str, Any]"),
        "",
        method(f"update(self, key: {key}, values: dict[str, Any]) -> dict[str, Any]"),
        "",
        method(f"delete(self, key: {key}) -> None"),
    )


def _stored_as_json(field: dict) -> bool:
    """Whether a field is stored as JSON: embedded objects, lists, maps and free values."""
    kind = field["type"]["kind"]
    if kind not in ("scalar", "enum"):
        return True
    return kind == "scalar" and field["type"]["scalar"] == "any"


def _sql_block(resource: dict, key: str, context: FastApiContext, imports: PyImports) -> str:
    name = classes(resource)
    model = name["model"]
    imports.add("sqlalchemy", "func", "select")
    imports.add("sqlalchemy.orm", "Session")
    imports.add("enum", "Enum")
    imports.add(context.layout.resource(resource, "models")["module"], model)
    json_fields = [attr(field) for field in resource["fields"] if _stored_as_json(field)]
    if json_fields:
        imports.add("fastapi.encoders", "jsonable_encoder")
    key_attr = attr(key_field(resource))
    return lines(
        "def _plain(value: Any) -> Any:",
        '    """The stored form of a value: enums by their value."""',
        "    return value.value if isinstance(value, Enum) else value",
        "",
        "",
        f"class {name['sqlRepository']}:",
        f'    """Keeps {resource["plural"]} in the "{table_name(resource)}" table."""',
        "",
        bool(json_fields) and f"    _json_fields = frozenset({{{', '.join(map(py_string, json_fields))}}})",
        bool(json_fields) and "",
        "    def __init__(self, session: Session) -> None:",
        "        self._session = session",
        "",
        f"    def _to_dict(self, row: {model}) -> dict[str, Any]:",
        "        return {column.key: getattr(row, column.key) for column in row.__table__.columns}",
        "",
        "    def _storable(self, values: dict[str, Any]) -> dict[str, Any]:",
        "        return {name: jsonable_encoder(value) if name in self._json_fields else _plain(value) for name, value in values.items()}"
        if json_fields
        else "        return {name: _plain(value) for name, value in values.items()}",
        "",
        "    def list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:",
        f"        query = select({model})",
        "        for field, value in filters.items():",
        f"            query = query.where(getattr({model}, field) == _plain(value))",
        "        total = self._session.scalar(select(func.count()).select_from(query.subquery())) or 0",
        "        if sort is not None:",
        f"            column = getattr({model}, sort[0])",
        "            query = query.order_by(column.desc() if sort[1] else column.asc())",
        f"        query = query.order_by({model}.{key_attr}).offset(offset)",
        "        if limit is not None:",
        "            query = query.limit(limit)",
        "        return [self._to_dict(row) for row in self._session.scalars(query)], total",
        "",
        f"    def get(self, key: {key}) -> dict[str, Any] | None:",
        f"        row = self._session.get({model}, key)",
        "        return self._to_dict(row) if row is not None else None",
        "",
        "    def add(self, values: dict[str, Any]) -> dict[str, Any]:",
        f"        row = {model}(**self._storable(values))",
        "        self._session.add(row)",
        "        self._session.commit()",
        "        # Read back what the database stored, so a response shows the same values as a later read",
        "        self._session.refresh(row)",
        "        return self._to_dict(row)",
        "",
        f"    def update(self, key: {key}, values: dict[str, Any]) -> dict[str, Any]:",
        f"        row = self._session.get_one({model}, key)",
        "        for field, value in self._storable(values).items():",
        "            setattr(row, field, value)",
        "        self._session.commit()",
        "        self._session.refresh(row)",
        "        return self._to_dict(row)",
        "",
        f"    def delete(self, key: {key}) -> None:",
        f"        self._session.delete(self._session.get_one({model}, key))",
        "        self._session.commit()",
    )


def repository_file(context: FastApiContext, resource: dict) -> dict:
    imports = PyImports()
    imports.add("typing", "Any", "Protocol")
    key = _key_type(resource, imports)
    blocks = [_protocol_block(resource, key)]
    if context.sql:
        blocks.append(_sql_block(resource, key, context, imports))
    elif context.pending:
        blocks.append(_pending_block(resource, key))
    else:
        blocks.append(_memory_block(resource, key, imports))
    content = lines(
        py_docstring(f"Storage of {resource['plural']}."), "", imports.render(), "", "", "\n\n\n".join(blocks)
    )
    return {"path": context.layout.resource(resource, "repository")["file"], "content": file_text(content)}


_SCALAR_COLUMNS = {
    "float": "Float",
    "boolean": "Boolean",
    "date": "Date",
    "time": "Time",
    "duration": "Interval",
    "uuid": "Uuid",
    "binary": "LargeBinary",
}


def _column_type(field: dict, context: FastApiContext, imports: PyImports, is_key_like: bool) -> str:
    """The SQLAlchemy column type of a field."""
    type_ref = field["type"]
    if _stored_as_json(field):
        imports.add("sqlalchemy", "JSON")
        return "JSON"
    if type_ref["kind"] == "enum":
        found = next((item for item in context.spec["enums"] if item["name"] == type_ref["name"]), None)
        values = found["values"] if found else []
        if all(is_number(value) for value in values):
            imports.add("sqlalchemy", "Integer")
            return "Integer"
        imports.add("sqlalchemy", "String")
        return f"String({max([1, *(len(js_string(value)) for value in values)])})"
    scalar = type_ref["scalar"]
    if scalar == "string":
        maximum = field["constraints"].get("maxLength")
        if maximum is not None or is_key_like:
            imports.add("sqlalchemy", "String")
            return f"String({number_text(maximum) if maximum is not None else 255})"
        imports.add("sqlalchemy", "Text")
        return "Text"
    if scalar == "integer":
        if type_ref.get("bits") == 64:
            imports.add("sqlalchemy", "BigInteger")
            return "BigInteger"
        imports.add("sqlalchemy", "Integer")
        return "Integer"
    if scalar == "decimal":
        imports.add("sqlalchemy", "Numeric")
        # A fixed size: MySQL and MariaDB would otherwise keep no decimals
        return "Numeric(18, 4)"
    if scalar == "datetime":
        imports.add("sqlalchemy", "DateTime")
        return "DateTime(timezone=True)"
    if scalar in _SCALAR_COLUMNS:
        imports.add("sqlalchemy", _SCALAR_COLUMNS[scalar])
        return _SCALAR_COLUMNS[scalar]
    imports.add("sqlalchemy", "JSON")
    return "JSON"


def model_file(context: FastApiContext, resource: dict) -> dict | None:
    """The SQLAlchemy table of a resource."""
    if not context.sql:
        return None
    imports = PyImports()
    imports.add("typing", "Any")
    imports.add("sqlalchemy.orm", "Mapped", "mapped_column")
    imports.add("app.db", "Base")
    name = classes(resource)
    generated = resource["key"]["generated"]
    columns = []
    for field in resource["fields"]:
        is_key = field["name"] == resource["key"]["field"]
        target = None
        if field.get("reference") and field["type"]["kind"] == "scalar":
            target = next((item for item in context.spec["resources"] if item["name"] == field["reference"]), None)
        column_type = _column_type(field, context, imports, is_key or target is not None)
        args: list[str] = []
        if is_key:
            if generated == "increment":
                # SQLite only numbers a column declared exactly as INTEGER PRIMARY KEY
                imports.add("sqlalchemy", "Integer")
                if column_type == "BigInteger":
                    column_type = 'BigInteger().with_variant(Integer, "sqlite")'
                args.extend(["primary_key=True", "autoincrement=True"])
            elif generated == "uuid":
                # The server assigns a new UUID when the client sends none
                imports.add("uuid", "uuid4")
                uuid_key = resource["key"]["type"]["scalar"] == "uuid"
                args.extend(["primary_key=True", "default=uuid4" if uuid_key else "default=lambda: str(uuid4())"])
            else:
                args.append("primary_key=True")
        if target:
            imports.add("sqlalchemy", "ForeignKey")
            args.append(f"ForeignKey({py_string(f'{table_name(target)}.{attr(key_field(target))}')})")
        nullable = (
            not is_key
            and (field["nullable"] or not field["required"])
            and field.get("server") not in ("created", "updated")
        )
        if not is_key:
            args.append(f"nullable={'True' if nullable else 'False'}")
        ordered = [
            column_type,
            *(arg for arg in args if arg.startswith("ForeignKey")),
            *(arg for arg in args if not arg.startswith("ForeignKey")),
        ]
        columns.append(f"    {attr(field)}: Mapped[Any] = mapped_column({', '.join(ordered)})")
    content = lines(
        py_docstring(f"Table of {resource['plural']}. Embedded objects and lists are stored as JSON."),
        "",
        imports.render(),
        "",
        "",
        f"class {name['model']}(Base):",
        f'    """A row of the "{table_name(resource)}" table."""',
        "",
        f"    __tablename__ = {py_string(table_name(resource))}",
        "",
        columns,
    )
    return {"path": context.layout.resource(resource, "models")["file"], "content": file_text(content)}
