"""Storage of each resource in the Vapor project: the repository protocol the service depends on, the typed filters of
its lists, and the implementation of the chosen persistence:
- memory: an actor with a dictionary, to run the API without a database
- none: every method answers 501, with a TODO where the storage goes
- fluent: a Fluent model and migration, and a repository with filters and sorting written for each field
Mirrors web/src/core/generators/frameworks/vapor/persistence.ts.
"""

from collections.abc import Callable
from dataclasses import dataclass

from ...common.text import file_text, lines
from ...languages.swift.swift import sw_doc, sw_header, sw_string, sw_type
from .context import VaporContext, column, key_field, key_type, names, property_name, source_path
from .model import field_type, stored_as_json


def queryable(field: dict) -> bool:
    """Whether a field can be filtered and sorted: plain values, enums and single references."""
    return not stored_as_json(field) and field["type"]["kind"] in ("scalar", "enum")


def filter_fields(resource: dict) -> list[dict]:
    """The fields the lists of a resource filter by."""
    wires = {
        wire for endpoint in resource["endpoints"] if endpoint["operation"] == "list" for wire in endpoint["filters"]
    }
    return [field for field in resource["fields"] if field["wire"] in wires and queryable(field)]


def sort_fields(resource: dict) -> list[dict]:
    """The fields the lists of a resource sort by."""
    wires = {wire for endpoint in resource["endpoints"] if endpoint["operation"] == "list" for wire in endpoint["sort"]}
    return [field for field in resource["fields"] if field["wire"] in wires and queryable(field)]


def _comparable(context: VaporContext, resource: dict, field: dict, value: str) -> str:
    """A value of a field as the memory repository compares it: booleans and UUIDs have no order of their own."""
    type_name = field_type(context, field, resource)
    key = field["name"] == resource["key"]["field"]
    if type_name == "Bool":
        return f"{value}.map {{ $0 ? 1 : 0 }}"
    if type_name == "UUID":
        return f"{value}.uuidString" if key else f"{value}?.uuidString"
    return value


def _key_order(resource: dict, a: str, b: str) -> str:
    """How two keys are ordered."""
    key = property_name(key_field(resource))
    if key_type(resource) == "UUID":
        return f"{a}.{key}.uuidString < {b}.{key}.uuidString"
    return f"{a}.{key} < {b}.{key}"


@dataclass
class _Column:
    """The column of a field in its Fluent model: its Swift type and database type, and how values go in and out."""

    type: str
    data_type: str
    write: Callable[[str], str]
    read: Callable[[str], str]
    # The value a filter compares with the column
    match: Callable[[str], str]


def _plain(type_name: str, data_type: str) -> _Column:
    return _Column(type_name, data_type, lambda value: value, lambda value: value, lambda value: value)


def _key_column(target: dict) -> tuple[str, str]:
    type_name = key_type(target)
    data_type = ".int64" if type_name == "Int64" else ".uuid" if type_name == "UUID" else ".string"
    return (type_name, data_type)


def _column_of(context: VaporContext, resource: dict, field: dict) -> _Column:
    if field["name"] == resource["key"]["field"]:
        return _plain(*_key_column(resource))
    if stored_as_json(field):
        type_name = field_type(context, field, resource)
        return _Column(
            "String",
            '.custom("TEXT")',
            lambda value: f"jsonText({value})",
            lambda value: f"jsonValue({value}, as: {type_name}.self)",
            lambda value: value,
        )
    if field.get("reference"):
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        return _plain(*_key_column(target))
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        enum_type = sw_type(type_ref["name"])
        integer = item["valueType"] == "integer"
        return _Column(
            "Int64" if integer else "String",
            ".int64" if integer else ".string",
            lambda value: f"{value}?.rawValue",
            lambda value: f"{value}.flatMap({enum_type}.init(rawValue:))",
            lambda value: f"{value}.rawValue",
        )
    if type_ref["kind"] != "scalar":
        return _plain("String", '.custom("TEXT")')
    scalar = type_ref["scalar"]
    if scalar == "integer":
        return _plain("Int64", ".int64") if type_ref.get("bits") == 64 else _plain("Int32", ".int32")
    if scalar == "float":
        return _plain("Double", ".double")
    if scalar == "decimal":
        # Kept as a double in the database: every driver reads it the same way
        return _Column(
            "Double",
            ".double",
            lambda value: f"{value}.map {{ NSDecimalNumber(decimal: $0).doubleValue }}",
            lambda value: f"{value}.flatMap {{ Decimal(string: String($0)) }}",
            lambda value: f"NSDecimalNumber(decimal: {value}).doubleValue",
        )
    if scalar == "boolean":
        return _plain("Bool", ".bool")
    if scalar == "datetime":
        return _plain("Date", ".datetime")
    if scalar == "uuid":
        return _plain("UUID", ".uuid")
    length = field["constraints"].get("maxLength")
    return _plain("String", ".string" if length is not None and length <= 255 else '.custom("TEXT")')


