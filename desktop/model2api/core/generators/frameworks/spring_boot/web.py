"""Services and controllers of the Spring Boot project. Mirrors web/src/core/generators/frameworks/springBoot/web.ts.

The service of a resource holds its rules: items that must exist, keys that must not repeat, null sent where the
contract forbids it, references that must point to stored items, and the values the server fills. Business
endpoints get a method that answers 501 with a TODO where their logic goes.

The controller only translates HTTP to service calls: parameters, bodies, status codes and protection.
"""

import re

from ....js import coalesce, is_number, js_string, number_text
from ....openapi.build import PAGE_SIZE, shape_fields
from ...common.text import file_text, lines
from ...languages.java.java import (
    JavaImports,
    getter,
    java_class,
    java_constant,
    java_doc,
    java_name,
    java_string,
    setter,
)
from .context import SpringContext, common_package, key_field, key_type, names, prop, shared_names, source_path
from .model import field_type

_REGEX_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\]")


def _referenced_resources(context: SpringContext, resource: dict) -> list[dict]:
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


def _inner_object(type_ref: dict) -> str | None:
    if type_ref["kind"] == "object":
        return type_ref["name"]
    if type_ref["kind"] == "array":
        return _inner_object(type_ref["items"])
    if type_ref["kind"] == "map":
        return _inner_object(type_ref["value"])
    return None


def _java_default(context: SpringContext, field: dict, imports: JavaImports) -> str:
    """A default value written in Java for the field's type."""
    value = field.get("defaultValue")
    if value is None:
        return "null"
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        imports.add(shared_names(context).enum(type_ref["name"]))
        return f"{java_class(type_ref['name'])}.{java_constant(value)}"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return f"{js_string(value)}L" if type_ref.get("bits") == 64 else js_string(value)
        if scalar == "float":
            whole = is_number(value) and float(value).is_integer()
            return f"{number_text(value)}.0" if whole else js_string(value)
        if scalar == "decimal":
            imports.add("java.math.BigDecimal")
            return f"new BigDecimal({java_string(js_string(value))})"
        if scalar == "boolean":
            return js_string(value)
        if scalar == "date":
            imports.add("java.time.LocalDate")
            return f"LocalDate.parse({java_string(js_string(value))})"
        return java_string(js_string(value))
    return "null"


def _reference_checks(
    context: SpringContext, resource: dict, fields: list[dict], source, label: str, depth: int
) -> list[str]:
    """Java statements that check every reference of an item, nested objects included."""
    checks: list[str] = []
    for field in fields:
        value = source(field)
        where = f"{label}.{field['wire']}" if label else field["wire"]
        reference = field.get("reference")
        if reference:
            lookup = "repository::get" if reference == resource["name"] else f"{java_name(reference)}Repository::get"
            if field["type"]["kind"] == "array":
                checks.extend(
                    [
                        f"if ({value} != null) {{",
                        f"    for (var key : {value}) {{",
                        f"        require({lookup}, key, {java_string(where)}, {java_string(reference)});",
                        "    }",
                        "}",
                    ]
                )
            else:
                checks.append(f"require({lookup}, {value}, {java_string(where)}, {java_string(reference)});")
            continue
        inner = _inner_object(field["type"])
        spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None) if inner else None
        if not spec_object or depth > 3:
            continue
        variable = f"item{depth}"
        nested = _reference_checks(
            context,
            resource,
            spec_object["fields"],
            lambda child, variable=variable: f"{variable}.{prop(child)}()",
            where,
            depth + 1,
        )
        if not nested:
            continue
        if field["type"]["kind"] == "array":
            checks.extend(
                [
                    f"if ({value} != null) {{",
                    f"    for (var {variable} : {value}) {{",
                    *(f"        {line}" for line in nested),
                    "    }",
                    "}",
                ]
            )
        elif field["type"]["kind"] == "object":
            checks.extend(
                [f"if ({value} != null) {{", f"    var {variable} = {value};", *(f"    {line}" for line in nested), "}"]
            )
    return checks


def _server_value(context: SpringContext, field: dict, operation: str, imports: JavaImports) -> str | None:
    """The value the server gives a read-only field, or None when it gives none in this operation."""
    server = field.get("server")
    if field["access"] != "readOnly" or server == "key":
        return None

    def now() -> str:
        imports.add("java.time.ZoneOffset")
        if field["type"]["kind"] == "scalar" and field["type"]["scalar"] == "date":
            imports.add("java.time.LocalDate")
            return "LocalDate.now(ZoneOffset.UTC)"
        imports.add("java.time.OffsetDateTime", "java.time.temporal.ChronoUnit")
        # Microseconds: the precision databases keep, so a later read gives the same value
        return "OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MICROS)"

    if server == "updated":
        return now()
    if operation != "create":
        return None
    if server == "created":
        return now()
    if server == "default":
        return _java_default(context, field, imports)
    return None


