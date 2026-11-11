"""Services and controllers of the Vapor project. Mirrors web/src/core/generators/frameworks/vapor/web.ts.

The service of a resource holds its rules: items that must exist, keys that must not repeat, references that must
point to stored items, and the values the server fills. Business endpoints get a method that answers 501 where their
logic goes. Presence, null and the declared validations are checked on the request body itself (Common/Body.swift).

The controllers only translate HTTP to service calls: parameters, bodies, status codes and protection.
"""

import re

from ....js import js_string, number_text
from ....openapi.build import PAGE_SIZE, shape_fields
from ...common.references import inner_object, referenced_resources
from ...common.samples import json_text
from ...common.text import file_text, lines
from ...languages.swift.swift import sw_doc, sw_header, sw_name, sw_string, sw_type, sw_type_of
from .context import VaporContext, key_field, key_type, names, property_name, source_path, type_names
from .model import enum_cases
from .persistence import filter_fields


def endpoint_function(endpoint: dict) -> str:
    """The method of a service, and the handler, of an endpoint: listCustomers."""
    return sw_name(endpoint["name"])


def _sw_default(context: VaporContext, field: dict) -> str:
    """A default value written in Swift for the field's type."""
    value = field.get("defaultValue")
    if value is None:
        return "nil"
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        return f"{sw_type(type_ref['name'])}.{enum_cases(item['values'])[item['values'].index(value)]}"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return number_text(value)
        if scalar == "float":
            text = number_text(value)
            return f"{text}.0" if float(value).is_integer() else text
        if scalar == "decimal":
            return f"Decimal(string: {sw_string(js_string(value))})"
        if scalar == "boolean":
            return "true" if value else "false"
        if scalar == "datetime":
            return f"parseDateTime({sw_string(js_string(value))})"
        if scalar == "uuid":
            return f"UUID(uuidString: {sw_string(js_string(value))})"
        if scalar != "any":
            return sw_string(js_string(value))
    # Lists, maps, objects and values of any shape: written in JSON
    return f"jsonValue({sw_string(json_text(value))}, as: {sw_type_of(type_ref, type_names)}.self)"


def _server_value(context: VaporContext, field: dict, operation: str) -> str | None:
    """The value the server gives a read-only field, or None when it gives none in this operation."""
    if field["access"] != "readOnly" or field.get("server") == "key":
        return None

    def now() -> str:
        scalar = field["type"].get("scalar") if field["type"]["kind"] == "scalar" else None
        if scalar == "date":
            return "ServerClock.today()"
        if scalar == "datetime":
            return "ServerClock.now()"
        return "ServerClock.text()"

    server = field.get("server")
    if server == "updated":
        return now()
    if operation != "create":
        return None
    if server == "created":
        return now()
    if server == "default":
        return _sw_default(context, field)
    return None


def _reference_checks(
    context: VaporContext, resource: dict, fields: list[dict], source: str, label: str, depth: int, counter: list[int]
) -> list[str]:
    """Swift statements that check every reference of an item, nested objects included."""
    checks: list[str] = []
    for field in fields:
        value = f"{source}.{property_name(field)}"
        where = f"{label}.{field['wire']}" if label else field["wire"]
        if field.get("reference"):
            target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
            repository = "repository" if field["reference"] == resource["name"] else f"{names(target)['one']}Repository"
            variable = f"reference{counter[0]}"
            counter[0] += 1
            message = f"No {field['reference']} has this key"
            failure = f"throw ApiError.invalid({sw_string(where)}, {sw_string(message)})"
            if field["type"]["kind"] == "array":
                checks.extend(
                    [
                        f"for {variable} in {value} ?? [] {{",
                        f"    if try await {repository}.get({variable}) == nil {{",
                        f"        {failure}",
                        "    }",
                        "}",
                    ]
                )
            else:
                checks.extend(
                    [
                        f"if let {variable} = {value}, try await {repository}.get({variable}) == nil {{",
                        f"    {failure}",
                        "}",
                    ]
                )
            continue
        inner = inner_object(field["type"])
        spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None) if inner else None
        if not spec_object or depth > 3 or field["type"]["kind"] == "map":
            continue
        variable = f"item{depth}"
        nested = _reference_checks(context, resource, spec_object["fields"], variable, where, depth + 1, counter)
        if not nested:
            continue
        if field["type"]["kind"] == "array":
            checks.extend([f"for {variable} in {value} ?? [] {{", *(f"    {line}" for line in nested), "}"])
        elif field["type"]["kind"] == "object":
            checks.extend([f"if let {variable} = {value} {{", *(f"    {line}" for line in nested), "}"])
    return checks


