"""Services and routers of the FastAPI project. Mirrors web/src/core/generators/frameworks/fastapi/routes.ts.

The service of a resource holds its rules: items that must exist, keys that must not repeat, references that
must point to stored items, and the values the server fills (keys, timestamps). Business endpoints get a method
that answers 501 with a TODO where their logic goes.

The router only translates HTTP to service calls: parameters, bodies, status codes and protection.
"""

from ....js import number_text
from ....openapi.build import PAGE_SIZE
from ...common.text import file_text, indent, lines
from ...languages.python.python import PyImports, py_class, py_docstring, py_literal, py_name, py_string, py_type
from .app import inner_object, referenced_resources
from .context import FastApiContext, attr, classes, key_field, names


def function_name(endpoint: dict) -> str:
    """Python name of a service or route function: listCustomers → list_customers."""
    return py_name(endpoint["name"])


def _route_path(endpoint: dict) -> tuple[str, list[dict]]:
    """Python names of path parameters, and the route path that uses them."""
    params = [
        {"wire": param["name"], "name": py_name(param["name"]), "type": param["type"]}
        for param in endpoint["pathParams"]
    ]
    path = endpoint["path"]
    for param in params:
        path = path.replace(f"{{{param['wire']}}}", f"{{{param['name']}}}", 1)
    return path, params


def _reference_checks(
    context: FastApiContext, resource: dict, fields: list[dict], source: str, label: str, depth: int
) -> list[str]:
    """Python statements that check every reference of a set of values, nested objects included."""
    checks: list[str] = []
    for field in fields:
        value = f"{source}.get({py_string(attr(field))})"
        where = f"{label}.{field['wire']}" if label else field["wire"]
        if field.get("reference"):
            if field["reference"] == resource["name"]:
                repository = "self._repository"
            else:
                target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
                repository = f"self._{names(target)['many']}"

            def require(key: str, repository: str = repository, where: str = where, field: dict = field) -> str:
                return f"self._require({repository}, {key}, {py_string(where)}, {py_string(field['reference'])})"

            if field["type"]["kind"] == "array":
                checks.extend([f"for key in {value} or []:", f"    {require('key')}"])
            else:
                checks.append(require(value))
            continue
        inner = inner_object(field["type"])
        spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None) if inner else None
        if not spec_object or depth > 3:
            continue
        nested = _reference_checks(context, resource, spec_object["fields"], f"item{depth}", where, depth + 1)
        if not nested:
            continue
        if field["type"]["kind"] == "array":
            checks.extend([f"for item{depth} in {value} or []:", *(f"    {line}" for line in nested)])
        elif field["type"]["kind"] == "object":
            checks.extend(
                [f"if {value} is not None:", f"    item{depth} = {value}", *(f"    {line}" for line in nested)]
            )
    return checks


def _server_values(resource: dict, operation: str) -> list[str]:
    result: list[str] = []
    for field in resource["fields"]:
        if field["access"] != "readOnly" or field.get("server") == "key":
            continue
        name = py_string(attr(field))
        server = field.get("server")
        if server == "updated":
            result.append(f"values[{name}] = now")
        elif server == "created" and operation == "create":
            result.append(f"values[{name}] = now")
        elif server == "default" and operation == "create":
            result.append(f"values[{name}] = {py_literal(field.get('defaultValue'))}")
        elif server == "pending" and operation == "create":
            todo = field.get("todo") or f'fill "{field["name"]}"'
            result.extend([f"# TODO: {todo}", f"values[{name}] = None"])
    return result


def _uses_now(resource: dict, operation: str) -> bool:
    return any(
        field["access"] == "readOnly"
        and (field.get("server") == "updated" or (field.get("server") == "created" and operation == "create"))
        for field in resource["fields"]
    )


