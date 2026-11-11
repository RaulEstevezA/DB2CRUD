"""Services and routes of the Ktor project. Mirrors web/src/core/generators/frameworks/ktor/web.ts.

The service of a resource holds its rules: items that must exist, keys that must not repeat, references that must
point to stored items, and the values the server fills. Business endpoints get a function that calls TODO() (501)
where their logic goes. Presence, null and the declared validations are checked on the request body itself
(common/Bodies.kt).

The routes only translate HTTP to service calls: parameters, bodies, status codes and protection.
"""

from ....js import js_string, number_text
from ....openapi.build import PAGE_SIZE, shape_fields
from ...common.references import inner_object, referenced_resources
from ...common.samples import json_text
from ...common.text import file_text, lines
from ...languages.kotlin.kotlin import (
    KtImports,
    kt_class,
    kt_constant,
    kt_doc,
    kt_header,
    kt_name,
    kt_number,
    kt_string,
)
from .context import KtorContext, common_package, key_field, key_type, names, property_name, source_path
from .model import serializer_of


def service_function(endpoint: dict) -> str:
    """The function of a service for an endpoint: listCustomers."""
    return kt_name(endpoint["name"])


def _target(context: KtorContext, name: str) -> dict:
    return next(item for item in context.spec["resources"] if item["name"] == name)


def _kt_default(context: KtorContext, field: dict, imports: KtImports) -> str:
    """A default value written in Kotlin for the field's type."""
    value = field.get("defaultValue")
    if value is None:
        return "null"
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        imports.add(f"{context.layout.shared()}.{kt_class(type_ref['name'])}")
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        used: set[str] = set()
        constants = []
        for entry in item["values"]:
            constant = kt_constant(entry)
            n = 2
            while constant in used:
                constant = f"{kt_constant(entry)}_{n}"
                n += 1
            used.add(constant)
            constants.append(constant)
        return f"{kt_class(type_ref['name'])}.{constants[item['values'].index(value)]}"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return kt_number(value, "Long" if type_ref.get("bits") == 64 else "Int")
        if scalar == "float":
            return kt_number(value, "Double")
        if scalar == "decimal":
            imports.add("java.math.BigDecimal")
            return f"BigDecimal({kt_string(js_string(value))})"
        if scalar == "boolean":
            return "true" if value else "false"
        if scalar == "date":
            imports.add("java.time.LocalDate")
            return f"LocalDate.parse({kt_string(js_string(value))})"
        if scalar == "datetime":
            imports.add("java.time.OffsetDateTime")
            return f"OffsetDateTime.parse({kt_string(js_string(value))}).toInstant()"
        if scalar == "uuid":
            imports.add("java.util.UUID")
            return f"UUID.fromString({kt_string(js_string(value))})"
        if scalar != "any":
            return kt_string(js_string(value))
    # Lists, maps, objects and values of any shape: written in JSON
    imports.add(f"{common_package(context)}.JsonFormat")
    return f"JsonFormat.decodeFromString({serializer_of(context, field, imports)}, {kt_string(json_text(value))})"


def _server_value(context: KtorContext, field: dict, operation: str, imports: KtImports) -> str | None:
    """The value the server gives a read-only field, or None when it gives none in this operation."""
    if field["access"] != "readOnly" or field.get("server") == "key":
        return None

    def now() -> str:
        imports.add(f"{common_package(context)}.Clock")
        scalar = field["type"].get("scalar") if field["type"]["kind"] == "scalar" else None
        if scalar == "date":
            return "Clock.today()"
        if scalar == "datetime":
            return "Clock.now()"
        return "Clock.text()"

    server = field.get("server")
    if server == "updated":
        return now()
    if operation != "create":
        return None
    if server == "created":
        return now()
    if server == "default":
        return _kt_default(context, field, imports)
    return None


