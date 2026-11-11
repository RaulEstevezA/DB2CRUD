"""Services and routes of the Express project. Mirrors web/src/core/generators/frameworks/express/routes.ts.

The service of a resource holds its rules: items that must exist, keys that must not repeat, references that
must point to stored items, and the values the server fills (keys, timestamps). Business endpoints get a method
that answers 501 with a TODO where their logic goes.

The routes only translate HTTP to service calls: parameters, bodies, status codes and protection.
"""

import re

from ....js import number_text
from ....openapi.build import PAGE_SIZE
from ...common.text import file_text, indent, lines
from ...languages.typescript.typescript import (
    TsImports,
    ts_access,
    ts_doc,
    ts_literal,
    ts_name,
    ts_property,
    ts_string,
    ts_type,
)
from .context import ExpressContext, import_path, key_field, key_type, names


def _inner_object(type_ref: dict) -> str | None:
    kind = type_ref["kind"]
    if kind == "object":
        return type_ref["name"]
    if kind == "array":
        return _inner_object(type_ref["items"])
    if kind == "map":
        return _inner_object(type_ref["value"])
    return None


def referenced_resources(context: ExpressContext, resource: dict) -> list[dict]:
    """Resources a resource refers to, directly or inside its embedded objects, other than itself."""
    found: set[str] = set()

    def visit(fields: list[dict], seen: frozenset[str]) -> None:
        for field in fields:
            if field.get("reference"):
                found.add(field["reference"])
            inner = _inner_object(field["type"])
            if inner and inner not in seen:
                spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None)
                if spec_object:
                    visit(spec_object["fields"], seen | {inner})

    visit(resource["fields"], frozenset())
    found.discard(resource["name"])
    return [item for item in context.spec["resources"] if item["name"] in found]


def _reference_checks(
    context: ExpressContext, resource: dict, fields: list[dict], source: str, label: str, depth: int
) -> list[str]:
    """TypeScript statements that check every reference of a set of values, nested objects included."""
    checks: list[str] = []
    for field in fields:
        value = ts_access(source, field["wire"])
        where = f"{label}.{field['wire']}" if label else field["wire"]
        if field.get("reference"):
            if field["reference"] == resource["name"]:
                repository = "this.repository"
            else:
                target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
                repository = f"this.{names(target)['many']}"
            arguments = f"{ts_string(where)}, {ts_string(field['reference'])}"
            if field["type"]["kind"] == "array":
                checks.append(f"for (const key of {value} ?? []) await this.require({repository}, key, {arguments})")
            else:
                checks.append(f"await this.require({repository}, {value}, {arguments})")
            continue
        inner = _inner_object(field["type"])
        spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None) if inner else None
        if not spec_object or depth > 3:
            continue
        nested = _reference_checks(context, resource, spec_object["fields"], f"item{depth}", where, depth + 1)
        if not nested:
            continue
        if field["type"]["kind"] == "array":
            checks.extend([f"for (const item{depth} of {value} ?? []) {{", *(f"  {line}" for line in nested), "}"])
        elif field["type"]["kind"] == "object":
            checks.extend(
                [f"if ({value}) {{", f"  const item{depth} = {value}", *(f"  {line}" for line in nested), "}"]
            )
    return checks


def _server_values(resource: dict, operation: str) -> list[str]:
    result: list[str] = []
    for field in resource["fields"]:
        if field["access"] != "readOnly" or field.get("server") == "key":
            continue
        prop = ts_property(field["wire"])
        server = field.get("server")
        if server == "updated" or (server == "created" and operation == "create"):
            result.append(f"{prop}: now,")
        elif server == "default" and operation == "create":
            result.append(f"{prop}: {ts_literal(field.get('defaultValue'))},")
        elif server == "pending" and operation == "create":
            todo = field.get("todo") or f'fill "{field["name"]}"'
            result.extend([f"// TODO: {todo}", f"{prop}: null,"])
    return result


def _uses_now(resource: dict, operation: str) -> bool:
    return any(
        field["access"] == "readOnly"
        and (field.get("server") == "updated" or (field.get("server") == "created" and operation == "create"))
        for field in resource["fields"]
    )