def service_file(context: VaporContext, resource: dict) -> dict:
    name = names(resource)
    key = key_type(resource)
    key_name = property_name(key_field(resource))
    key_wire = key_field(resource)["wire"]
    needs = referenced_resources(context, resource)
    checks = _reference_checks(context, resource, resource["fields"], "item", "", 0, [0])
    client_key = resource["key"]["generated"] is None
    operations = {endpoint["operation"] for endpoint in resource["endpoints"]}
    custom_with_key = any(
        endpoint["operation"] == "custom"
        and any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        for endpoint in resource["endpoints"]
    )
    uses_find = bool(operations & {"get", "replace", "update", "delete"}) or custom_with_key
    uses_apply = "create" in operations or "replace" in operations
    uses_changes = "update" in operations
    uses_checks = bool(checks) and (uses_apply or uses_changes)
    methods: list[str] = []
    if uses_find:
        methods.append(
            lines(
                f"    private func find(_ key: {key}) async throws -> {name['type']} {{",
                "        guard let item = try await repository.get(key) else {",
                f"            throw ApiError.notFound({sw_string(resource['singular'])})",
                "        }",
                "        return item",
                "    }",
            )
        )
    if uses_checks:
        methods.append(
            lines(
                "    /// Every reference must point to a stored item.",
                f"    private func checkReferences(_ item: {name['type']}) async throws {{",
                [f"        {line}" for line in checks],
                "    }",
            )
        )
    if uses_apply:
        assignments = []
        empty = "UUID()" if key == "UUID" else "0" if key == "Int64" else '""'
        for field in shape_fields(resource["fields"], "create"):
            if field["name"] == resource["key"]["field"] and not client_key:
                continue
            prop = property_name(field)
            if field["name"] == resource["key"]["field"]:
                assignments.append(f"        item.{prop} = data.{prop} ?? {empty}")
            elif "defaultValue" in field:
                assignments.append(
                    f"        item.{prop} = body.has({sw_string(field['wire'])}) ? data.{prop} : {_sw_default(context, field)}"
                )
            else:
                assignments.append(f"        item.{prop} = data.{prop}")
        methods.append(
            lines(
                "    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.",
                f"    private static func apply(_ item: inout {name['type']}, _ body: Body<{name['create']}>) {{",
                "        let data = body.value",
                assignments,
                "    }",
            )
        )
    if uses_changes:
        methods.append(
            lines(
                "    /// Sets the fields a partial change carries; the others stay as they are.",
                f"    private static func applyChanges(_ item: inout {name['type']}, _ body: Body<{name['update']}>) {{",
                "        let data = body.value",
                [
                    [
                        f"        if body.has({sw_string(field['wire'])}) {{",
                        f"            item.{property_name(field)} = data.{property_name(field)}",
                        "        }",
                    ]
                    for field in shape_fields(resource["fields"], "update")
                    if field["name"] != resource["key"]["field"]
                ],
                "    }",
            )
        )

    def server(operation: str) -> list[str]:
        result = []
        for field in resource["fields"]:
            value = _server_value(context, field, operation)
            if value is not None:
                result.append(f"        item.{property_name(field)} = {value}")
            elif operation == "create" and field["access"] == "readOnly" and field.get("server") == "pending":
                todo = field["todo"] if field.get("todo") is not None else f'fill "{field["name"]}"'
                result.append(f"        // TODO: {todo}")
        return result

    check = uses_checks and "        try await checkReferences(item)"
    exists = f"A {resource['singular']} with this key already exists"
    for endpoint in resource["endpoints"]:
        fn = endpoint_function(endpoint)
        doc = f"    /// {endpoint['summary']}."
        operation = endpoint["operation"]
        if operation == "list":
            methods.append(
                lines(
                    doc,
                    f"    func {fn}(_ query: ListQuery<{name['filters']}>) async throws -> ListResult<{name['type']}> {{",
                    "        try await repository.list(query)",
                    "    }",
                )
            )
        elif operation == "get":
            methods.append(
                lines(
                    doc,
                    f"    func {fn}(_ key: {key}) async throws -> {name['type']} {{",
                    "        try await find(key)",
                    "    }",
                )
            )
        elif operation == "create":
            methods.append(
                lines(
                    doc,
                    f"    func {fn}(_ body: Body<{name['create']}>) async throws -> {name['type']} {{",
                    f"        var item = {name['type']}()",
                    "        Self.apply(&item, body)",
                    client_key
                    and [
                        f"        if try await repository.get(item.{key_name}) != nil {{",
                        f"            throw ApiError.conflict({sw_string(exists)})",
                        "        }",
                    ],
                    check,
                    server("create"),
                    "        return try await repository.add(item)",
                    "    }",
                )
            )
        elif operation == "replace":
            methods.append(
                lines(
                    f"    /// {endpoint['summary']}: every field the client may send takes the value of the body.",
                    f"    func {fn}(_ key: {key}, _ body: Body<{name['create']}>) async throws -> {name['type']} {{",
                    client_key
                    and [
                        f"        if body.value.{key_name} != key {{",
                        f'            throw ApiError.invalid({sw_string(key_wire)}, "The key cannot change")',
                        "        }",
                    ],
                    "        var item = try await find(key)",
                    "        Self.apply(&item, body)",
                    check,
                    server("replace"),
                    "        return try await repository.update(item)",
                    "    }",
                )
            )
        elif operation == "update":
            changes_key = client_key and key_field(resource)["access"] != "readOnly"
            methods.append(
                lines(
                    f"    /// {endpoint['summary']}: only the fields in the body change.",
                    f"    func {fn}(_ key: {key}, _ body: Body<{name['update']}>) async throws -> {name['type']} {{",
                    changes_key
                    and [
                        f"        if body.has({sw_string(key_wire)}) && body.value.{key_name} != key {{",
                        f'            throw ApiError.invalid({sw_string(key_wire)}, "The key cannot change")',
                        "        }",
                    ],
                    "        var item = try await find(key)",
                    "        Self.applyChanges(&item, body)",
                    check,
                    server("update"),
                    "        return try await repository.update(item)",
                    "    }",
                )
            )
        elif operation == "delete":
            methods.append(
                lines(
                    doc,
                    f"    func {fn}(_ key: {key}) async throws {{",
                    "        _ = try await find(key)",
                    "        try await repository.delete(key)",
                    "    }",
                )
            )
        elif operation == "custom":
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            body_class = (
                name["create"]
                if endpoint["input"] == "resource"
                else name["update"]
                if endpoint["input"] == "partial"
                else None
            )
            params = [
                item for item in (has_key and f"_ key: {key}", body_class and f"_ body: Body<{body_class}>") if item
            ]
            if endpoint["output"] == "none":
                returns = ""
            elif endpoint["output"] == "list":
                returns = f" -> [{name['type']}]"
            else:
                returns = f" -> {name['type']}"
            summary = endpoint["summary"]
            methods.append(
                lines(
                    doc,
                    f"    func {fn}({', '.join(params)}) async throws{returns} {{",
                    has_key and "        _ = try await find(key)",
                    f'        // TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    f"        throw ApiError.notImplemented({sw_string(f'{summary} is not written yet')})",
                    "    }",
                )
            )
    content = lines(
        *sw_header(f"Rules of {resource['plural']}: what each operation checks and changes.", ["Foundation"]),
        sw_doc(f"Rules of {resource['plural']}."),
        f"struct {name['service']}: Sendable {{",
        f"    let repository: any {name['repository']}",
        [f"    let {names(item)['one']}Repository: any {names(item)['repository']}" for item in needs],
        "",
        "\n\n".join(methods),
        "}",
    )
    return {
        "path": source_path(context.layout.resource(resource, "service"), name["service"]),
        "content": file_text(content),
    }


