"""Services and controllers of the ASP.NET Core project. Mirrors web/src/core/generators/frameworks/aspnetCore/web.ts.

The service of a resource holds its rules: items that must exist, keys that must not repeat, references that must
point to stored items, and the values the server fills. Business endpoints get a method that throws
NotImplementedException (501) with a TODO where their logic goes. Null where the contract forbids it is rejected by
the request bodies themselves (Common/Payload.cs).

The controller only translates HTTP to service calls: parameters, bodies, status codes and protection.
"""

import re

from ....js import js_string, number_text
from ....openapi.build import PAGE_SIZE, shape_fields
from ...common.references import inner_object, referenced_resources
from ...common.samples import json_text
from ...common.text import file_text, lines
from ...languages.csharp.csharp import (
    CsUsings,
    cs_class,
    cs_doc,
    cs_header,
    cs_number,
    cs_pascal,
    cs_string,
    cs_type,
)
from .context import (
    AspNetContext,
    common_namespace,
    key_field,
    key_type,
    names,
    namespace_of,
    property_name,
    shared_names,
    source_path,
)
from .model import enum_member, field_type


def service_method(endpoint: dict) -> str:
    """The method of a service for an endpoint: listCustomers → ListCustomersAsync."""
    return f"{cs_pascal(endpoint['name'])}Async"


def _cs_name(name: str) -> str:
    pascal = cs_pascal(name)
    return pascal[:1].lower() + pascal[1:]


def _cs_default(context: AspNetContext, field: dict, usings: CsUsings) -> str:
    """A default value written in C# for the field's type."""
    value = field.get("defaultValue")
    if value is None:
        return "null"
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        usings.add(shared_names(context).namespace())
        return f"{cs_class(type_ref['name'])}.{enum_member(context, type_ref['name'], value)}"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return cs_number(value, "long" if type_ref.get("bits") == 64 else "int")
        if scalar == "float":
            return cs_number(value, "double")
        if scalar == "decimal":
            return cs_number(value, "decimal")
        if scalar == "boolean":
            return "true" if value else "false"
        if scalar == "date":
            usings.add("System.Globalization")
            return f"DateOnly.Parse({cs_string(js_string(value))}, CultureInfo.InvariantCulture)"
        if scalar == "datetime":
            usings.add("System.Globalization")
            return f"DateTimeOffset.Parse({cs_string(js_string(value))}, CultureInfo.InvariantCulture)"
        if scalar == "uuid":
            return f"Guid.Parse({cs_string(js_string(value))})"
        if scalar == "binary":
            return f"Convert.FromBase64String({cs_string(js_string(value))})"
        if scalar in ("string", "time", "duration"):
            return cs_string(js_string(value))
    # Lists, maps, objects and values of any shape: written in JSON
    usings.add(common_namespace(context))
    return f"JsonValues.Parse<{cs_type(type_ref, usings, shared_names(context), False)}>({cs_string(json_text(value))})"


def _server_value(context: AspNetContext, field: dict, operation: str, usings: CsUsings) -> str | None:
    """The value the server gives a read-only field, or None when it gives none in this operation."""
    if field["access"] != "readOnly" or field.get("server") == "key":
        return None

    def now() -> str:
        usings.add(common_namespace(context))
        scalar = field["type"].get("scalar") if field["type"]["kind"] == "scalar" else None
        if scalar == "date":
            return "Clock.Today()"
        if scalar == "datetime":
            return "Clock.Now()"
        return "Clock.Text()"

    server = field.get("server")
    if server == "updated":
        return now()
    if operation != "create":
        return None
    if server == "created":
        return now()
    if server == "default":
        return _cs_default(context, field, usings)
    return None