def service_file(context: FastApiContext, resource: dict) -> dict:
    imports = PyImports()
    imports.add("typing", "Any")
    name = classes(resource)
    repository_module = context.layout.resource(resource, "repository")["module"]
    schemas_module = context.layout.resource(resource, "schemas")["module"]
    imports.add(repository_module, name["repository"])
    imports.add("app.errors", "NotFoundError")
    key = key_field(resource)
    key_attr = attr(key)
    key_scalar = resource["key"]["type"]["scalar"]
    if key["type"]["kind"] == "scalar" and key_scalar == "uuid":
        key_py = "UUID"
    else:
        key_py = "int" if key_scalar == "integer" else "str"
    if key_py == "UUID":
        imports.add("uuid", "UUID")
    needs = referenced_resources(context, resource)
    writes = any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    has_references = (
        any(field.get("reference") for field in resource["fields"])
        or len(needs) > 0
        or len(_reference_checks(context, resource, resource["fields"], "values", "", 0)) > 0
    )
    extra = "".join(f", {names(target)['many']}: {classes(target)['repository']}" for target in needs)
    ctor = [
        f"    def __init__(self, repository: {name['repository']}{extra}) -> None:",
        "        self._repository = repository",
    ]
    for target in needs:
        imports.add(context.layout.resource(target, "repository")["module"], classes(target)["repository"])
        ctor.append(f"        self._{names(target)['many']} = {names(target)['many']}")
    methods: list[str] = [
        lines(
            f"    def _find(self, key: {key_py}) -> dict[str, Any]:",
            "        item = self._repository.get(key)",
            "        if item is None:",
            f"            raise NotFoundError({py_string(resource['singular'])})",
            "        return item",
        )
    ]
    if has_references and writes:
        imports.add("app.errors", "InvalidRequestError")
        methods.append(
            lines(
                "    @staticmethod",
                "    def _require(repository: Any, key: Any, field: str, model: str) -> None:",
                '        """A reference must point to a stored item."""',
                "        if key is not None and repository.get(key) is None:",
                '            raise InvalidRequestError(field, f"No {model} has this key")',
            )
        )
        checks = _reference_checks(context, resource, resource["fields"], "values", "", 0)
        methods.append(
            lines(
                "    def _check_references(self, values: dict[str, Any]) -> None:",
                [f"        {line}" for line in checks] if checks else "        pass",
            )
        )
    check = "        self._check_references(values)" if has_references and writes else False

    def now_line(operation: str):
        if not _uses_now(resource, operation):
            return False
        imports.add("datetime", "UTC", "datetime")
        return "        now = datetime.now(UTC)"

    def server_lines(operation: str) -> list[str]:
        return [f"        {line}" for line in _server_values(resource, operation)]

    client_key = resource["key"]["generated"] is None
    for endpoint in resource["endpoints"]:
        fn = function_name(endpoint)
        has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        key_arg = f"key: {key_py}" if has_key else None
        operation = endpoint["operation"]
        summary = endpoint["summary"]
        if operation == "list":
            methods.append(
                lines(
                    f"    def {fn}(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:",
                    f'        """{summary}: `sort` is a JSON field name, with a leading "-" for descending order."""',
                    "        order = None",
                    "        if sort:",
                    '            descending = sort.startswith("-")',
                    '            order = (_SORT_FIELDS[sort.lstrip("-")], descending)',
                    "        return self._repository.list(filters, order, offset, limit)",
                )
            )
        elif operation == "get":
            methods.append(
                lines(
                    f"    def {fn}(self, key: {key_py}) -> dict[str, Any]:",
                    f'        """{summary}."""',
                    "        return self._find(key)",
                )
            )
        elif operation == "create":
            conflict = f"A {resource['singular']} with this key already exists"
            imports.add(schemas_module, name["create"])
            if client_key:
                imports.add("app.errors", "ConflictError")
            methods.append(
                lines(
                    f"    def {fn}(self, data: {name['create']}) -> dict[str, Any]:",
                    f'        """{summary}."""',
                    "        values = data.model_dump()",
                    client_key
                    and [
                        f"        if self._repository.get(values[{py_string(key_attr)}]) is not None:",
                        f"            raise ConflictError({py_string(conflict)})",
                    ],
                    check,
                    now_line("create"),
                    server_lines("create"),
                    "        return self._repository.add(values)",
                )
            )
        elif operation == "replace":
            imports.add(schemas_module, name["create"])
            if client_key:
                imports.add("app.errors", "InvalidRequestError")
            methods.append(
                lines(
                    f"    def {fn}(self, key: {key_py}, data: {name['create']}) -> dict[str, Any]:",
                    f'        """{summary}: every field the client may send takes the value of the body."""',
                    "        self._find(key)",
                    "        values = data.model_dump()",
                    client_key
                    and [
                        f"        if values[{py_string(key_attr)}] != key:",
                        f'            raise InvalidRequestError({py_string(key["wire"])}, "The key cannot change")',
                    ],
                    check,
                    now_line("replace"),
                    server_lines("replace"),
                    "        return self._repository.update(key, values)",
                )
            )
        elif operation == "update":
            imports.add(schemas_module, name["update"])
            update_key = client_key and key["access"] != "readOnly"
            if update_key:
                imports.add("app.errors", "InvalidRequestError")
            methods.append(
                lines(
                    f"    def {fn}(self, key: {key_py}, data: {name['update']}) -> dict[str, Any]:",
                    f'        """{summary}: only the fields in the body change."""',
                    "        self._find(key)",
                    "        values = data.model_dump(exclude_unset=True)",
                    update_key
                    and [
                        f"        if {py_string(key_attr)} in values and values[{py_string(key_attr)}] != key:",
                        f'            raise InvalidRequestError({py_string(key["wire"])}, "The key cannot change")',
                    ],
                    check,
                    now_line("update"),
                    server_lines("update"),
                    "        return self._repository.update(key, values)",
                )
            )
        elif operation == "delete":
            methods.append(
                lines(
                    f"    def {fn}(self, key: {key_py}) -> None:",
                    f'        """{summary}."""',
                    "        self._find(key)",
                    "        self._repository.delete(key)",
                )
            )
        elif operation == "custom":
            data = {"resource": f"data: {name['create']}", "partial": f"data: {name['update']}"}.get(endpoint["input"])
            params = [param for param in (key_arg, data) if param]
            if endpoint["input"] == "resource":
                imports.add(schemas_module, name["create"])
            if endpoint["input"] == "partial":
                imports.add(schemas_module, name["update"])
            returns = {"none": "None", "list": "list[dict[str, Any]]"}.get(endpoint["output"], "dict[str, Any]")
            methods.append(
                lines(
                    f"    def {fn}(self{''.join(f', {param}' for param in params)}) -> {returns}:",
                    f'        """{summary}."""',
                    key_arg and "        item = self._find(key)",
                    f'        # TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    "        # `item` holds the stored values; return the result the endpoint describes."
                    if key_arg
                    else False,
                    f"        raise NotImplementedError({py_string(f'{summary} is not written yet')})",
                )
            )
    sorted_list = next(
        (endpoint for endpoint in resource["endpoints"] if endpoint["operation"] == "list" and endpoint["sort"]), None
    )
    if sorted_list:
        pairs = []
        for wire in sorted_list["sort"]:
            field = next(item for item in resource["fields"] if item["wire"] == wire)
            pairs.append(f"{py_string(wire)}: {py_string(attr(field))}")
        sort_map = (
            "# JSON names of the fields a list can be sorted by, and their Python names\n"
            f"_SORT_FIELDS = {{{', '.join(pairs)}}}"
        )
    elif any(endpoint["operation"] == "list" for endpoint in resource["endpoints"]):
        sort_map = "_SORT_FIELDS: dict[str, str] = {}"
    else:
        sort_map = None
    body = lines(
        f"class {name['service']}:", f'    """Rules of {resource["plural"]}."""', "", ctor, "", "\n\n".join(methods)
    )
    content = lines(
        py_docstring(f"Rules of {resource['plural']}: what each operation checks and changes."),
        "",
        imports.render(),
        "",
        ["", sort_map] if sort_map else False,
        "",
        "",
        body,
    )
    return {"path": context.layout.resource(resource, "service")["file"], "content": file_text(content)}