def _filter_read(context: VaporContext, field: dict) -> str:
    """The expression that reads a filter of the query string with the type of its field."""
    wire = sw_string(field["wire"])
    if field.get("reference"):
        key = key_type(next(item for item in context.spec["resources"] if item["name"] == field["reference"]))
        if key == "Int64":
            return f"try queryFilter(req, {wire}) {{ Int64($0) }}"
        if key == "UUID":
            return f"try queryFilter(req, {wire}, parseUUID)"
        return f"try queryFilter(req, {wire}) {{ $0 }}"
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        enum_type = sw_type(type_ref["name"])
        if item["valueType"] == "integer":
            return f"try queryFilter(req, {wire}) {{ Int64($0).flatMap({enum_type}.init(rawValue:)) }}"
        return f"try queryFilter(req, {wire}) {{ {enum_type}(rawValue: $0) }}"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return f"try queryFilter(req, {wire}) {{ {'Int64' if type_ref.get('bits') == 64 else 'Int32'}($0) }}"
        if scalar == "float":
            return f"try queryFilter(req, {wire}) {{ Double($0) }}"
        if scalar == "decimal":
            return f"try queryFilter(req, {wire}) {{ Double($0) == nil ? nil : Decimal(string: $0) }}"
        if scalar == "boolean":
            return f"try queryFilter(req, {wire}, parseBool)"
        if scalar == "date":
            return f"try queryFilter(req, {wire}, parseDate)"
        if scalar == "datetime":
            return f"try queryFilter(req, {wire}, parseDateTime)"
        if scalar == "uuid":
            return f"try queryFilter(req, {wire}, parseUUID)"
    return f"try queryFilter(req, {wire}) {{ $0 }}"


_PARAMETER = re.compile(r"^\{(.+)\}$")


def _path_components(path: str) -> str:
    """The path components of an endpoint for Vapor: "customers", ":id"."""
    parts = [part for part in path.split("/") if part != ""]
    return ", ".join(sw_string(_PARAMETER.sub(r":\1", part)) for part in parts)