def service_file(context: ExpressContext, resource: dict) -> dict:
    path = context.layout.resource(resource, "service")
    name = names(resource)
    record = name["record"]
    key = key_type(resource)
    key_wire = key_field(resource)["wire"]
    imports = TsImports()
    schemas = import_path(path, context.layout.resource(resource, "schemas"))
    errors = import_path(path, "src/errors.ts")
    imports.add_type(import_path(path, context.layout.resource(resource, "repository")), name["repository"])
    imports.add_type(schemas, record)
    imports.add(errors, "notFound")
    needs = referenced_resources(context, resource)
    for target in needs:
        imports.add_type(import_path(path, context.layout.resource(target, "repository")), names(target)["repository"])
    checks = _reference_checks(context, resource, resource["fields"], "values", "", 0)
    has_checks = bool(checks) and any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    methods: list[str] = [
        lines(
            f"  private async find(key: {key}): Promise<{record}> {{",
            "    const item = await this.repository.get(key)",
            f"    if (item === undefined) throw notFound({ts_string(resource['singular'])})",
            "    return item",
            "  }",
        )
    ]
    if has_checks:
        imports.add(errors, "invalid")
        methods.append(
            lines(
                "  /** A reference must point to a stored item. */",
                "  private async require(repository: { get(key: never): Promise<unknown> }, key: unknown, field: string, model: string): Promise<void> {",
                "    if (key !== undefined && key !== null && (await repository.get(key as never)) === undefined) throw invalid(field, `No ${model} has this key`)",
                "  }",
                "",
                f"  private async checkReferences(values: Partial<{record}>): Promise<void> {{",
                [f"    {line}" for line in checks],
                "  }",
            )
        )
    check = "    await this.checkReferences(values)" if has_checks else False

    def now(operation: str):
        return _uses_now(resource, operation) and "    const now = new Date().toISOString()"

    def with_server(operation: str, call: str, spread: str, plain: str):
        values = _server_values(resource, operation)
        if values:
            return [
                f"    return this.repository.{call}",
                f"      ...{spread},",
                [f"      {line}" for line in values],
                "    })",
            ]
        return plain

    client_key = resource["key"]["generated"] is None
    for endpoint in resource["endpoints"]:
        fn = ts_name(endpoint["name"])
        summary = endpoint["summary"]
        operation = endpoint["operation"]
        if operation == "list":
            imports.add_type(import_path(path, "src/listing.ts"), "ListQuery", "ListResult")
            methods.append(
                lines(
                    f"  /** {summary}. */",
                    f"  {fn}(query: ListQuery): Promise<ListResult<{record}>> {{",
                    "    return this.repository.list(query)",
                    "  }",
                )
            )
        elif operation == "get":
            methods.append(
                lines(
                    f"  /** {summary}. */",
                    f"  {fn}(key: {key}): Promise<{record}> {{",
                    "    return this.find(key)",
                    "  }",
                )
            )
        elif operation == "create":
            imports.add_type(schemas, name["create"])
            if client_key:
                imports.add(errors, "conflict")
            conflict = ts_string(f"A {resource['singular']} with this key already exists")
            methods.append(
                lines(
                    f"  /** {summary}. */",
                    f"  async {fn}(values: {name['create']}): Promise<{record}> {{",
                    client_key
                    and [
                        f"    if ((await this.repository.get({ts_access('values', key_wire)})) !== undefined) {{",
                        f"      throw conflict({conflict})",
                        "    }",
                    ],
                    check,
                    now("create"),
                    with_server("create", "add({", "values", "    return this.repository.add(values)"),
                    "  }",
                )
            )
        elif operation == "replace":
            imports.add_type(schemas, name["create"])
            if client_key:
                imports.add(errors, "invalid")
            methods.append(
                lines(
                    f"  /** {summary}: every field the client may send takes the value of the body. */",
                    f"  async {fn}(key: {key}, values: {name['create']}): Promise<{record}> {{",
                    "    await this.find(key)",
                    client_key
                    and [
                        f"    if ({ts_access('values', key_wire)} !== key) throw invalid({ts_string(key_wire)}, 'The key cannot change')"
                    ],
                    check,
                    now("replace"),
                    with_server("replace", "update(key, {", "values", "    return this.repository.update(key, values)"),
                    "  }",
                )
            )
        elif operation == "update":
            imports.add_type(schemas, name["update"])
            changes_key = client_key and key_field(resource)["access"] != "readOnly"
            if changes_key:
                imports.add(errors, "invalid")
            access = ts_access("values", key_wire)
            methods.append(
                lines(
                    f"  /** {summary}: only the fields in the body change. */",
                    f"  async {fn}(key: {key}, values: {name['update']}): Promise<{record}> {{",
                    "    await this.find(key)",
                    changes_key
                    and [
                        f"    if ({access} !== undefined && {access} !== key) throw invalid({ts_string(key_wire)}, 'The key cannot change')"
                    ],
                    check,
                    now("update"),
                    with_server(
                        "update",
                        "update(key, {",
                        f"(values as Partial<{record}>)",
                        f"    return this.repository.update(key, values as Partial<{record}>)",
                    ),
                    "  }",
                )
            )
        elif operation == "delete":
            methods.append(
                lines(
                    f"  /** {summary}. */",
                    f"  async {fn}(key: {key}): Promise<void> {{",
                    "    await this.find(key)",
                    "    await this.repository.delete(key)",
                    "  }",
                )
            )
        elif operation == "custom":
            imports.add(errors, "NotImplementedError")
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            values = {"resource": f"_values: {name['create']}", "partial": f"_values: {name['update']}"}.get(
                endpoint["input"]
            )
            params = [param for param in (f"key: {key}" if has_key else None, values) if param]
            if endpoint["input"] == "resource":
                imports.add_type(schemas, name["create"])
            if endpoint["input"] == "partial":
                imports.add_type(schemas, name["update"])
            returns = {"none": "void", "list": f"{record}[]"}.get(endpoint["output"], record)
            methods.append(
                lines(
                    f"  /** {summary}. */",
                    f"  async {fn}({', '.join(params)}): Promise<{returns}> {{",
                    has_key and "    await this.find(key)",
                    f'    // TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    f"    throw new NotImplementedError({ts_string(summary + ' is not written yet')})",
                    "  }",
                )
            )
    constructor_params = [
        f"private readonly repository: {name['repository']}",
        *(f"private readonly {names(target)['many']}: {names(target)['repository']}" for target in needs),
    ]
    content = lines(
        ts_doc(f"Rules of {resource['plural']}: what each operation checks and changes."),
        "",
        imports.render(),
        "",
        f"export class {name['service']} {{",
        f"  constructor({', '.join(constructor_params)}) {{}}",
        "",
        "\n\n".join(methods),
        "}",
    )
    return {"path": path, "content": file_text(content)}