def _sort_literal(endpoint: dict, imports: PyImports) -> str:
    """Literal["name", "-name"] for the sort parameter."""
    imports.add("typing", "Literal")
    values = [text for wire in endpoint["sort"] for text in (py_string(wire), py_string(f"-{wire}"))]
    return f"Literal[{', '.join(values)}]"


def _protection(context: FastApiContext, endpoint: dict, imports: PyImports) -> str | None:
    auth = context.settings["auth"]
    if endpoint["access"] == "public" or auth == "none":
        return None
    imports.add("fastapi", "Depends")
    if auth == "apiKey":
        imports.add("app.security", "require_api_key")
        return "Depends(require_api_key)"
    if endpoint["access"] == "roles":
        imports.add("app.security", "require_roles")
        return f"Depends(require_roles({', '.join(map(py_string, endpoint['roles']))}))"
    imports.add("app.security", "current_principal")
    return "Depends(current_principal)"


class _SharedNames:
    def __init__(self, context: FastApiContext, imports: PyImports) -> None:
        self._module = context.layout.shared()["module"]
        self._imports = imports

    def object(self, name: str) -> str:
        self._imports.add(self._module, py_class(name))
        return py_class(name)

    def enum(self, name: str) -> str:
        self._imports.add(self._module, py_class(name))
        return py_class(name)