def controller_file(context: VaporContext, resource: dict) -> dict:
    name = names(resource)
    scalar = resource["key"]["type"].get("scalar")
    key_reader = "intKey" if scalar == "integer" else "uuidKey" if scalar == "uuid" else "textKey"
    filter_struct = filter_fields(resource)
    handlers = []
    for endpoint in resource["endpoints"]:
        fn = endpoint_function(endpoint)
        body: list[str] = []
        if context.security and endpoint["access"] != "public":
            if endpoint["access"] == "roles" and context.settings["auth"] == "jwt":
                roles = ", ".join(sw_string(role) for role in endpoint["roles"])
                body.extend(["let auth = try await security.authenticate(req)", f"try auth.requireRoles([{roles}])"])
            else:
                body.append("_ = try await security.authenticate(req)")
        has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        if has_key:
            body.append(f"let key = try {key_reader}(req, {sw_string(resource['key']['param'])})")
        status = f"HTTPStatus(statusCode: {number_text(endpoint['status'])})"
        service = f"service.{fn}"
        operation = endpoint["operation"]
        if operation == "list":
            if endpoint["pagination"]:
                body.extend(
                    [
                        'let page = try intQuery(req, "page", default: 1, min: 1, max: nil)',
                        f'let size = try intQuery(req, "size", default: {number_text(PAGE_SIZE["default"])}, min: 1, max: {number_text(PAGE_SIZE["max"])})',
                    ]
                )
            own = [
                field for field in resource["fields"] if field["wire"] in endpoint["filters"] and field in filter_struct
            ]
            if own:
                body.append(f"var filters = {name['filters']}()")
                body.extend(f"filters.{property_name(field)} = {_filter_read(context, field)}" for field in own)
            else:
                body.append(f"let filters = {name['filters']}()")
            if endpoint["sort"]:
                choices = ", ".join(
                    choice for wire in endpoint["sort"] for choice in (sw_string(wire), sw_string(f"-{wire}"))
                )
                body.append(f'let sort = try choiceQuery(req, "sort", [{choices}])')
            sort = "sort" if endpoint["sort"] else "nil"
            if endpoint["pagination"]:
                body.extend(
                    [
                        f"let result = try await {service}(ListQuery(filters: filters, sort: {sort}, offset: (page - 1) * size, limit: size))",
                        f"return try jsonResponse({status}, PageResponse(items: result.items.map({name['response']}.init), total: result.total, page: page, size: size))",
                    ]
                )
            else:
                body.extend(
                    [
                        f"let result = try await {service}(ListQuery(filters: filters, sort: {sort}, offset: 0, limit: nil))",
                        f"return try jsonResponse({status}, result.items.map({name['response']}.init))",
                    ]
                )
        else:
            if endpoint["input"] != "none":
                body_class = name["update"] if endpoint["input"] == "partial" else name["create"]
                body.append(f"let body = try readBody(req, as: {body_class}.self, rules: {body_class}.rules)")
            args = ", ".join(item for item in (has_key and "key", endpoint["input"] != "none" and "body") if item)
            if operation in ("get", "create", "replace", "update"):
                body.append(f"return try jsonResponse({status}, {name['response']}(try await {service}({args})))")
            elif operation == "delete":
                body.extend([f"try await {service}(key)", f"return Response(status: {status})"])
            elif operation == "custom":
                if endpoint["output"] == "none" or endpoint["status"] == 204:
                    discard = "" if endpoint["output"] == "none" else "_ = "
                    body.extend([f"{discard}try await {service}({args})", f"return Response(status: {status})"])
                elif endpoint["output"] == "list":
                    body.append(
                        f"return try jsonResponse({status}, try await {service}({args}).map({name['response']}.init))"
                    )
                else:
                    body.append(f"return try jsonResponse({status}, {name['response']}(try await {service}({args})))")
        handlers.append(
            lines(
                f"    /// {endpoint['summary']}.",
                "    @Sendable",
                f"    func {fn}(req: Request) async throws -> Response {{",
                [f"        {line}" for line in body],
                "    }",
            )
        )
    routes = [
        f"        routes.on(.{endpoint['method']}, {_path_components(endpoint['path'])}, use: self.{endpoint_function(endpoint)})"
        for endpoint in resource["endpoints"]
    ]
    content = lines(
        *sw_header(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out.", ["Vapor"]),
        sw_doc(f"The routes of {resource['plural']}."),
        f"struct {name['controller']}: RouteCollection {{",
        f"    let service: {name['service']}",
        context.security and "    let security: Security",
        "",
        "    func boot(routes: any RoutesBuilder) throws {",
        routes,
        "    }",
        "",
        "\n\n".join(handlers),
        "}",
    )
    return {
        "path": source_path(context.layout.resource(resource, "controller"), name["controller"]),
        "content": file_text(content),
    }