def _query_schema(type_ref: dict, context: ExpressContext, imports: TsImports, path: str) -> str:
    """The Zod schema a query value is read with: query strings are text, so numbers and booleans are converted."""
    if type_ref["kind"] == "enum":
        imports.add(import_path(path, context.layout.shared()), ts_type(type_ref["name"]))
        return ts_type(type_ref["name"])
    if type_ref["kind"] != "scalar":
        return "z.string()"
    scalar = type_ref["scalar"]
    if scalar == "integer":
        return "z.coerce.number().int()"
    if scalar in ("float", "decimal"):
        return "z.coerce.number()"
    if scalar == "boolean":
        return "z.enum(['true', 'false']).transform((value) => value === 'true')"
    return "z.uuid()" if scalar == "uuid" else "z.string()"


def _key_schema(resource: dict) -> str:
    """The parameter that identifies one item, read with its type."""
    scalar = resource["key"]["type"]["scalar"]
    if scalar == "integer":
        return "z.coerce.number().int()"
    return "z.uuid()" if scalar == "uuid" else "z.string()"


def _guard(context: ExpressContext, endpoint: dict, imports: TsImports, path: str) -> str | None:
    auth = context.settings["auth"]
    if endpoint["access"] == "public" or auth == "none":
        return None
    security = import_path(path, "src/security.ts")
    if auth == "apiKey":
        imports.add(security, "requireApiKey")
        return "requireApiKey"
    if endpoint["access"] == "roles":
        imports.add(security, "requireRoles")
        return f"requireRoles({', '.join(map(ts_string, endpoint['roles']))})"
    imports.add(security, "authenticate")
    return "authenticate"


_PARAM = re.compile(r"\{([^}]+)\}")


