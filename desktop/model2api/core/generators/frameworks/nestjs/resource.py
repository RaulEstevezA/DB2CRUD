"""The files of one resource in the NestJS project: its repository (an interface bound to an injection token, with
the chosen implementation), its service with the rules, its controller and its Nest module. Mirrors
web/src/core/generators/frameworks/nestjs/resource.ts.
"""

import re

from ....js import number_text
from ....openapi.build import PAGE_SIZE
from ...common.text import file_text, indent, lines
from ...languages.typescript.typescript import (
    MEMORY_LIST_BODY,
    TsImports,
    ts_access,
    ts_doc,
    ts_literal,
    ts_name,
    ts_property,
    ts_string,
)
from .context import SHARED, NestContext, import_path, key_field, key_type, names, resource_path
from .dto import enum_constant
from .typeorm import typeorm_repository_block


def repository_file(context: NestContext, resource: dict) -> dict:
    path = resource_path(resource, "repository")
    name = names(resource)
    record = name["record"]
    key = key_type(resource)
    key_wire = key_field(resource)["wire"]
    plural = resource["plural"]
    generated = resource["key"]["generated"]
    imports = TsImports()
    imports.add_type(import_path(path, "src/common/listing.ts"), "ListQuery", "ListResult")
    imports.add_type(import_path(path, resource_path(resource, "dto")), record)
    new_type = f"Omit<{record}, {ts_string(key_wire)}>" if generated else record
    contract = lines(
        f"/** Injection token of the storage of {plural}. */",
        f"export const {name['token']} = Symbol({ts_string(name['repository'])})",
        "",
        f"/** Where {plural} are kept. The service depends only on this interface. */",
        f"export interface {name['repository']} {{",
        f"  list(query: ListQuery): Promise<ListResult<{record}>>",
        f"  get(key: {key}): Promise<{record} | undefined>",
        f"  add(values: {new_type}): Promise<{record}>",
        f"  update(key: {key}, values: Partial<{record}>): Promise<{record}>",
        f"  delete(key: {key}): Promise<void>",
        "}",
    )
    if context.pending:
        imports.add(import_path(path, "src/common/errors.ts"), "NotImplementedError")
        message = ts_string(f"The storage of {plural} is not written yet")

        def pending(signature: str) -> list[str]:
            return [
                f"  async {signature} {{",
                f"    // TODO: store {plural} in your database",
                f"    throw new NotImplementedError({message})",
                "  }",
            ]

        implementation = lines(
            f"/** Storage of {plural} to write: every method answers 501 until it is implemented. */",
            f"export class {name['pendingRepository']} implements {name['repository']} {{",
            pending(f"list(_query: ListQuery): Promise<ListResult<{record}>>"),
            "",
            pending(f"get(_key: {key}): Promise<{record} | undefined>"),
            "",
            pending(f"add(_values: {new_type}): Promise<{record}>"),
            "",
            pending(f"update(_key: {key}, _values: Partial<{record}>): Promise<{record}>"),
            "",
            pending(f"delete(_key: {key}): Promise<void>"),
            "}",
        )
    elif context.typeorm:
        implementation = typeorm_repository_block(resource, imports, path)
    else:
        if generated == "uuid":
            imports.add("node:crypto", "randomUUID")
        key_prop = ts_property(key_wire)
        if generated == "increment":
            assign = f"    const record = {{ ...structuredClone(values), {key_prop}: this.nextKey++ }} as {record}"
        elif generated == "uuid":
            assign = f"    const record = {{ ...structuredClone(values), {key_prop}: randomUUID() }} as {record}"
        else:
            assign = "    const record = structuredClone(values)"
        implementation = lines(
            f"/** Keeps {plural} in memory: they are lost when the application stops. Use it to try the API. */",
            f"export class {name['memory']} implements {name['repository']} {{",
            f"  private readonly items = new Map<{key}, {record}>()",
            generated == "increment" and "  private nextKey = 1",
            "",
            f"  async list(query: ListQuery): Promise<ListResult<{record}>> {{",
            MEMORY_LIST_BODY,
            "  }",
            "",
            f"  async get(key: {key}): Promise<{record} | undefined> {{",
            "    const item = this.items.get(key)",
            "    return item === undefined ? undefined : structuredClone(item)",
            "  }",
            "",
            f"  async add(values: {new_type}): Promise<{record}> {{",
            assign,
            f"    this.items.set({ts_access('record', key_wire)}, record)",
            "    return structuredClone(record)",
            "  }",
            "",
            f"  async update(key: {key}, values: Partial<{record}>): Promise<{record}> {{",
            "    const record = { ...this.items.get(key)!, ...structuredClone(values) }",
            "    this.items.set(key, record)",
            "    return structuredClone(record)",
            "  }",
            "",
            f"  async delete(key: {key}): Promise<void> {{",
            "    this.items.delete(key)",
            "  }",
            "}",
        )
    content = lines(ts_doc(f"Storage of {plural}."), "", imports.render(), "", contract, "", implementation)
    return {"path": path, "content": file_text(content)}