def router_file(context: FastApiContext, resource: dict) -> dict:
    imports = PyImports()
    imports.add("fastapi", "APIRouter", "Depends")
    name = classes(resource)
    variable = names(resource)
    schemas_module = context.layout.resource(resource, "schemas")["module"]
    imports.add(context.layout.resource(resource, "service")["module"], name["service"])
    imports.add("app.dependencies", f"get_{variable['one']}_service")
    imports.add(schemas_module, name["read"])
    shared_names = _SharedNames(context, imports)
    read = name["read"]
    routes = []
    for endpoint in resource["endpoints"]:
        path, params = _route_path(endpoint)
        args: list[str] = []
        for param in params:
            if param["name"] == py_name(resource["key"]["param"]):
                param_type = py_type(resource["key"]["type"], imports, shared_names)
            else:
                param_type = "str"
            if param["wire"] != param["name"]:
                imports.add("fastapi", "Path")
                args.append(f"{param['name']}: {param_type} = Path(alias={py_string(param['wire'])})")
            else:
                args.append(f"{param['name']}: {param_type}")
        key_param = next((param for param in params if param["wire"] == resource["key"]["param"]), None)
        if endpoint["input"] == "resource":
            imports.add(schemas_module, name["create"])
            args.append(f"data: {name['create']}")
        if endpoint["input"] == "partial":
            imports.add(schemas_module, name["update"])
            args.append(f"data: {name['update']}")
        filters: list[str] = []
        operation = endpoint["operation"]
        if operation == "list":
            imports.add("fastapi", "Query")
            if endpoint["pagination"]:
                args.extend(
                    [
                        "page: int = Query(1, ge=1)",
                        f"size: int = Query({PAGE_SIZE['default']}, ge=1, le={PAGE_SIZE['max']})",
                    ]
                )
            for wire in endpoint["filters"]:
                field = next(item for item in resource["fields"] if item["wire"] == wire)
                field_type = py_type(field["type"], imports, shared_names)
                param = f"filter_{attr(field)}"
                args.append(f"{param}: {field_type} | None = Query(None, alias={py_string(wire)})")
                filters.append(f"({py_string(attr(field))}, {param})")
            if endpoint["sort"]:
                args.append(f"sort: {_sort_literal(endpoint, imports)} | None = None")
        args.append(f"service: {name['service']} = Depends(get_{variable['one']}_service)")
        guard = _protection(context, endpoint, imports)
        status = number_text(endpoint["status"])
        decorator_args = [py_string(path)]
        if endpoint["output"] != "none" and endpoint["status"] != 204:
            if endpoint["output"] == "list":
                model = f"{read}Page" if endpoint["pagination"] else f"list[{read}]"
            else:
                model = read
            decorator_args.append(f"response_model={model}")
        decorator_args.extend(
            [
                f"status_code={status}",
                f"summary={py_string(endpoint['summary'])}",
                f"operation_id={py_string(endpoint['name'])}",
            ]
        )
        if guard:
            decorator_args.append(f"dependencies=[{guard}]")
        fn = function_name(endpoint)
        key = key_param["name"] if key_param else None
        sort_arg = "sort" if endpoint["sort"] else "None"
        if operation == "list":
            returns = f"{read}Page" if endpoint["pagination"] else f"list[{read}]"
            if endpoint["pagination"]:
                imports.add(schemas_module, f"{read}Page")
            body = [
                f"filters = {{name: value for name, value in ({', '.join(filters)},) if value is not None}}"
                if filters
                else "filters: dict[str, object] = {}",
                f"items, total = service.{fn}(filters, {sort_arg}, (page - 1) * size, size)"
                if endpoint["pagination"]
                else f"items, _ = service.{fn}(filters, {sort_arg}, 0, None)",
                f"return {read}Page(items=[{read}.model_validate(item) for item in items], total=total, page=page, size=size)"
                if endpoint["pagination"]
                else f"return [{read}.model_validate(item) for item in items]",
            ]
        elif operation in ("get", "create"):
            returns = read
            body = [f"return {read}.model_validate(service.{fn}({key if operation == 'get' else 'data'}))"]
        elif operation in ("replace", "update"):
            returns = read
            body = [f"return {read}.model_validate(service.{fn}({key}, data))"]
        elif operation == "delete":
            imports.add("fastapi", "Response")
            returns = "Response"
            body = [f"service.{fn}({key})", f"return Response(status_code={status})"]
        else:
            call_args = [arg for arg in (key, "data" if endpoint["input"] != "none" else None) if arg]
            call = f"service.{fn}({', '.join(call_args)})"
            if endpoint["output"] == "none" or endpoint["status"] == 204:
                imports.add("fastapi", "Response")
                returns = "Response"
                body = [call, f"return Response(status_code={status})"]
            elif endpoint["output"] == "list":
                returns = f"list[{read}]"
                body = [f"return [{read}.model_validate(item) for item in {call}]"]
            else:
                returns = read
                body = [f"return {read}.model_validate({call})"]
        if operation == "delete" or (operation == "custom" and returns == "Response"):
            decorator_args.append("response_class=Response")
        routes.append(
            lines(
                f"@router.{endpoint['method'].lower()}(",
                [f"    {arg}," for arg in decorator_args],
                ")",
                f"def {fn}(",
                [f"    {arg}," for arg in args],
                f") -> {returns}:",
                f"    {py_docstring(endpoint['summary'] + '.')}",
                indent("\n".join(body), 4),
            )
        )
    content = lines(
        py_docstring(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out."),
        "",
        imports.render(),
        "",
        f"router = APIRouter(tags=[{py_string(resource['plural'])}])",
        "",
        "",
        "\n\n\n".join(routes),
    )
    return {"path": context.layout.resource(resource, "router")["file"], "content": file_text(content)}


def page_class(resource: dict) -> str | None:
    """The page schema of a paginated list, appended to the resource's schemas module."""
    if not any(endpoint["pagination"] for endpoint in resource["endpoints"]):
        return None
    read = classes(resource)["read"]
    return lines(
        f"class {read}Page(BaseModel):",
        f'    """One page of {resource["plural"]}."""',
        "",
        f"    items: list[{read}]",
        "    total: int",
        "    page: int",
        "    size: int",
    )