def routes_file(context: ExpressContext, resource: dict) -> dict:
    path = context.layout.resource(resource, "routes")
    name = names(resource)
    to_response = name["toResponse"]
    imports = TsImports()
    schemas = import_path(path, context.layout.resource(resource, "schemas"))
    imports.add("express", "Router")
    imports.add("zod", "z")
    imports.add_type(import_path(path, context.layout.resource(resource, "service")), name["service"])
    imports.add(schemas, to_response)
    key_param = resource["key"]["param"]
    routes = []
    for endpoint in resource["endpoints"]:
        route_path = _PARAM.sub(r":\1", endpoint["path"])
        fn = ts_name(endpoint["name"])
        has_key = any(param["name"] == key_param for param in endpoint["pathParams"])
        status = number_text(endpoint["status"])
        body: list[str] = []
        if has_key:
            body.append(f"const key = keyParam.parse(request.params[{ts_string(key_param)}])")
        if endpoint["input"] == "resource":
            imports.add(schemas, name["create"])
            body.append(f"const values = {name['create']}.parse(request.body)")
        if endpoint["input"] == "partial":
            imports.add(schemas, name["update"])
            body.append(f"const values = {name['update']}.parse(request.body)")
        operation = endpoint["operation"]
        if operation == "list":
            imports.add(import_path(path, "src/listing.ts"), "parseSort")
            query_fields: list[str] = []
            if endpoint["pagination"]:
                query_fields.extend(
                    [
                        "page: z.coerce.number().int().min(1).default(1),",
                        f"size: z.coerce.number().int().min(1).max({PAGE_SIZE['max']}).default({PAGE_SIZE['default']}),",
                    ]
                )
            for wire in endpoint["filters"]:
                field = next(item for item in resource["fields"] if item["wire"] == wire)
                query_fields.append(
                    f"{ts_property(wire)}: {_query_schema(field['type'], context, imports, path)}.optional(),"
                )
            if endpoint["sort"]:
                values = ", ".join(
                    text for wire in endpoint["sort"] for text in (ts_string(wire), ts_string(f"-{wire}"))
                )
                query_fields.append(f"sort: z.enum([{values}]).optional(),")
            if query_fields:
                inner = "\n".join(f"  {line}" for line in query_fields)
                body.append(f"const query = z.object({{\n{inner}\n}}).parse(request.query)")
            else:
                body.append("const query = {}")
            filters = [f"{ts_property(wire)}: {ts_access('query', wire)}" for wire in endpoint["filters"]]
            body.append(
                f"const filters = Object.fromEntries(Object.entries({{ {', '.join(filters)} }}).filter(([, value]) => value !== undefined))"
                if filters
                else "const filters = {}"
            )
            sort = "parseSort(query.sort)" if endpoint["sort"] else "undefined"
            if endpoint["pagination"]:
                body.extend(
                    [
                        f"const {{ items, total }} = await service.{fn}({{ filters, sort: {sort}, offset: (query.page - 1) * query.size, limit: query.size }})",
                        f"response.status({status}).json({{ items: items.map({to_response}), total, page: query.page, size: query.size }})",
                    ]
                )
            else:
                body.extend(
                    [
                        f"const {{ items }} = await service.{fn}({{ filters, sort: {sort}, offset: 0 }})",
                        f"response.status({status}).json(items.map({to_response}))",
                    ]
                )
            if not filters and not query_fields:
                body.remove("const query = {}")
        elif operation == "get":
            body.append(f"response.status({status}).json({to_response}(await service.{fn}(key)))")
        elif operation == "create":
            body.append(f"response.status({status}).json({to_response}(await service.{fn}(values)))")
        elif operation in ("replace", "update"):
            body.append(f"response.status({status}).json({to_response}(await service.{fn}(key, values)))")
        elif operation == "delete":
            body.extend([f"await service.{fn}(key)", f"response.status({status}).end()"])
        else:
            args = [
                arg for arg in ("key" if has_key else None, "values" if endpoint["input"] != "none" else None) if arg
            ]
            call = f"await service.{fn}({', '.join(args)})"
            if endpoint["output"] == "none" or endpoint["status"] == 204:
                body.extend([call, f"response.status({status}).end()"])
            elif endpoint["output"] == "list":
                body.append(f"response.status({status}).json(({call}).map({to_response}))")
            else:
                body.append(f"response.status({status}).json({to_response}({call}))")
        protection = _guard(context, endpoint, imports, path)
        handler = f"async (request, response) => {{\n{indent(chr(10).join(body), 2)}\n}}"
        handler_args = [arg for arg in (ts_string(route_path), protection, handler) if arg]
        routes.append(
            lines(f"// {endpoint['summary']}", f"router.{endpoint['method'].lower()}({', '.join(handler_args)})")
        )
    uses_key = any(
        any(param["name"] == key_param for param in endpoint["pathParams"]) for endpoint in resource["endpoints"]
    )
    content = lines(
        ts_doc(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out."),
        "",
        imports.render(),
        "",
        uses_key
        and [
            "/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */",
            f"const keyParam = {_key_schema(resource)}",
            "",
        ],
        f"export function {name['routes']}(service: {name['service']}): Router {{",
        "  const router = Router()",
        "",
        indent("\n\n".join(routes), 2),
        "",
        "  return router",
        "}",
    )
    return {"path": path, "content": file_text(content)}