def service_file(context: SpringContext, resource: dict) -> dict:
    package = context.layout.resource(resource, "service")
    name = names(resource)
    common = common_package(context)
    dto = context.layout.resource(resource, "dto")
    imports = JavaImports(package).add(
        f"{context.layout.resource(resource, 'model')}.{name['type']}",
        f"{context.layout.resource(resource, 'repository')}.{name['repository']}",
        f"{common}.ApiException",
        "org.springframework.stereotype.Service",
    )
    key = key_type(resource)
    if key == "UUID":
        imports.add("java.util.UUID")
    key_prop = prop(key_field(resource))
    key_wire = key_field(resource)["wire"]
    needs = _referenced_resources(context, resource)
    for target in needs:
        imports.add(f"{context.layout.resource(target, 'repository')}.{names(target)['repository']}")
    checks = _reference_checks(
        context, resource, resource["fields"], lambda field: f"item.{getter(prop(field))}()", "", 0
    )
    writes = any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    create_fields = shape_fields(resource["fields"], "create")
    update_fields = shape_fields(resource["fields"], "update")
    client_key = resource["key"].get("generated") is None
    conflict = java_string(f"A {resource['singular']} with this key already exists")
    methods: list[str] = [
        lines(
            f"    private {name['type']} find({key} key) {{",
            f"        return repository.get(key).orElseThrow(() -> ApiException.notFound({java_string(resource['singular'])}));",
            "    }",
        )
    ]
    if writes:
        imports.add(f"{dto}.{name['create']}", f"{dto}.{name['update']}")
        if checks:
            imports.add("java.util.Optional", "java.util.function.Function")
            methods.append(
                lines(
                    "    /** A reference must point to a stored item. */",
                    "    private static <K> void require(Function<K, Optional<?>> lookup, K key, String field, String model) {",
                    "        if (key != null && lookup.apply(key).isEmpty()) {",
                    '            throw ApiException.invalid(field, "No " + model + " has this key");',
                    "        }",
                    "    }",
                    "",
                    f"    private void checkReferences({name['type']} item) {{",
                    [f"        {line}" for line in checks],
                    "    }",
                )
            )

        # Fields the contract says cannot be null: a body may leave them out, but not send null
        def nullable(fields: list[dict], shape: str) -> list[str]:
            return [
                f"        rejectNull(data.has({java_string(field['wire'])}), data.{getter(prop(field))}(), {java_string(field['wire'])});"
                for field in fields
                if not field["nullable"] and (shape == "update" or not field["required"])
            ]

        def assignment(field: dict) -> str:
            value = f"data.{getter(prop(field))}()"
            if "defaultValue" in field:
                value = f"data.has({java_string(field['wire'])}) ? {value} : {_java_default(context, field, imports)}"
            return f"        item.{setter(prop(field))}({value});"

        methods.append(
            lines(
                "    private static void rejectNull(boolean sent, Object value, String field) {",
                "        if (sent && value == null) {",
                '            throw ApiException.invalid(field, "must not be null");',
                "        }",
                "    }",
                "",
                "    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */",
                f"    private void apply({name['type']} item, {name['create']} data) {{",
                nullable(create_fields, "create"),
                [
                    assignment(field)
                    for field in create_fields
                    if field["name"] != resource["key"]["field"] or client_key
                ],
                "    }",
            )
        )
        methods.append(
            lines(
                f"    private void applyChanges({name['type']} item, {name['update']} data) {{",
                nullable(update_fields, "update"),
                [
                    [
                        f"        if (data.has({java_string(field['wire'])})) {{",
                        f"            item.{setter(prop(field))}(data.{getter(prop(field))}());",
                        "        }",
                    ]
                    for field in update_fields
                ],
                "    }",
            )
        )

    def server(operation: str) -> list[str]:
        result: list[str] = []
        for field in resource["fields"]:
            value = _server_value(context, field, operation, imports)
            if value is not None:
                result.append(f"        item.{setter(prop(field))}({value});")
            elif operation == "create" and field["access"] == "readOnly" and field.get("server") == "pending":
                fallback = 'fill "' + field["name"] + '"'
                result.append(f"        // TODO: {coalesce(field.get('todo'), fallback)}")
        return result

    for endpoint in resource["endpoints"]:
        fn = java_name(endpoint["name"])
        operation = endpoint["operation"]
        summary = endpoint["summary"]
        if operation == "list":
            imports.add(f"{common}.ListQuery", f"{common}.ListResult")
            methods.append(
                lines(
                    f"    /** {summary}. */",
                    f"    public ListResult<{name['type']}> {fn}(ListQuery query) {{",
                    "        return repository.list(query);",
                    "    }",
                )
            )
        elif operation == "get":
            methods.append(
                lines(
                    f"    /** {summary}. */",
                    f"    public {name['type']} {fn}({key} key) {{",
                    "        return find(key);",
                    "    }",
                )
            )
        elif operation == "create":
            methods.append(
                lines(
                    f"    /** {summary}. */",
                    f"    public {name['type']} {fn}({name['create']} data) {{",
                    f"        {name['type']} item = new {name['type']}();",
                    "        apply(item, data);",
                    client_key
                    and [
                        f"        if (repository.get(item.{getter(key_prop)}()).isPresent()) {{",
                        f"            throw ApiException.conflict({conflict});",
                        "        }",
                    ],
                    bool(checks) and "        checkReferences(item);",
                    server("create"),
                    "        return repository.add(item);",
                    "    }",
                )
            )
        elif operation == "replace":
            methods.append(
                lines(
                    f"    /** {summary}: every field the client may send takes the value of the body. */",
                    f"    public {name['type']} {fn}({key} key, {name['create']} data) {{",
                    f"        {name['type']} item = find(key);",
                    client_key
                    and [
                        f"        if (!key.equals(data.{getter(key_prop)}())) {{",
                        f'            throw ApiException.invalid({java_string(key_wire)}, "The key cannot change");',
                        "        }",
                    ],
                    "        apply(item, data);",
                    bool(checks) and "        checkReferences(item);",
                    server("replace"),
                    "        return repository.update(item);",
                    "    }",
                )
            )
        elif operation == "update":
            changes_key = client_key and key_field(resource)["access"] != "readOnly"
            methods.append(
                lines(
                    f"    /** {summary}: only the fields in the body change. */",
                    f"    public {name['type']} {fn}({key} key, {name['update']} data) {{",
                    f"        {name['type']} item = find(key);",
                    changes_key
                    and [
                        f"        if (data.has({java_string(key_wire)}) && !key.equals(data.{getter(key_prop)}())) {{",
                        f'            throw ApiException.invalid({java_string(key_wire)}, "The key cannot change");',
                        "        }",
                    ],
                    "        applyChanges(item, data);",
                    bool(checks) and "        checkReferences(item);",
                    server("update"),
                    "        return repository.update(item);",
                    "    }",
                )
            )
        elif operation == "delete":
            methods.append(
                lines(
                    f"    /** {summary}. */",
                    f"    public void {fn}({key} key) {{",
                    "        find(key);",
                    "        repository.delete(key);",
                    "    }",
                )
            )
        elif operation == "custom":
            imports.add(f"{common}.NotImplementedException")
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            body_param = (
                f"{name['create']} data"
                if endpoint["input"] == "resource"
                else f"{name['update']} data"
                if endpoint["input"] == "partial"
                else None
            )
            params = [param for param in (f"{key} key" if has_key else None, body_param) if param]
            if endpoint["input"] != "none":
                imports.add(f"{dto}.{name['create']}", f"{dto}.{name['update']}")
            if endpoint["output"] == "list":
                imports.add("java.util.List")
            returns = (
                "void"
                if endpoint["output"] == "none"
                else f"List<{name['type']}>"
                if endpoint["output"] == "list"
                else name["type"]
            )
            methods.append(
                lines(
                    f"    /** {summary}. */",
                    f"    public {returns} {fn}({', '.join(params)}) {{",
                    has_key and "        find(key);",
                    f'        // TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    f"        throw new NotImplementedException({java_string(f'{summary} is not written yet')});",
                    "    }",
                )
            )
    fields_declared = [
        f"    private final {name['repository']} repository;",
        *(
            f"    private final {names(target)['repository']} {java_name(target['name'])}Repository;"
            for target in needs
        ),
    ]
    constructor_params = [
        f"{name['repository']} repository",
        *(f"{names(target)['repository']} {java_name(target['name'])}Repository" for target in needs),
    ]
    content = lines(
        f"package {package};",
        "",
        imports.render(),
        "",
        java_doc(f"Rules of {resource['plural']}: what each operation checks and changes."),
        "@Service",
        f"public class {name['service']} {{",
        "",
        fields_declared,
        "",
        f"    public {name['service']}({', '.join(constructor_params)}) {{",
        "        this.repository = repository;",
        [
            f"        this.{java_name(target['name'])}Repository = {java_name(target['name'])}Repository;"
            for target in needs
        ],
        "    }",
        "",
        "\n\n".join(methods),
        "}",
    )
    return {"path": source_path(package, name["service"]), "content": file_text(content)}