def _record_property(field: dict) -> str:
    """The property of a field in a Fluent model: id is the key's."""
    name = property_name(field)
    return "idValue" if name == "id" else name


def record_file(context: VaporContext, resource: dict) -> dict | None:
    """The Fluent model of a resource and its migration."""
    if not context.fluent:
        return None
    name = names(resource)
    generated = ".database" if resource["key"]["generated"] == "increment" else ".user"
    key = key_field(resource)
    others = [field for field in resource["fields"] if field["name"] != resource["key"]["field"]]
    properties = [
        f"    @OptionalField(key: {sw_string(column(field))}) var {_record_property(field)}: {_column_of(context, resource, field).type}?"
        for field in others
    ]
    key_column = _column_of(context, resource, key)
    fields = [
        f"            .field({sw_string(column(field))}, {_column_of(context, resource, field).data_type})"
        for field in others
    ]
    auto = "true" if resource["key"]["generated"] == "increment" else "false"
    content = lines(
        *sw_header(f"The {name['table']} table.", ["Fluent", "Foundation"]),
        sw_doc(f"A row of the {name['table']} table."),
        f"final class {name['record']}: Model, @unchecked Sendable {{",
        f"    static let schema = {sw_string(name['table'])}",
        "",
        f"    @ID(custom: {sw_string(column(key))}, generatedBy: {generated}) var id: {key_column.type}?",
        properties,
        "",
        "    init() {}",
        "}",
        "",
        sw_doc(f"Creates the {name['table']} table; the application runs it when it starts."),
        f"struct {name['migration']}: AsyncMigration {{",
        "    func prepare(on database: any Database) async throws {",
        f"        try await database.schema({name['record']}.schema)",
        f"            .field({sw_string(column(key))}, {key_column.data_type}, .identifier(auto: {auto}))",
        fields,
        "            .ignoreExisting()",
        "            .create()",
        "    }",
        "",
        "    func revert(on database: any Database) async throws {",
        f"        try await database.schema({name['record']}.schema).delete()",
        "    }",
        "}",
    )
    return {
        "path": source_path(context.layout.resource(resource, "database"), name["record"]),
        "content": file_text(content),
    }


def repository_file(context: VaporContext, resource: dict) -> dict:
    name = names(resource)
    key = key_type(resource)
    key_name = property_name(key_field(resource))
    generated = resource["key"]["generated"]
    filters = filter_fields(resource)
    imports = {"Foundation"}
    filter_struct = [
        sw_doc(f"What a list of {resource['plural']} can filter by: a field that has a value must be equal to it."),
        [
            f"struct {name['filters']}: Sendable {{",
            [f"    var {property_name(field)}: {field_type(context, field, resource)}?" for field in filters],
            "}",
        ]
        if filters
        else f"struct {name['filters']}: Sendable {{}}",
    ]
    protocol = [
        sw_doc(f"Where {resource['plural']} are kept. The service depends only on this protocol."),
        f"protocol {name['repository']}: Sendable {{",
        "    /// Items equal to every filter, in order, within the window; and how many match.",
        f"    func list(_ query: ListQuery<{name['filters']}>) async throws -> ListResult<{name['type']}>",
        "",
        "    /// The item with this key, or nil when there is none.",
        f"    func get(_ key: {key}) async throws -> {name['type']}?",
        "",
        f"    /// Stores a new item{' and assigns its key' if generated else ''}; returns it as stored.",
        f"    func add(_ item: {name['type']}) async throws -> {name['type']}",
        "",
        "    /// Stores the new state of an existing item and returns it.",
        f"    func update(_ item: {name['type']}) async throws -> {name['type']}",
        "",
        "    /// Removes an existing item.",
        f"    func delete(_ key: {key}) async throws",
        "}",
    ]
    new_key = "UUID()" if key == "UUID" else "UUID().uuidString.lowercased()"
    if context.pending:
        implementation = _pending(resource, name, key)
    elif not context.fluent:
        implementation = _memory(context, resource, name, key, key_name, generated, filters, new_key)
    else:
        imports.add("Fluent")
        implementation = _fluent(context, resource, name, key, key_name, generated, filters, new_key)
    content = lines(
        *sw_header(f"Where {resource['plural']} are kept.", imports), filter_struct, "", protocol, "", implementation
    )
    return {
        "path": source_path(context.layout.resource(resource, "repository"), name["repository"]),
        "content": file_text(content),
    }