def _reference_checks(
    context: KtorContext, resource: dict, fields: list[dict], source: str, label: str, depth: int, counter: list[int]
) -> list[str]:
    """Kotlin statements that check every reference of an item, nested objects included."""
    checks: list[str] = []
    for field in fields:
        value = f"{source}.{property_name(field)}"
        where = f"{label}.{field['wire']}" if label else field["wire"]
        call = "forEach" if field["type"]["kind"] == "array" else "let"
        if field.get("reference"):
            if field["reference"] == resource["name"]:
                repository = "repository"
            else:
                repository = f"{names(_target(context, field['reference']))['one']}Repository"
            variable = f"reference{counter[0]}"
            counter[0] += 1
            message = kt_string(f"No {field['reference']} has this key")
            failure = f"throw ApiException.invalid({kt_string(where)}, {message})"
            checks.extend(
                [f"{value}?.{call} {{ {variable} ->", f"    if ({repository}.get({variable}) == null) {failure}", "}"]
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
        checks.extend([f"{value}?.{call} {{ {variable} ->", *(f"    {line}" for line in nested), "}"])
    return checks


def service_file(context: KtorContext, resource: dict) -> dict:
    package = context.layout.resource(resource, "service")
    name = names(resource)
    item_type = name["type"]
    common = common_package(context)
    dto = context.layout.resource(resource, "dto")
    imports = KtImports(package).add(
        f"{context.layout.resource(resource, 'model')}.{item_type}",
        f"{context.layout.resource(resource, 'repository')}.{name['repository']}",
        f"{common}.ApiException",
    )
    key = key_type(resource)
    if key == "JsonUuid":
        imports.add(f"{common}.JsonUuid")
    key_prop = property_name(key_field(resource))
    key_wire = key_field(resource)["wire"]
    needs = referenced_resources(context, resource)
    for item in needs:
        imports.add(f"{context.layout.resource(item, 'repository')}.{names(item)['repository']}")
    checks = _reference_checks(context, resource, resource["fields"], "item", "", 0, [0])
    writes = any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    client_key = resource["key"]["generated"] is None
    functions = [
        lines(
            f"    private suspend fun find(key: {key}): {item_type} =",
            f"        repository.get(key) ?: throw ApiException.notFound({kt_string(resource['singular'])})",
        )
    ]
    if writes:
        imports.add(f"{common}.Body", f"{dto}.{name['create']}", f"{dto}.{name['update']}")
        if checks:
            functions.append(
                lines(
                    "    /** Every reference must point to a stored item. */",
                    f"    private suspend fun checkReferences(item: {item_type}) {{",
                    [f"        {line}" for line in checks],
                    "    }",
                )
            )
        applied = []
        for field in shape_fields(resource["fields"], "create"):
            if field["name"] == resource["key"]["field"] and not client_key:
                continue
            prop = property_name(field)
            if field["name"] == resource["key"]["field"]:
                applied.append(f"        item.{prop} = data.{prop}!!")
            elif "defaultValue" in field:
                applied.append(
                    f"        item.{prop} = if (body.has({kt_string(field['wire'])})) data.{prop} else {_kt_default(context, field, imports)}"
                )
            else:
                applied.append(f"        item.{prop} = data.{prop}")
        changes = [
            f"        if (body.has({kt_string(field['wire'])})) item.{property_name(field)} = data.{property_name(field)}"
            for field in shape_fields(resource["fields"], "update")
            if field["name"] != resource["key"]["field"]
        ]
        functions.append(
            lines(
                "    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */",
                f"    private fun apply(item: {item_type}, body: Body<{name['create']}>) {{",
                "        val data = body.value",
                applied,
                "    }",
                "",
                "    /** Sets the fields a partial change carries; the others stay as they are. */",
                f"    private fun applyChanges(item: {item_type}, body: Body<{name['update']}>) {{",
                "        val data = body.value",
                changes,
                "    }",
            )
        )

    def server(operation: str) -> list[str]:
        result = []
        for field in resource["fields"]:
            value = _server_value(context, field, operation, imports)
            if value is not None:
                result.append(f"        item.{property_name(field)} = {value}")
            elif operation == "create" and field["access"] == "readOnly" and field.get("server") == "pending":
                todo = field["todo"] if field.get("todo") is not None else f'fill "{field["name"]}"'
                result.append(f"        // TODO: {todo}")
        return result

    check = bool(checks) and "        checkReferences(item)"
    conflict = kt_string(f"A {resource['singular']} with this key already exists")
    for endpoint in resource["endpoints"]:
        fn = service_function(endpoint)
        doc = f"    /** {endpoint['summary']}. */"
        operation = endpoint["operation"]
        if operation == "list":
            imports.add(f"{common}.ListQuery", f"{common}.ListResult")
            functions.append(
                lines(doc, f"    suspend fun {fn}(query: ListQuery): ListResult<{item_type}> = repository.list(query)")
            )
        elif operation == "get":
            functions.append(lines(doc, f"    suspend fun {fn}(key: {key}): {item_type} = find(key)"))
        elif operation == "create":
            functions.append(
                lines(
                    doc,
                    f"    suspend fun {fn}(body: Body<{name['create']}>): {item_type} {{",
                    f"        val item = {item_type}()",
                    "        apply(item, body)",
                    client_key
                    and [
                        f"        if (repository.get(item.{key_prop}) != null) {{",
                        f"            throw ApiException.conflict({conflict})",
                        "        }",
                    ],
                    check,
                    server("create"),
                    "        return repository.add(item)",
                    "    }",
                )
            )
        elif operation == "replace":
            functions.append(
                lines(
                    f"    /** {endpoint['summary']}: every field the client may send takes the value of the body. */",
                    f"    suspend fun {fn}(key: {key}, body: Body<{name['create']}>): {item_type} {{",
                    "        val item = find(key)",
                    client_key
                    and [
                        f"        if (body.value.{key_prop} != key) throw ApiException.invalid({kt_string(key_wire)}, "
                        '"The key cannot change")'
                    ],
                    "        apply(item, body)",
                    check,
                    server("replace"),
                    "        return repository.update(item)",
                    "    }",
                )
            )
        elif operation == "update":
            changes_key = client_key and key_field(resource)["access"] != "readOnly"
            functions.append(
                lines(
                    f"    /** {endpoint['summary']}: only the fields in the body change. */",
                    f"    suspend fun {fn}(key: {key}, body: Body<{name['update']}>): {item_type} {{",
                    "        val item = find(key)",
                    changes_key
                    and [
                        f"        if (body.has({kt_string(key_wire)}) && body.value.{key_prop} != key) {{",
                        f'            throw ApiException.invalid({kt_string(key_wire)}, "The key cannot change")',
                        "        }",
                    ],
                    "        applyChanges(item, body)",
                    check,
                    server("update"),
                    "        return repository.update(item)",
                    "    }",
                )
            )
        elif operation == "delete":
            functions.append(
                lines(
                    doc,
                    f"    suspend fun {fn}(key: {key}) {{",
                    "        find(key)",
                    "        repository.delete(key)",
                    "    }",
                )
            )
        elif operation == "custom":
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            if endpoint["input"] == "resource":
                body_param = f"body: Body<{name['create']}>"
            elif endpoint["input"] == "partial":
                body_param = f"body: Body<{name['update']}>"
            else:
                body_param = None
            params = [item for item in (f"key: {key}" if has_key else None, body_param) if item]
            if endpoint["input"] != "none":
                imports.add(f"{common}.Body", f"{dto}.{name['create']}", f"{dto}.{name['update']}")
            if endpoint["output"] == "none":
                returns = ""
            elif endpoint["output"] == "list":
                returns = f": List<{item_type}>"
            else:
                returns = f": {item_type}"
            summary = endpoint["summary"]
            functions.append(
                lines(
                    doc,
                    f"    suspend fun {fn}({', '.join(params)}){returns} {{",
                    has_key and "        find(key)",
                    f'        // TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    f"        TODO({kt_string(f'{summary} is not written yet')})",
                    "    }",
                )
            )
    parameters = [
        f"private val repository: {name['repository']}",
        *(f"private val {names(item)['one']}Repository: {names(item)['repository']}" for item in needs),
    ]
    content = lines(
        *kt_header(package, imports),
        kt_doc(f"Rules of {resource['plural']}: what each operation checks and changes."),
        f"class {name['service']}(",
        [f"    {parameter}," for parameter in parameters],
        ") {",
        "\n\n".join(functions),
        "}",
    )
    return {"path": source_path(package, name["service"]), "content": file_text(content)}


def _filter_read(context: KtorContext, field: dict, imports: KtImports) -> str:
    """The expression that reads a filter of the query string with the type of its field."""
    wire = kt_string(field["wire"])
    common = common_package(context)

    def helper(fn: str) -> str:
        imports.add(f"{common}.{fn}")
        return fn

    if field.get("reference"):
        key = key_type(_target(context, field["reference"]))
        if key == "Long":
            return f"call.filter({wire}) {{ it.toLongOrNull() }}"
        if key == "JsonUuid":
            return f"call.filter({wire}, ::{helper('parseUuid')})"
        return f"call.filter({wire}) {{ it }}"
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        enum_class = kt_class(type_ref["name"])
        imports.add(f"{context.layout.shared()}.{enum_class}")
        if item["valueType"] == "integer":
            return f"call.filter({wire}) {{ text -> text.toLongOrNull()?.let {{ {enum_class}.fromValue(it) }} }}"
        return f"call.filter({wire}) {{ {enum_class}.fromValue(it) }}"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            parse = "toLongOrNull" if type_ref.get("bits") == 64 else "toIntOrNull"
            return f"call.filter({wire}) {{ it.{parse}() }}"
        if scalar == "float":
            return f"call.filter({wire}) {{ it.toDoubleOrNull() }}"
        if scalar == "decimal":
            return f"call.filter({wire}) {{ it.toBigDecimalOrNull() }}"
        if scalar == "boolean":
            return f"call.filter({wire}) {{ it.toBooleanStrictOrNull() }}"
        if scalar == "date":
            return f"call.filter({wire}, ::{helper('parseDate')})"
        if scalar == "datetime":
            return f"call.filter({wire}, ::{helper('parseDateTime')})"
        if scalar == "uuid":
            return f"call.filter({wire}, ::{helper('parseUuid')})"
    return f"call.filter({wire}) {{ it }}"


def _key_read(context: KtorContext, resource: dict, imports: KtImports) -> str:
    """The statement that reads the key of a path with its type: a malformed key is a 400."""
    param = kt_string(resource["key"]["param"])
    scalar = resource["key"]["type"]["scalar"]
    fn = "longKey" if scalar == "integer" else "uuidKey" if scalar == "uuid" else "textKey"
    imports.add(f"{common_package(context)}.{fn}")
    return f"val key = call.{fn}({param})"


def routes_file(context: KtorContext, resource: dict) -> dict:
    package = context.layout.resource(resource, "routes")
    name = names(resource)
    common = common_package(context)
    dto = context.layout.resource(resource, "dto")
    response = name["response"]
    imports = KtImports(package).add(
        "io.ktor.http.HttpStatusCode",
        "io.ktor.server.response.respond",
        "io.ktor.server.routing.Route",
        f"{context.layout.resource(resource, 'service')}.{name['service']}",
        f"{dto}.{response}",
    )
    routes = []
    for endpoint in resource["endpoints"]:
        fn = service_function(endpoint)
        verb = endpoint["method"].lower()
        imports.add(f"io.ktor.server.routing.{verb}")
        body: list[str] = []
        has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        if endpoint["access"] == "roles" and context.settings["auth"] == "jwt":
            imports.add(f"{context.base}.security.requireRoles")
            body.append(f"call.requireRoles({', '.join(kt_string(role) for role in endpoint['roles'])})")
        if has_key:
            body.append(_key_read(context, resource, imports))
        if endpoint["input"] != "none":
            body_class = name["update"] if endpoint["input"] == "partial" else name["create"]
            imports.add(f"{common}.receiveBody", f"{dto}.{body_class}")
            body.append(f"val body = call.receiveBody({body_class}.serializer(), {body_class}::rules)")
        status = f"HttpStatusCode.fromValue({number_text(endpoint['status'])})"
        operation = endpoint["operation"]
        if operation == "list":
            imports.add(f"{common}.ListQuery")
            if endpoint.get("pagination"):
                imports.add(f"{common}.intQuery", f"{common}.PageResponse")
                body.extend(
                    [
                        'val page = call.intQuery("page", 1, 1)',
                        f'val size = call.intQuery("size", {number_text(PAGE_SIZE["default"])}, 1, {number_text(PAGE_SIZE["max"])})',
                    ]
                )
            if endpoint["filters"]:
                imports.add(f"{common}.filter")
                body.append("val filters = buildMap<String, Any> {")
                for wire in endpoint["filters"]:
                    field = next(item for item in resource["fields"] if item["wire"] == wire)
                    body.append(f"    {_filter_read(context, field, imports)}?.let {{ put({kt_string(wire)}, it) }}")
                body.append("}")
            else:
                body.append("val filters = emptyMap<String, Any>()")
            if endpoint["sort"]:
                imports.add(f"{common}.choiceQuery")
                choices = ", ".join(kt_string(text) for wire in endpoint["sort"] for text in (wire, f"-{wire}"))
                body.append(f'val sort = call.choiceQuery("sort", listOf({choices}))')
            sort = "sort" if endpoint["sort"] else "null"
            if endpoint.get("pagination"):
                body.extend(
                    [
                        f"val result = service.{fn}(ListQuery.of(filters, {sort}, (page - 1) * size, size))",
                        f"call.respond({status}, PageResponse(result.items.map({response}::from), result.total, page, size))",
                    ]
                )
            else:
                body.extend(
                    [
                        f"val result = service.{fn}(ListQuery.of(filters, {sort}))",
                        f"call.respond({status}, result.items.map({response}::from))",
                    ]
                )
        elif operation == "get":
            body.append(f"call.respond({status}, {response}.from(service.{fn}(key)))")
        elif operation == "create":
            body.append(f"call.respond({status}, {response}.from(service.{fn}(body)))")
        elif operation in ("replace", "update"):
            body.append(f"call.respond({status}, {response}.from(service.{fn}(key, body)))")
        elif operation == "delete":
            body.extend([f"service.{fn}(key)", f"call.respond({status})"])
        elif operation == "custom":
            arguments = [
                item for item in ("key" if has_key else None, "body" if endpoint["input"] != "none" else None) if item
            ]
            invocation = f"service.{fn}({', '.join(arguments)})"
            if endpoint["output"] == "none" or endpoint["status"] == 204:
                body.extend([invocation, f"call.respond({status})"])
            elif endpoint["output"] == "list":
                body.append(f"call.respond({status}, {invocation}.map({response}::from))")
            else:
                body.append(f"call.respond({status}, {response}.from({invocation}))")
        handler = [f"{verb}({kt_string(endpoint['path'])}) {{", *(f"    {line}" for line in body), "}"]
        protected = context.security and endpoint["access"] != "public"
        if protected:
            imports.add("io.ktor.server.auth.authenticate", f"{context.base}.security.AUTH")
            block = ["authenticate(AUTH) {", *(f"    {line}" for line in handler), "}"]
        else:
            block = handler
        routes.append(lines(f"    // {endpoint['summary']}", [f"    {line}" for line in block]))
    content = lines(
        *kt_header(package, imports),
        kt_doc(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out."),
        f"fun Route.{name['routesFunction']}(service: {name['service']}) {{",
        "\n\n".join(routes),
        "}",
    )
    return {"path": source_path(package, name["routes"]), "content": file_text(content)}