def _pre_authorize(context: SpringContext, endpoint: dict, imports: JavaImports) -> str | None:
    if not context.security or endpoint["access"] == "public":
        return None
    imports.add("org.springframework.security.access.prepost.PreAuthorize")
    if endpoint["access"] == "roles" and context.settings["auth"] == "jwt":
        roles = ", ".join("'" + role.replace("'", "\\'") + "'" for role in endpoint["roles"])
        return f'@PreAuthorize("hasAnyRole({roles})")'
    return '@PreAuthorize("isAuthenticated()")'


def _filter_param(context: SpringContext, resource: dict, field: dict, imports: JavaImports) -> dict:
    """A query parameter of a filter: text, converted by the controller to the field's type."""
    param = f"{java_name(field['wire'])}Filter"
    imports.add("org.springframework.web.bind.annotation.RequestParam")
    wire = java_string(field["wire"])
    if field["type"]["kind"] == "enum":
        enum_name = field["type"]["name"]
        imports.add(shared_names(context).enum(enum_name))
        spec_enum = next((item for item in context.spec["enums"] if item["name"] == enum_name), None)
        integer = spec_enum is not None and spec_enum.get("valueType") == "integer"
        return {
            "declaration": f"@RequestParam(name = {wire}, required = false) {'Integer' if integer else 'String'} {param}",
            "value": f"{param} == null ? null : {java_class(enum_name)}.fromValue({param})",
        }
    java = field_type(context, field, imports, resource)
    return {"declaration": f"@RequestParam(name = {wire}, required = false) {java} {param}", "value": param}