def _pending(resource: dict, name: dict, key: str) -> list:
    message = sw_string(f"The storage of {resource['plural']} is not written yet")

    def method(signature: str) -> list[str]:
        return [
            f"    func {signature} {{",
            f"        // TODO: store {resource['plural']} in your database",
            f"        throw ApiError.notImplemented({message})",
            "    }",
        ]

    return [
        sw_doc(f"Storage of {resource['plural']} to write: every method answers 501 until it is implemented."),
        f"struct {name['pendingRepository']}: {name['repository']} {{",
        method(f"list(_ query: ListQuery<{name['filters']}>) async throws -> ListResult<{name['type']}>"),
        "",
        method(f"get(_ key: {key}) async throws -> {name['type']}?"),
        "",
        method(f"add(_ item: {name['type']}) async throws -> {name['type']}"),
        "",
        method(f"update(_ item: {name['type']}) async throws -> {name['type']}"),
        "",
        method(f"delete(_ key: {key}) async throws"),
        "}",
    ]


def _memory(
    context: VaporContext,
    resource: dict,
    name: dict,
    key: str,
    key_name: str,
    generated,
    filters: list[dict],
    new_key: str,
) -> list:
    sorts = sort_fields(resource)
    conditions = [
        f"(filters.{property_name(field)}.map {{ item.{property_name(field)} == $0 }} ?? true)" for field in filters
    ]
    if generated == "increment":
        assign = ["        lastKey += 1", f"        item.{key_name} = lastKey"]
    elif generated == "uuid":
        assign = [f"        item.{key_name} = {new_key}"]
    else:
        assign = None
    found = f"{'var' if sorts else 'let'} found = items.values.sorted {{ {_key_order(resource, '$0', '$1')} }}"
    if conditions:
        joined = "\n                && ".join(conditions)
        found += f".filter {{ item in\n            {joined}\n        }}"

    def sort_case(field: dict) -> list[str]:
        a = _comparable(context, resource, field, f"a.{property_name(field)}")
        b = _comparable(context, resource, field, f"b.{property_name(field)}")
        return [
            f"        case {sw_string(field['wire'])}:",
            f"            found.sort {{ a, b in comesFirst({a}, {b}, descending: query.descending) ?? ({_key_order(resource, 'a', 'b')}) }}",
        ]

    return [
        sw_doc(
            f"Keeps {resource['plural']} in memory: they are lost when the application stops. Use it to try the API."
        ),
        f"actor {name['memory']}: {name['repository']} {{",
        f"    private var items: [{key}: {name['type']}] = [:]",
        generated == "increment" and "    private var lastKey: Int64 = 0",
        "",
        f"    func list(_ query: ListQuery<{name['filters']}>) async throws -> ListResult<{name['type']}> {{",
        bool(conditions) and "        let filters = query.filters",
        f"        {found}",
        bool(sorts)
        and [
            "        // Items without a value go last, whatever the order; equal ones keep the order of their keys",
            "        switch query.sortField {",
            [sort_case(field) for field in sorts],
            "        default:",
            "            break",
            "        }",
        ],
        "        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)",
        "        return ListResult(items: Array(window), total: found.count)",
        "    }",
        "",
        f"    func get(_ key: {key}) async throws -> {name['type']}? {{",
        "        items[key]",
        "    }",
        "",
        f"    func add(_ item: {name['type']}) async throws -> {name['type']} {{",
        ["        var item = item", assign] if assign else None,
        f"        items[item.{key_name}] = item",
        "        return item",
        "    }",
        "",
        f"    func update(_ item: {name['type']}) async throws -> {name['type']} {{",
        f"        items[item.{key_name}] = item",
        "        return item",
        "    }",
        "",
        f"    func delete(_ key: {key}) async throws {{",
        "        items[key] = nil",
        "    }",
        "}",
    ]