def _inner_object(type_ref: dict) -> str | None:
    kind = type_ref["kind"]
    if kind == "object":
        return type_ref["name"]
    if kind == "array":
        return _inner_object(type_ref["items"])
    if kind == "map":
        return _inner_object(type_ref["value"])
    return None


def referenced_resources(context: NestContext, resource: dict) -> list[dict]:
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
    context: NestContext, resource: dict, fields: list[dict], source: str, label: str, depth: int
) -> list[str]:
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
        else:
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


def service_file(context: NestContext, resource: dict) -> dict:
    path = resource_path(resource, "service")
    name = names(resource)
    record = name["record"]
    key = key_type(resource)
    key_wire = key_field(resource)["wire"]
    imports = TsImports().add("@nestjs/common", "Inject", "Injectable")
    dto = import_path(path, resource_path(resource, "dto"))
    errors = import_path(path, "src/common/errors.ts")
    repository = import_path(path, resource_path(resource, "repository"))
    imports.add(repository, name["token"])
    imports.add_type(repository, name["repository"])
    imports.add_type(dto, record)
    imports.add(errors, "notFound")
    needs = referenced_resources(context, resource)
    for target in needs:
        imports.add(import_path(path, resource_path(target, "repository")), names(target)["token"])
        imports.add_type(import_path(path, resource_path(target, "repository")), names(target)["repository"])
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

    def uses_now(operation: str):
        uses = any(
            field["access"] == "readOnly"
            and (field.get("server") == "updated" or (field.get("server") == "created" and operation == "create"))
            for field in resource["fields"]
        )
        return uses and "    const now = new Date().toISOString()"

    def write(operation: str, call: str):
        """The final call of a write: add( or update(key, , with the values the server fills."""
        values = _server_values(resource, operation)
        if values:
            return [
                f"    return this.repository.{call}{{",
                "      ...values,",
                [f"      {line}" for line in values],
                "    })",
            ]
        return f"    return this.repository.{call}values)"

    client_key = resource["key"]["generated"] is None
    for endpoint in resource["endpoints"]:
        fn = ts_name(endpoint["name"])
        summary = endpoint["summary"]
        operation = endpoint["operation"]
        if operation == "list":
            imports.add_type(import_path(path, "src/common/listing.ts"), "ListQuery", "ListResult")
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
            imports.add_type(dto, name["create"])
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
                    uses_now("create"),
                    write("create", "add("),
                    "  }",
                )
            )
        elif operation == "replace":
            imports.add_type(dto, name["create"])
            if client_key:
                imports.add(errors, "invalid")
            methods.append(
                lines(
                    f"  /** {summary}: every field the client may send takes the value of the body. */",
                    f"  async {fn}(key: {key}, values: {name['create']}): Promise<{record}> {{",
                    "    await this.find(key)",
                    client_key
                    and f"    if ({ts_access('values', key_wire)} !== key) throw invalid({ts_string(key_wire)}, 'The key cannot change')",
                    check,
                    uses_now("replace"),
                    write("replace", "update(key, "),
                    "  }",
                )
            )
        elif operation == "update":
            imports.add_type(dto, name["update"])
            changes_key = client_key and key_field(resource)["access"] != "readOnly"
            if changes_key:
                imports.add(errors, "invalid")
            access = ts_access("values", key_wire)
            values = _server_values(resource, "update")
            if values:
                returned = [
                    "    return this.repository.update(key, {",
                    f"      ...(values as Partial<{record}>),",
                    [f"      {line}" for line in values],
                    "    })",
                ]
            else:
                returned = f"    return this.repository.update(key, values as Partial<{record}>)"
            methods.append(
                lines(
                    f"  /** {summary}: only the fields in the body change. */",
                    f"  async {fn}(key: {key}, values: {name['update']}): Promise<{record}> {{",
                    "    await this.find(key)",
                    changes_key
                    and f"    if ({access} !== undefined && {access} !== key) throw invalid({ts_string(key_wire)}, 'The key cannot change')",
                    check,
                    uses_now("update"),
                    returned,
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
            values_param = {"resource": f"_values: {name['create']}", "partial": f"_values: {name['update']}"}.get(
                endpoint["input"]
            )
            params = [param for param in (f"key: {key}" if has_key else None, values_param) if param]
            if endpoint["input"] == "resource":
                imports.add_type(dto, name["create"])
            if endpoint["input"] == "partial":
                imports.add_type(dto, name["update"])
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
    params = [
        f"@Inject({name['token']}) private readonly repository: {name['repository']}",
        *(
            f"@Inject({names(target)['token']}) private readonly {names(target)['many']}: {names(target)['repository']}"
            for target in needs
        ),
    ]
    content = lines(
        ts_doc(f"Rules of {resource['plural']}: what each operation checks and changes."),
        "",
        imports.render(),
        "",
        "@Injectable()",
        f"export class {name['service']} {{",
        f"  constructor({', '.join(params)}) {{}}",
        "",
        "\n\n".join(methods),
        "}",
    )
    return {"path": path, "content": file_text(content)}


def _guard(context: NestContext, endpoint: dict, imports: TsImports, path: str) -> str | None:
    auth = context.settings["auth"]
    if endpoint["access"] == "public" or auth == "none":
        return None
    imports.add("@nestjs/common", "UseGuards")
    security = import_path(path, "src/common/security.ts")
    if auth == "apiKey":
        imports.add(security, "ApiKeyGuard")
        return "@UseGuards(new ApiKeyGuard())"
    imports.add(security, "JwtGuard")
    if endpoint["access"] == "roles":
        return f"@UseGuards(new JwtGuard([{', '.join(map(ts_string, endpoint['roles']))}]))"
    return "@UseGuards(new JwtGuard())"


def _query_decorators(context: NestContext, field: dict, imports: TsImports, path: str) -> tuple[list[str], str]:
    """class-validator decorators of a query parameter: query values are text, converted with class-transformer."""
    imports.add("class-validator", "IsOptional")
    if field.get("reference"):
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        scalar = target["key"]["type"]["scalar"]
    else:
        scalar = field["type"]["scalar"] if field["type"]["kind"] == "scalar" else None
    if field["type"]["kind"] == "enum":
        imports.add("class-validator", "IsIn")
        imports.add(import_path(path, SHARED), enum_constant(field["type"]["name"]))
        return ["@IsOptional()", f"@IsIn({enum_constant(field['type']['name'])})"], "string | number"
    if scalar in ("integer", "float", "decimal"):
        imports.add("class-validator", "IsInt" if scalar == "integer" else "IsNumber")
        imports.add("class-transformer", "Type")
        return ["@IsOptional()", "@Type(() => Number)", "@IsInt()" if scalar == "integer" else "@IsNumber()"], "number"
    if scalar == "boolean":
        imports.add("class-validator", "IsBoolean")
        imports.add("class-transformer", "Transform")
        transform = "@Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))"
        return ["@IsOptional()", transform, "@IsBoolean()"], "boolean"
    imports.add("class-validator", "IsString")
    return ["@IsOptional()", "@IsString()"], "string"


_PARAM = re.compile(r"\{([^}]+)\}")


def controller_file(context: NestContext, resource: dict) -> dict:
    path = resource_path(resource, "controller")
    name = names(resource)
    to_response = name["toResponse"]
    dto = import_path(path, resource_path(resource, "dto"))
    imports = TsImports().add("@nestjs/common", "Controller", "HttpCode", "Inject")
    imports.add(import_path(path, resource_path(resource, "service")), name["service"])
    imports.add(dto, to_response)
    imports.add_type(dto, name["type"])
    scalar = resource["key"]["type"]["scalar"]
    key_pipe = "ParseIntPipe" if scalar == "integer" else "ParseUUIDPipe" if scalar == "uuid" else None
    query_classes: list[str] = []
    lists = [item for item in resource["endpoints"] if item["operation"] == "list"]
    methods = []
    for endpoint in resource["endpoints"]:
        fn = ts_name(endpoint["name"])
        decorator = endpoint["method"][:1] + endpoint["method"][1:].lower()
        imports.add("@nestjs/common", decorator)
        params: list[str] = []
        has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        if has_key:
            imports.add("@nestjs/common", "Param")
            if key_pipe:
                imports.add("@nestjs/common", key_pipe)
            pipe = f", {key_pipe}" if key_pipe else ""
            params.append(f"@Param({ts_string(resource['key']['param'])}{pipe}) key: {key_type(resource)}")
        if endpoint["input"] != "none":
            imports.add("@nestjs/common", "Body")
            body_type = name["update"] if endpoint["input"] == "partial" else name["create"]
            imports.add(dto, body_type)
            params.append(f"@Body() values: {body_type}")
        body: list[str] = []
        returns = f"Promise<{name['type']}>"
        operation = endpoint["operation"]
        if operation == "list":
            imports.add("@nestjs/common", "Query")
            imports.add(import_path(path, "src/common/listing.ts"), "parseSort")
            position = next(index for index, item in enumerate(lists) if item is endpoint)
            query_name = f"{name['query']}{position or ''}"
            fields: list[str] = []
            if endpoint["pagination"]:
                imports.add("class-validator", "IsInt", "IsOptional", "Min", "Max")
                imports.add("class-transformer", "Type")
                fields.extend(
                    [
                        "  @IsOptional()\n  @Type(() => Number)\n  @IsInt()\n  @Min(1)\n  page: number = 1",
                        f"  @IsOptional()\n  @Type(() => Number)\n  @IsInt()\n  @Min(1)\n  @Max({PAGE_SIZE['max']})\n  size: number = {PAGE_SIZE['default']}",
                    ]
                )
            for wire in endpoint["filters"]:
                field = next(item for item in resource["fields"] if item["wire"] == wire)
                decorators, type_text = _query_decorators(context, field, imports, path)
                decorated = "\n".join(f"  {item}" for item in decorators)
                fields.append(f"{decorated}\n  {ts_property(wire)}?: {type_text}")
            if endpoint["sort"]:
                imports.add("class-validator", "IsIn", "IsOptional")
                values = ", ".join(
                    text for wire in endpoint["sort"] for text in (ts_string(wire), ts_string(f"-{wire}"))
                )
                fields.append(f"  @IsOptional()\n  @IsIn([{values}])\n  sort?: string")
            query_classes.append(
                lines(
                    f"/** Query parameters of {endpoint['summary'].lower()}. */",
                    f"class {query_name} {{",
                    "\n\n".join(fields),
                    "}",
                )
            )
            params.append(f"@Query() query: {query_name}")
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
                        f"const {{ items, total }} = await this.service.{fn}({{ filters, sort: {sort}, offset: (query.page - 1) * query.size, limit: query.size }})",
                        f"return {{ items: items.map({to_response}), total, page: query.page, size: query.size }}",
                    ]
                )
                returns = f"Promise<{{ items: {name['type']}[]; total: number; page: number; size: number }}>"
            else:
                body.extend(
                    [
                        f"const {{ items }} = await this.service.{fn}({{ filters, sort: {sort}, offset: 0 }})",
                        f"return items.map({to_response})",
                    ]
                )
                returns = f"Promise<{name['type']}[]>"
        elif operation == "get":
            body.append(f"return {to_response}(await this.service.{fn}(key))")
        elif operation == "create":
            body.append(f"return {to_response}(await this.service.{fn}(values))")
        elif operation in ("replace", "update"):
            body.append(f"return {to_response}(await this.service.{fn}(key, values))")
        elif operation == "delete":
            body.append(f"await this.service.{fn}(key)")
            returns = "Promise<void>"
        else:
            args = [
                arg for arg in ("key" if has_key else None, "values" if endpoint["input"] != "none" else None) if arg
            ]
            call = f"await this.service.{fn}({', '.join(args)})"
            if endpoint["output"] == "none" or endpoint["status"] == 204:
                body.append(call)
                returns = "Promise<void>"
            elif endpoint["output"] == "list":
                body.append(f"return ({call}).map({to_response})")
                returns = f"Promise<{name['type']}[]>"
            else:
                body.append(f"return {to_response}({call})")
        guard = _guard(context, endpoint, imports, path)
        route = _PARAM.sub(r":\1", endpoint["path"])
        methods.append(
            lines(
                f"  /** {endpoint['summary']}. */",
                f"  @{decorator}({ts_string(route)})",
                f"  @HttpCode({number_text(endpoint['status'])})",
                f"  {guard}" if guard else False,
                f"  async {fn}({', '.join(params)}): {returns} {{",
                indent("\n".join(body), 4),
                "  }",
            )
        )
    content = lines(
        ts_doc(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out."),
        "",
        imports.render(),
        "",
        bool(query_classes) and ["\n\n".join(query_classes), ""],
        "@Controller()",
        f"export class {name['controller']} {{",
        f"  constructor(@Inject({name['service']}) private readonly service: {name['service']}) {{}}",
        "",
        "\n\n".join(methods),
        "}",
    )
    return {"path": path, "content": file_text(content)}


def module_file(context: NestContext, resource: dict) -> dict:
    path = resource_path(resource, "module")
    name = names(resource)
    imports = TsImports().add("@nestjs/common", "Module")
    repository = import_path(path, resource_path(resource, "repository"))
    if context.pending:
        implementation = name["pendingRepository"]
    else:
        implementation = name["typeormRepository"] if context.typeorm else name["memory"]
    imports.add(repository, name["token"], implementation)
    imports.add(import_path(path, resource_path(resource, "controller")), name["controller"])
    imports.add(import_path(path, resource_path(resource, "service")), name["service"])
    needs = referenced_resources(context, resource)
    for target in needs:
        imports.add(import_path(path, resource_path(target, "module")), names(target)["module"])
    if context.typeorm:
        imports.add("@nestjs/typeorm", "TypeOrmModule")
        imports.add(import_path(path, resource_path(resource, "entity")), name["entity"])
    module_imports = [
        *([f"TypeOrmModule.forFeature([{name['entity']}])"] if context.typeorm else []),
        *(names(target)["module"] for target in needs),
    ]
    content = lines(
        ts_doc(f"Module of {resource['plural']}: its routes, its rules and the storage they use."),
        "",
        imports.render(),
        "",
        "@Module({",
        bool(module_imports) and f"  imports: [{', '.join(module_imports)}],",
        f"  controllers: [{name['controller']}],",
        f"  providers: [{name['service']}, {{ provide: {name['token']}, useClass: {implementation} }}],",
        f"  exports: [{name['token']}],",
        "})",
        f"export class {name['module']} {{}}",
    )
    return {"path": path, "content": file_text(content)}