def _reference_checks(
    context: AspNetContext,
    resource: dict,
    fields: list[dict],
    owner: str,
    source: str,
    label: str,
    depth: int,
    counter: list[int],
) -> list[str]:
    """C# statements that check every reference of an item, nested objects included."""
    checks: list[str] = []
    for field in fields:
        value = f"{source}.{property_name(field, owner)}"
        where = f"{label}.{field['wire']}" if label else field["wire"]
        if field.get("reference"):
            repository = (
                "repository" if field["reference"] == resource["name"] else f"{_cs_name(field['reference'])}Repository"
            )
            variable = f"reference{counter[0]}"
            counter[0] += 1
            message = cs_string(f"No {field['reference']} has this key")
            failure = f"throw ApiException.Invalid({cs_string(where)}, {message});"
            if field["type"]["kind"] == "array":
                checks.extend(
                    [
                        f"foreach (var {variable} in {value} ?? [])",
                        "{",
                        f"    if (await {repository}.GetAsync({variable}) is null)",
                        "    {",
                        f"        {failure}",
                        "    }",
                        "}",
                    ]
                )
            else:
                checks.extend(
                    [
                        f"if ({value} is {{ }} {variable} && await {repository}.GetAsync({variable}) is null)",
                        "{",
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
        nested = _reference_checks(
            context, resource, spec_object["fields"], cs_class(spec_object["name"]), variable, where, depth + 1, counter
        )
        if not nested:
            continue
        if field["type"]["kind"] == "array":
            checks.extend([f"foreach (var {variable} in {value} ?? [])", "{", *(f"    {line}" for line in nested), "}"])
        elif field["type"]["kind"] == "object":
            checks.extend([f"if ({value} is {{ }} {variable})", "{", *(f"    {line}" for line in nested), "}"])
    return checks


def _body_key(resource: dict, value: str) -> str:
    """The value of a key the body carries, as the domain class holds it (never null)."""
    return f"{value}!" if key_type(resource) == "string" else f"{value}!.Value"


def service_file(context: AspNetContext, resource: dict) -> dict:
    relative = context.layout.resource(resource, "service")
    namespace = namespace_of(context, relative)
    name = names(resource)
    item_type = name["type"]
    dto = namespace_of(context, context.layout.resource(resource, "dto"))
    usings = CsUsings(namespace).add(
        namespace_of(context, context.layout.resource(resource, "model")),
        namespace_of(context, context.layout.resource(resource, "repository")),
        common_namespace(context),
    )
    key = key_type(resource)
    key_prop = property_name(key_field(resource), item_type)
    key_wire = key_field(resource)["wire"]
    needs = referenced_resources(context, resource)
    for target in needs:
        usings.add(namespace_of(context, context.layout.resource(target, "repository")))
    checks = _reference_checks(context, resource, resource["fields"], item_type, "item", "", 0, [0])
    writes = any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    create_fields = shape_fields(resource["fields"], "create")
    update_fields = shape_fields(resource["fields"], "update")
    client_key = resource["key"]["generated"] is None
    methods: list[str] = [
        lines(
            f"    private async Task<{item_type}> FindAsync({key} key) =>",
            f"        await repository.GetAsync(key) ?? throw ApiException.NotFound({cs_string(resource['singular'])});",
        )
    ]
    if writes:
        usings.add(dto)
        if checks:
            methods.append(
                lines(
                    "    /// <summary>Every reference must point to a stored item.</summary>",
                    f"    private async Task CheckReferencesAsync({item_type} item)",
                    "    {",
                    [f"        {line}" for line in checks],
                    "    }",
                )
            )
        applied = []
        for field in create_fields:
            if field["name"] == resource["key"]["field"] and not client_key:
                continue
            prop = property_name(field, item_type)
            if field["name"] == resource["key"]["field"]:
                applied.append(f"        item.{prop} = {_body_key(resource, f'data.{prop}')};")
                continue
            if "defaultValue" in field:
                value = f"data.Has({cs_string(field['wire'])}) ? data.{prop} : {_cs_default(context, field, usings)}"
            else:
                value = f"data.{prop}"
            applied.append(f"        item.{prop} = {value};")
        changes = [
            [
                f"        if (data.Has({cs_string(field['wire'])}))",
                "        {",
                f"            item.{property_name(field, item_type)} = data.{property_name(field, item_type)};",
                "        }",
            ]
            for field in update_fields
            if field["name"] != resource["key"]["field"]
        ]
        methods.append(
            lines(
                "    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>",
                f"    private static void Apply({item_type} item, {name['create']} data)",
                "    {",
                applied,
                "    }",
                "",
                "    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>",
                f"    private static void ApplyChanges({item_type} item, {name['update']} data)",
                "    {",
                changes,
                "    }",
            )
        )

    def server(operation: str) -> list[str]:
        result = []
        for field in resource["fields"]:
            value = _server_value(context, field, operation, usings)
            if value is not None:
                result.append(f"        item.{property_name(field, item_type)} = {value};")
            elif operation == "create" and field["access"] == "readOnly" and field.get("server") == "pending":
                todo = field.get("todo") if field.get("todo") is not None else f'fill "{field["name"]}"'
                result.append(f"        // TODO: {todo}")
        return result

    check = bool(checks) and "        await CheckReferencesAsync(item);"
    same_key = [
        f"        if (data.{key_prop} != key)",
        "        {",
        f'            throw ApiException.Invalid({cs_string(key_wire)}, "The key cannot change");',
        "        }",
    ]
    conflict = cs_string(f"A {resource['singular']} with this key already exists")
    for endpoint in resource["endpoints"]:
        fn = service_method(endpoint)
        doc = f"    /// <summary>{endpoint['summary']}.</summary>"
        operation = endpoint["operation"]
        if operation == "list":
            methods.append(
                lines(
                    doc,
                    f"    public Task<ListResult<{item_type}>> {fn}(ListQuery query) => repository.ListAsync(query);",
                )
            )
        elif operation == "get":
            methods.append(lines(doc, f"    public Task<{item_type}> {fn}({key} key) => FindAsync(key);"))
        elif operation == "create":
            methods.append(
                lines(
                    doc,
                    f"    public async Task<{item_type}> {fn}({name['create']} data)",
                    "    {",
                    f"        var item = new {item_type}();",
                    "        Apply(item, data);",
                    client_key
                    and [
                        f"        if (await repository.GetAsync(item.{key_prop}) is not null)",
                        "        {",
                        f"            throw ApiException.Conflict({conflict});",
                        "        }",
                    ],
                    check,
                    server("create"),
                    "        return await repository.AddAsync(item);",
                    "    }",
                )
            )
        elif operation == "replace":
            methods.append(
                lines(
                    f"    /// <summary>{endpoint['summary']}: every field the client may send takes the value of the body.</summary>",
                    f"    public async Task<{item_type}> {fn}({key} key, {name['create']} data)",
                    "    {",
                    "        var item = await FindAsync(key);",
                    client_key and same_key,
                    "        Apply(item, data);",
                    check,
                    server("replace"),
                    "        return await repository.UpdateAsync(item);",
                    "    }",
                )
            )
        elif operation == "update":
            changes_key = client_key and key_field(resource)["access"] != "readOnly"
            methods.append(
                lines(
                    f"    /// <summary>{endpoint['summary']}: only the fields in the body change.</summary>",
                    f"    public async Task<{item_type}> {fn}({key} key, {name['update']} data)",
                    "    {",
                    "        var item = await FindAsync(key);",
                    changes_key
                    and [
                        f"        if (data.Has({cs_string(key_wire)}) && data.{key_prop} != key)",
                        "        {",
                        f'            throw ApiException.Invalid({cs_string(key_wire)}, "The key cannot change");',
                        "        }",
                    ],
                    "        ApplyChanges(item, data);",
                    check,
                    server("update"),
                    "        return await repository.UpdateAsync(item);",
                    "    }",
                )
            )
        elif operation == "delete":
            methods.append(
                lines(
                    doc,
                    f"    public async Task {fn}({key} key)",
                    "    {",
                    "        await FindAsync(key);",
                    "        await repository.DeleteAsync(key);",
                    "    }",
                )
            )
        elif operation == "custom":
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            params = [
                f"{key} key" if has_key else None,
                f"{name['create']} data"
                if endpoint["input"] == "resource"
                else f"{name['update']} data"
                if endpoint["input"] == "partial"
                else None,
            ]
            if endpoint["input"] != "none":
                usings.add(dto)
            if endpoint["output"] == "none":
                returns = "Task"
            elif endpoint["output"] == "list":
                returns = f"Task<List<{item_type}>>"
            else:
                returns = f"Task<{item_type}>"
            summary = endpoint["summary"]
            methods.append(
                lines(
                    doc,
                    f"    public {'async ' if has_key else ''}{returns} {fn}({', '.join(item for item in params if item)})",
                    "    {",
                    has_key and "        await FindAsync(key);",
                    f'        // TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    f"        throw new NotImplementedException({cs_string(f'{summary} is not written yet')});",
                    "    }",
                )
            )
    parameters = [
        f"{name['repository']} repository",
        *(f"{names(target)['repository']} {_cs_name(target['name'])}Repository" for target in needs),
    ]
    content = lines(
        *cs_header(namespace, usings),
        cs_doc(f"Rules of {resource['plural']}: what each operation checks and changes."),
        f"public sealed class {name['service']}({', '.join(parameters)})",
        "{",
        "\n\n".join(methods),
        "}",
    )
    return {"path": source_path(context, relative, name["service"]), "content": file_text(content)}


def _authorize(context: AspNetContext, endpoint: dict, usings: CsUsings) -> str | None:
    if not context.security or endpoint["access"] == "public":
        return None
    usings.add("Microsoft.AspNetCore.Authorization")
    if endpoint["access"] == "roles" and context.settings["auth"] == "jwt":
        return f"[Authorize(Roles = {cs_string(','.join(endpoint['roles']))})]"
    return "[Authorize]"


def _unwrapped(type_name: str, param: str) -> str:
    """The value of a filter parameter, unwrapped from its nullable type."""
    if type_name.endswith("?") and type_name != "string?" and not type_name.startswith("List<"):
        return f"{param}.Value"
    return param


def _filter_param(context: AspNetContext, resource: dict, field: dict, usings: CsUsings) -> dict:
    """A query parameter of a filter, and how the controller turns it into the field's value."""
    param = f"{_cs_name(field['wire'])}Filter"
    binding = f"[FromQuery(Name = {cs_string(field['wire'])})]"
    if field["type"]["kind"] == "enum":
        enum_name = field["type"]["name"]
        item = next((entry for entry in context.spec["enums"] if entry["name"] == enum_name), None)
        integer = item is not None and item["valueType"] == "integer"
        usings.add(shared_names(context).namespace())
        converter = f"{'NumberEnumConverter' if integer else 'TextEnumConverter'}<{cs_class(enum_name)}>"
        return {
            "param": param,
            "declaration": f"{binding} {'long?' if integer else 'string?'} {param} = null",
            "value": f"{converter}.Parse({param}{'.Value' if integer else ''}) ?? "
            f'throw ApiException.Invalid({cs_string(field["wire"])}, "Unknown value")',
        }
    type_name = field_type(context, field, usings, resource)
    return {
        "param": param,
        "declaration": f"{binding} {type_name} {param} = null",
        "value": _unwrapped(type_name, param),
    }


_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\]")


def controller_file(context: AspNetContext, resource: dict) -> dict:
    relative = context.layout.resource(resource, "controller")
    namespace = namespace_of(context, relative)
    name = names(resource)
    dto = namespace_of(context, context.layout.resource(resource, "dto"))
    usings = CsUsings(namespace).add(
        "Microsoft.AspNetCore.Mvc",
        dto,
        namespace_of(context, context.layout.resource(resource, "service")),
    )
    key = key_type(resource)
    response = name["response"]
    methods = []
    for endpoint in resource["endpoints"]:
        fn = cs_pascal(endpoint["name"])
        call = service_method(endpoint)
        method = endpoint["method"]
        verb = f"Http{method[:1]}{method[1:].lower()}"
        params: list[str] = []
        optional: list[str] = []
        has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        if has_key:
            params.append(f"[FromRoute(Name = {cs_string(resource['key']['param'])})] {key} key")
        for param in endpoint["pathParams"]:
            if param["name"] != resource["key"]["param"]:
                params.append(f"[FromRoute(Name = {cs_string(param['name'])})] string {_cs_name(param['name'])}")
        if endpoint["input"] != "none":
            params.append(f"[FromBody] {name['update'] if endpoint['input'] == 'partial' else name['create']} data")
        body: list[str] = []
        status = number_text(endpoint["status"])
        operation = endpoint["operation"]
        if operation == "list":
            usings.add(common_namespace(context))
            if endpoint.get("pagination"):
                usings.add("System.ComponentModel.DataAnnotations")
                optional.extend(
                    [
                        "[FromQuery, Range(1, int.MaxValue)] int page = 1",
                        f"[FromQuery, Range(1, {number_text(PAGE_SIZE['max'])})] int size = {number_text(PAGE_SIZE['default'])}",
                    ]
                )
            filters = [
                _filter_param(
                    context, resource, next(field for field in resource["fields"] if field["wire"] == wire), usings
                )
                for wire in endpoint["filters"]
            ]
            optional.extend(item["declaration"] for item in filters)
            if endpoint["sort"]:
                allowed = "|".join(
                    _SPECIAL.sub(lambda match: "\\" + match.group(0), value)
                    for wire in endpoint["sort"]
                    for value in (wire, f"-{wire}")
                )
                optional.append(f"[FromQuery, Pattern({cs_string(f'^({allowed})$')})] string? sort = null")
            body.append("var filters = new Dictionary<string, object>();")
            for index, wire in enumerate(endpoint["filters"]):
                body.extend(
                    [
                        f"if ({filters[index]['param']} is not null)",
                        "{",
                        f"    filters[{cs_string(wire)}] = {filters[index]['value']};",
                        "}",
                    ]
                )
            sort = "sort" if endpoint["sort"] else "null"
            if endpoint.get("pagination"):
                body.extend(
                    [
                        f"var result = await service.{call}(ListQuery.Of(filters, {sort}, (page - 1) * size, size));",
                        f"return StatusCode({status}, new PageResponse<{response}>([.. result.Items.Select({response}.From)], result.Total, page, size));",
                    ]
                )
            else:
                body.extend(
                    [
                        f"var result = await service.{call}(ListQuery.Of(filters, {sort}));",
                        f"return StatusCode({status}, result.Items.Select({response}.From).ToList());",
                    ]
                )
        elif operation == "get":
            body.append(f"return StatusCode({status}, {response}.From(await service.{call}(key)));")
        elif operation == "create":
            body.append(f"return StatusCode({status}, {response}.From(await service.{call}(data)));")
        elif operation in ("replace", "update"):
            body.append(f"return StatusCode({status}, {response}.From(await service.{call}(key, data)));")
        elif operation == "delete":
            body.extend([f"await service.{call}(key);", f"return StatusCode({status});"])
        elif operation == "custom":
            arguments = [
                item for item in ("key" if has_key else None, "data" if endpoint["input"] != "none" else None) if item
            ]
            invocation = f"await service.{call}({', '.join(arguments)})"
            if endpoint["output"] == "none" or endpoint["status"] == 204:
                body.extend([f"{invocation};", f"return StatusCode({status});"])
            elif endpoint["output"] == "list":
                body.append(f"return StatusCode({status}, ({invocation}).Select({response}.From).ToList());")
            else:
                body.append(f"return StatusCode({status}, {response}.From({invocation}));")
        if endpoint["filters"] or endpoint["sort"]:
            usings.add(common_namespace(context))
        every = [*params, *optional]
        if not every:
            signature = [f"    public async Task<IActionResult> {fn}()"]
        elif len(every) == 1 and len(every[0]) < 70:
            signature = [f"    public async Task<IActionResult> {fn}({every[0]})"]
        else:
            signature = [
                f"    public async Task<IActionResult> {fn}(",
                [f"        {param}{')' if index == len(every) - 1 else ','}" for index, param in enumerate(every)],
            ]
        protection = _authorize(context, endpoint, usings)
        methods.append(
            lines(
                f"    /// <summary>{endpoint['summary']}.</summary>",
                f"    [{verb}({cs_string(endpoint['path'])})]",
                protection and f"    {protection}",
                signature,
                "    {",
                [f"        {line}" for line in body],
                "    }",
            )
        )
    content = lines(
        *cs_header(namespace, usings),
        cs_doc(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out."),
        "[ApiController]",
        f"public sealed class {name['controller']}({name['service']} service) : ControllerBase",
        "{",
        "\n\n".join(methods),
        "}",
    )
    return {"path": source_path(context, relative, name["controller"]), "content": file_text(content)}