def _controller_method(context: SpringContext, resource: dict, endpoint: dict, imports: JavaImports) -> str:
    name = names(resource)
    dto = context.layout.resource(resource, "dto")
    common = common_package(context)
    key = key_type(resource)
    fn = java_name(endpoint["name"])
    method = endpoint["method"]
    mapping = f"{method[:1]}{method[1:].lower()}Mapping"
    imports.add(f"org.springframework.web.bind.annotation.{mapping}")
    params: list[str] = []
    key_param = resource["key"]["param"]
    has_key = any(param["name"] == key_param for param in endpoint["pathParams"])
    if has_key:
        imports.add("org.springframework.web.bind.annotation.PathVariable")
        params.append(f"@PathVariable({java_string(key_param)}) {key} key")
    for param in endpoint["pathParams"]:
        if param["name"] == key_param:
            continue
        imports.add("org.springframework.web.bind.annotation.PathVariable")
        params.append(f"@PathVariable({java_string(param['name'])}) String {java_name(param['name'])}")
    if endpoint["input"] != "none":
        body_class = name["update"] if endpoint["input"] == "partial" else name["create"]
        imports.add(
            "jakarta.validation.Valid", "org.springframework.web.bind.annotation.RequestBody", f"{dto}.{body_class}"
        )
        params.append(f"@Valid @RequestBody {body_class} data")
    body: list[str] = []
    status = endpoint["status"]
    operation = endpoint["operation"]
    response = name["response"]
    if operation == "list":
        imports.add(
            f"{common}.ListQuery",
            "java.util.HashMap",
            "java.util.Map",
            "org.springframework.web.bind.annotation.RequestParam",
        )
        if endpoint.get("pagination"):
            imports.add(
                "jakarta.validation.constraints.Min", "jakarta.validation.constraints.Max", f"{common}.PageResponse"
            )
            params.extend(
                [
                    '@RequestParam(defaultValue = "1") @Min(1) int page',
                    f'@RequestParam(defaultValue = "{PAGE_SIZE["default"]}") @Min(1) @Max({PAGE_SIZE["max"]}) int size',
                ]
            )
        filters = [
            _filter_param(
                context, resource, next(field for field in resource["fields"] if field["wire"] == wire), imports
            )
            for wire in endpoint["filters"]
        ]
        params.extend(item["declaration"] for item in filters)
        if endpoint["sort"]:
            imports.add("jakarta.validation.constraints.Pattern")
            allowed = "|".join(
                _REGEX_SPECIAL.sub(lambda match: "\\\\" + match.group(0), value)
                for wire in endpoint["sort"]
                for value in (wire, f"-{wire}")
            )
            params.append(f"@RequestParam(required = false) @Pattern(regexp = {java_string(allowed)}) String sort")
        body.append("Map<String, Object> filters = new HashMap<>();")
        for wire, item in zip(endpoint["filters"], filters, strict=True):
            body.extend(
                [
                    f"if ({item['value'].split(' ')[0]} != null) {{",
                    f"    filters.put({java_string(wire)}, {item['value']});",
                    "}",
                ]
            )
        sort = "sort" if endpoint["sort"] else "null"
        if endpoint.get("pagination"):
            body.extend(
                [
                    f"var result = service.{fn}(ListQuery.of(filters, {sort}, (page - 1) * size, size));",
                    f"return ResponseEntity.status({status}).body(new PageResponse<>(result.items().stream().map({response}::from).toList(), result.total(), page, size));",
                ]
            )
        else:
            body.extend(
                [
                    f"var result = service.{fn}(ListQuery.of(filters, {sort}, 0, null));",
                    f"return ResponseEntity.status({status}).body(result.items().stream().map({response}::from).toList());",
                ]
            )
    elif operation == "get":
        body.append(f"return ResponseEntity.status({status}).body({response}.from(service.{fn}(key)));")
    elif operation == "create":
        body.append(f"return ResponseEntity.status({status}).body({response}.from(service.{fn}(data)));")
    elif operation in ("replace", "update"):
        body.append(f"return ResponseEntity.status({status}).body({response}.from(service.{fn}(key, data)));")
    elif operation == "delete":
        body.extend([f"service.{fn}(key);", f"return ResponseEntity.status({status}).build();"])
    elif operation == "custom":
        arguments = [
            argument
            for argument in ("key" if has_key else None, "data" if endpoint["input"] != "none" else None)
            if argument
        ]
        call = f"service.{fn}({', '.join(arguments)})"
        if endpoint["output"] == "none" or status == 204:
            body.extend([f"{call};", f"return ResponseEntity.status({status}).build();"])
        elif endpoint["output"] == "list":
            body.append(f"return ResponseEntity.status({status}).body({call}.stream().map({response}::from).toList());")
        else:
            body.append(f"return ResponseEntity.status({status}).body({response}.from({call}));")
    if operation == "delete" or ((endpoint["output"] == "none" or status == 204) and operation == "custom"):
        returns = "ResponseEntity<Void>"
    elif endpoint["output"] == "list":
        returns = (
            f"ResponseEntity<PageResponse<{response}>>"
            if endpoint.get("pagination")
            else f"ResponseEntity<java.util.List<{response}>>"
        )
    else:
        returns = f"ResponseEntity<{response}>"
    guard = _pre_authorize(context, endpoint, imports)
    return lines(
        f"    /** {endpoint['summary']}. */",
        f"    @{mapping}({java_string(endpoint['path'])})",
        guard and f"    {guard}",
        f"    public {returns} {fn}({', '.join(params)}) {{",
        [f"        {line}" for line in body],
        "    }",
    )


def controller_file(context: SpringContext, resource: dict) -> dict:
    package = context.layout.resource(resource, "controller")
    name = names(resource)
    dto = context.layout.resource(resource, "dto")
    imports = JavaImports(package).add(
        f"{context.layout.resource(resource, 'service')}.{name['service']}",
        f"{dto}.{name['response']}",
        "org.springframework.http.ResponseEntity",
        "org.springframework.web.bind.annotation.RestController",
    )
    if key_type(resource) == "UUID":
        imports.add("java.util.UUID")
    methods = [_controller_method(context, resource, endpoint, imports) for endpoint in resource["endpoints"]]
    content = lines(
        f"package {package};",
        "",
        imports.render(),
        "",
        java_doc(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out."),
        "@RestController",
        f"public class {name['controller']} {{",
        "",
        f"    private final {name['service']} service;",
        "",
        f"    public {name['controller']}({name['service']} service) {{",
        "        this.service = service;",
        "    }",
        "",
        "\n\n".join(methods),
        "}",
    )
    return {"path": source_path(package, name["controller"]), "content": file_text(content)}