def _fluent(
    context: VaporContext,
    resource: dict,
    name: dict,
    key: str,
    key_name: str,
    generated,
    filters: list[dict],
    new_key: str,
) -> list:
    sorts = sort_fields(resource)
    others = [field for field in resource["fields"] if field["name"] != resource["key"]["field"]]
    columns = [(field, _column_of(context, resource, field)) for field in others]

    def key_path(field: dict) -> str:
        if field["name"] == resource["key"]["field"]:
            return "\\.$id"
        return f"\\.${_record_property(field).replace('`', '')}"

    filter_lines = []
    for field in filters:
        match = (
            "value"
            if field["name"] == resource["key"]["field"]
            else _column_of(context, resource, field).match("value")
        )
        filter_lines.append(
            [
                f"        if let value = query.filters.{property_name(field)} {{",
                f"            select.filter({key_path(field)} == {match})",
                "        }",
            ]
        )
    # In the order of the fields: the order of the memberwise initializer
    to_item = [
        f"{key_name}: try record.requireID()"
        if field["name"] == resource["key"]["field"]
        else f"{property_name(field)}: {_column_of(context, resource, field).read(f'record.{_record_property(field)}')}"
        for field in resource["fields"]
    ]

    def order(field: dict) -> str:
        if field["name"] == resource["key"]["field"]:
            return "            select.sort(\\.$id, direction)"
        return f"            select.sort(nullsLast({sw_string(column(field))})).sort({key_path(field)}, direction)"

    if generated == "uuid":
        assign_key = f"        record.id = {new_key}"
    elif generated is None:
        assign_key = f"        record.id = item.{key_name}"
    else:
        assign_key = None
    return [
        sw_doc(f"Keeps {resource['plural']} in the database with Fluent."),
        f"struct {name['fluentRepository']}: {name['repository']} {{",
        "    let database: any Database",
        "",
        f"    func list(_ query: ListQuery<{name['filters']}>) async throws -> ListResult<{name['type']}> {{",
        f"        let select = {name['record']}.query(on: database)",
        filter_lines,
        "        let total = try await select.copy().count()",
        bool(sorts)
        and [
            "        let direction: DatabaseQuery.Sort.Direction = query.descending ? .descending : .ascending",
            "        // Items without a value go last, whatever the order; the key breaks ties",
            "        switch query.sortField {",
            [[f"        case {sw_string(field['wire'])}:", order(field)] for field in sorts],
            "        default:",
            "            break",
            "        }",
        ],
        "        select.sort(\\.$id).offset(query.offset)",
        "        if let limit = query.limit {",
        "            select.limit(limit)",
        "        }",
        "        return ListResult(items: try await select.all().map(toItem), total: total)",
        "    }",
        "",
        f"    func get(_ key: {key}) async throws -> {name['type']}? {{",
        f"        try await {name['record']}.find(key, on: database).map(toItem)",
        "    }",
        "",
        f"    func add(_ item: {name['type']}) async throws -> {name['type']} {{",
        f"        let record = {name['record']}()",
        assign_key,
        "        write(item, to: record)",
        "        try await record.create(on: database)",
        "        return try toItem(record)",
        "    }",
        "",
        f"    func update(_ item: {name['type']}) async throws -> {name['type']} {{",
        f"        guard let record = try await {name['record']}.find(item.{key_name}, on: database) else {{",
        f"            throw ApiError.notFound({sw_string(resource['singular'])})",
        "        }",
        "        write(item, to: record)",
        "        try await record.update(on: database)",
        "        return try toItem(record)",
        "    }",
        "",
        f"    func delete(_ key: {key}) async throws {{",
        f"        try await {name['record']}.query(on: database).filter(\\.$id == key).delete()",
        "    }",
        "",
        "    /// Every field of an item in its column; the key is set apart.",
        f"    private func write(_ item: {name['type']}, to record: {name['record']}) {{",
        [
            f"        record.{_record_property(field)} = {spec.write(f'item.{property_name(field)}')}"
            for field, spec in columns
        ]
        if columns
        else "        _ = record",
        "    }",
        "",
        f"    private func toItem(_ record: {name['record']}) throws -> {name['type']} {{",
        f"        {name['type']}(",
        [f"            {item}{',' if index < len(to_item) - 1 else ''}" for index, item in enumerate(to_item)],
        "        )",
        "    }",
        "}",
    ]
