"""Services, views and URLs of the Django REST Framework project. Mirrors
web/src/core/generators/frameworks/djangoRest/views.ts.

The service of a resource holds its rules: items that must exist, keys that must not repeat, references inside
lists and embedded objects that must point to stored items. Business endpoints get a method that answers 501
with a TODO where their logic goes.

Views translate HTTP to service calls: one APIView per path, with the protection of each method.
"""

import re

from ....js import number_text
from ....openapi.build import PAGE_SIZE
from ...common.text import file_text, lines
from ...languages.python.python import py_class, py_name, py_string
from .context import DjangoContext, Modules, attr, is_foreign_key, key_field, module_of, names


def _inner_object(type_ref: dict) -> str | None:
    kind = type_ref["kind"]
    if kind == "object":
        return type_ref["name"]
    if kind == "array":
        return _inner_object(type_ref["items"])
    if kind == "map":
        return _inner_object(type_ref["value"])
    return None


def _reference_checks(
    context: DjangoContext, fields: list[dict], source: str, label: str, depth: int, nested: bool, module: dict
) -> list[str]:
    """Checks of references Django does not check itself: lists of keys and keys inside embedded objects."""
    checks: list[str] = []
    for field in fields:
        key = field["wire"] if nested else attr(field)
        value = f"{source}.get({py_string(key)})"
        where = f"{label}.{field['wire']}" if label else field["wire"]
        if field.get("reference") and (nested or not is_foreign_key(field)):
            target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
            model = names(target)["model"]
            module["imports"].add(module_of(context, target, "models"), model)
            if field["type"]["kind"] == "array":
                checks.extend([f"for key in {value} or []:", f"    _require({model}, key, {py_string(where)})"])
            else:
                checks.append(f"_require({model}, {value}, {py_string(where)})")
            continue
        inner = _inner_object(field["type"])
        spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None) if inner else None
        if not spec_object or depth > 3:
            continue
        inside = _reference_checks(context, spec_object["fields"], f"item{depth}", where, depth + 1, True, module)
        if not inside:
            continue
        if field["type"]["kind"] == "array":
            checks.extend([f"for item{depth} in {value} or []:", *(f"    {line}" for line in inside)])
        else:
            checks.extend(
                [f"if {value} is not None:", f"    item{depth} = {value}", *(f"    {line}" for line in inside)]
            )
    return checks


def _lookup(field: dict) -> str:
    """The ORM name of a field for filters and sorting: foreign keys by their column (customer_id)."""
    return f"{attr(field)}_id" if is_foreign_key(field) else attr(field)


def _pending_todo(field: dict) -> str:
    return field["todo"] if field.get("todo") is not None else f'fill "{field["name"]}"'


def _service_block(context: DjangoContext, resource: dict, modules: Modules) -> None:
    modular = context.settings["architecture"] == "modular"
    here = module_of(context, resource, "services")
    module = modules.get(
        here,
        f"Rules of {resource['plural']}."
        if modular
        else "Rules of each resource: what each operation checks and changes.",
    )
    name = names(resource)
    model = name["model"]
    service = name["service"]
    imports = module["imports"]
    imports.add("typing", "Any")
    imports.add(module_of(context, resource, "models"), model)
    imports.add("config.errors", "NotFoundError")
    checks = _reference_checks(context, resource["fields"], "data", "", 0, False, module)
    if checks:
        imports.add("config.errors", "require as _require")
    key = key_field(resource)
    writable = [
        attr(field)
        for field in resource["fields"]
        if field["access"] != "readOnly" and field["name"] != resource["key"]["field"]
    ]
    sortable = [f"{py_string(field['wire'])}: {py_string(_lookup(field))}" for field in resource["fields"]]
    sort_fields = f"_SORT_FIELDS_{model.upper()}"
    methods: list[str] = [
        lines(
            "    @staticmethod",
            f"    def find(key: Any) -> {model}:",
            "        try:",
            f"            return {model}.objects.get(pk=key)",
            f"        except ({model}.DoesNotExist, ValueError, TypeError) as error:",
            f"            raise NotFoundError({py_string(resource['singular'])}) from error",
        )
    ]
    if checks:
        methods.append(
            lines(
                "    @staticmethod",
                "    def check_references(data: dict[str, Any]) -> None:",
                [f"        {line}" for line in checks],
            )
        )
    check_call = f"        {service}.check_references(data)" if checks else False
    client_key = resource["key"]["generated"] is None
    for endpoint in resource["endpoints"]:
        fn = py_name(endpoint["name"])
        summary = endpoint["summary"]
        operation = endpoint["operation"]
        if operation == "list":
            methods.append(
                lines(
                    "    @staticmethod",
                    f"    def {fn}(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[{model}], int]:",
                    f'        """{summary}: `sort` is a JSON field name, with a leading "-" for descending order."""',
                    f"        query = {model}.objects.filter(**filters)",
                    "        if sort:",
                    f'            field = {sort_fields}[sort.lstrip("-")]',
                    '            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")',
                    "        total = query.count()",
                    "        items = query[offset : offset + limit] if limit is not None else query",
                    "        return list(items), total",
                )
            )
        elif operation == "get":
            methods.append(
                lines(
                    "    @staticmethod",
                    f"    def {fn}(key: Any) -> {model}:",
                    f'        """{summary}."""',
                    f"        return {service}.find(key)",
                )
            )
        elif operation == "create":
            if client_key:
                imports.add("config.errors", "ConflictError")
            conflict = f"A {resource['singular']} with this key already exists"
            methods.append(
                lines(
                    "    @staticmethod",
                    f"    def {fn}(data: dict[str, Any]) -> {model}:",
                    f'        """{summary}."""',
                    client_key
                    and [
                        f"        if {model}.objects.filter(pk=data[{py_string(attr(key))}]).exists():",
                        f"            raise ConflictError({py_string(conflict)})",
                    ],
                    check_call,
                    [
                        f"        # TODO: {_pending_todo(field)}"
                        for field in resource["fields"]
                        if field.get("server") == "pending"
                    ],
                    f"        return {model}.objects.create(**data)",
                )
            )
        elif operation == "replace":
            if client_key:
                imports.add("config.errors", "InvalidRequestError")
            trailing = "," if len(writable) == 1 else ""
            methods.append(
                lines(
                    "    @staticmethod",
                    f"    def {fn}(key: Any, data: dict[str, Any]) -> {model}:",
                    f'        """{summary}: every field the client may send takes the value of the body."""',
                    f"        item = {service}.find(key)",
                    client_key
                    and [
                        f"        if str(data.pop({py_string(attr(key))})) != str(item.pk):",
                        f'            raise InvalidRequestError({py_string(key["wire"])}, "The key cannot change")',
                    ],
                    check_call,
                    f"        for field in ({', '.join(map(py_string, writable))}{trailing}):",
                    "            setattr(item, field, data.get(field))",
                    "        item.save()",
                    "        return item",
                )
            )
        elif operation == "update":
            if client_key:
                imports.add("config.errors", "InvalidRequestError")
            methods.append(
                lines(
                    "    @staticmethod",
                    f"    def {fn}(key: Any, data: dict[str, Any]) -> {model}:",
                    f'        """{summary}: only the fields in the body change."""',
                    f"        item = {service}.find(key)",
                    client_key
                    and [
                        f"        if {py_string(attr(key))} in data and str(data.pop({py_string(attr(key))})) != str(item.pk):",
                        f'            raise InvalidRequestError({py_string(key["wire"])}, "The key cannot change")',
                    ],
                    check_call,
                    "        for field, value in data.items():",
                    "            setattr(item, field, value)",
                    "        item.save()",
                    "        return item",
                )
            )
        elif operation == "delete":
            methods.append(
                lines(
                    "    @staticmethod",
                    f"    def {fn}(key: Any) -> None:",
                    f'        """{summary}."""',
                    f"        {service}.find(key).delete()",
                )
            )
        elif operation == "custom":
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            params = [
                param
                for param in (
                    "key: Any" if has_key else None,
                    "data: dict[str, Any]" if endpoint["input"] != "none" else None,
                )
                if param
            ]
            methods.append(
                lines(
                    "    @staticmethod",
                    f"    def {fn}({', '.join(params)}) -> Any:",
                    f'        """{summary}."""',
                    has_key and f"        {service}.find(key)",
                    f'        # TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    f"        raise NotImplementedError({py_string(summary + ' is not written yet')})",
                )
            )
    if any(endpoint["operation"] == "list" for endpoint in resource["endpoints"]):
        module["blocks"].append(
            f"# JSON names of the fields of {resource['plural']} a list can be sorted by, and their ORM names\n"
            f"{sort_fields} = {{{', '.join(sortable)}}}"
        )
    module["blocks"].append(
        lines(f"class {service}:", f'    """Rules of {resource["plural"]}."""', "", "\n\n".join(methods))
    )


def _permission(context: DjangoContext, endpoint: dict) -> str:
    auth = context.settings["auth"]
    if auth == "none" or endpoint["access"] == "public":
        return "AllowAny()"
    if endpoint["access"] == "roles" and auth == "jwt":
        return f"HasAnyRole({', '.join(map(py_string, endpoint['roles']))})"
    return "IsAuthenticated()"


_PARAM = re.compile(r"\{([^}]+)\}")


def _route(resource: dict, path: str) -> str:
    """A Django URL route of a path: /customers/{id} → customers/<int:id>."""
    scalar = resource["key"]["type"]["scalar"]
    converter = "int" if scalar == "integer" else "uuid" if scalar == "uuid" else "str"

    def replace(match: re.Match) -> str:
        param = match.group(1)
        return f"<{converter if param == resource['key']['param'] else 'str'}:{py_name(param)}>"

    return _PARAM.sub(replace, re.sub(r"^/", "", path, count=1))


def _query_field(context: DjangoContext, field: dict, here: str, module: dict) -> str:
    """A query parameter of a filter, read with the field's type."""
    if field["type"]["kind"] == "enum":
        shared = context.layout.shared_enums()
        if shared != here:
            module["imports"].add(shared, py_class(field["type"]["name"]))
        return f"serializers.ChoiceField(choices={py_class(field['type']['name'])}.choices, required=False)"
    if field.get("reference"):
        scalar = next(item for item in context.spec["resources"] if item["name"] == field["reference"])["key"]["type"][
            "scalar"
        ]
    elif field["type"]["kind"] == "scalar":
        scalar = field["type"]["scalar"]
    else:
        scalar = "string"
    known = {
        "integer": "IntegerField",
        "float": "FloatField",
        "decimal": "FloatField",
        "boolean": "BooleanField",
        "uuid": "UUIDField",
        "date": "DateField",
        "datetime": "DateTimeField",
    }
    extra = ", allow_null=True, default=None" if scalar == "boolean" else ""
    return f"serializers.{known.get(scalar, 'CharField')}(required=False{extra})"


def _view_blocks(context: DjangoContext, resource: dict, modules: Modules) -> list[str]:
    modular = context.settings["architecture"] == "modular"
    here = module_of(context, resource, "views")
    module = modules.get(
        here,
        f"Views of {resource['plural']}: HTTP in, service calls, HTTP out."
        if modular
        else "Views of the API: HTTP in, service calls, HTTP out.",
    )
    imports = module["imports"]
    name = names(resource)
    serializer = name["serializer"]
    imports.add("rest_framework.views", "APIView")
    imports.add("rest_framework.request", "Request")
    imports.add("rest_framework.response", "Response")
    imports.add(module_of(context, resource, "serializers"), serializer)
    imports.add(module_of(context, resource, "services"), name["service"])
    paths = list(dict.fromkeys(endpoint["path"] for endpoint in resource["endpoints"]))
    routes: list[str] = []
    for path in paths:
        endpoints = [endpoint for endpoint in resource["endpoints"] if endpoint["path"] == path]
        class_name = f"{py_class(endpoints[0]['name'])}View"
        params = [py_name(param["name"]) for param in endpoints[0]["pathParams"]]
        key_name = py_name(resource["key"]["param"])
        rules = [
            f"        {py_string(endpoint['method'])}: [{_permission(context, endpoint)}]," for endpoint in endpoints
        ]
        for endpoint in endpoints:
            rule = _permission(context, endpoint)
            permission_name = rule[: rule.index("(")]
            imports.add(
                "config.security" if permission_name == "HasAnyRole" else "rest_framework.permissions", permission_name
            )
        methods = []
        for endpoint in endpoints:
            fn = py_name(endpoint["name"])
            extra = "".join(f", {param}: str" for param in params)
            signature = f"    def {endpoint['method'].lower()}(self, request: Request{extra}) -> Response:"
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            status = number_text(endpoint["status"])
            body: list[str] = []
            if endpoint["input"] != "none":
                partial = ", partial=True" if endpoint["input"] == "partial" else ""
                body.extend(
                    [
                        f"serializer = {serializer}(data=request.data{partial})",
                        "serializer.is_valid(raise_exception=True)",
                    ]
                )
            data = "dict(serializer.validated_data)" if endpoint["input"] != "none" else None

            def call(args: list, fn: str = fn) -> str:
                return f"{name['service']}.{fn}({', '.join(arg for arg in args if arg)})"

            operation = endpoint["operation"]
            if operation == "list":
                query = f"{py_class(endpoint['name'])}Query"
                imports.add("rest_framework", "serializers")
                query_fields: list[str] = []
                if endpoint["pagination"]:
                    query_fields.extend(
                        [
                            "    page = serializers.IntegerField(min_value=1, default=1)",
                            f"    size = serializers.IntegerField(min_value=1, max_value={PAGE_SIZE['max']}, default={PAGE_SIZE['default']})",
                        ]
                    )
                filters: list[str] = []
                for wire in endpoint["filters"]:
                    field = next(item for item in resource["fields"] if item["wire"] == wire)
                    query_fields.append(f"    {py_name(wire)} = {_query_field(context, field, here, module)}")
                    filters.append(f"({py_string(_lookup(field))}, query.get({py_string(py_name(wire))}))")
                if endpoint["sort"]:
                    choices = ", ".join(
                        text for wire in endpoint["sort"] for text in (py_string(wire), py_string(f"-{wire}"))
                    )
                    query_fields.append(f"    sort = serializers.ChoiceField(choices=[{choices}], required=False)")
                module["blocks"].append(
                    lines(
                        f"class {query}(serializers.Serializer):",
                        f'    """Query parameters of {endpoint["summary"].lower()}."""',
                        "",
                        query_fields if query_fields else "    pass",
                    )
                )
                sort = 'query.get("sort")' if endpoint["sort"] else "None"
                page_offset = '(query["page"] - 1) * query["size"]'
                page_size = 'query["size"]'
                body.extend(
                    [
                        f"parameters = {query}(data=request.query_params)",
                        "parameters.is_valid(raise_exception=True)",
                        "query = parameters.validated_data",
                        f"filters = {{name: value for name, value in ({', '.join(filters)},) if value is not None}}"
                        if filters
                        else "filters: dict[str, object] = {}",
                        f"items, total = {call(['filters', sort, page_offset, page_size])}"
                        if endpoint["pagination"]
                        else f"items, _ = {call(['filters', sort, '0', 'None'])}",
                        f'return Response({{"items": {serializer}(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}}, status={status})'
                        if endpoint["pagination"]
                        else f"return Response({serializer}(items, many=True).data, status={status})",
                    ]
                )
            elif operation == "get":
                body.append(f"return Response({serializer}({call([key_name])}).data, status={status})")
            elif operation == "create":
                body.append(f"return Response({serializer}({call([data])}).data, status={status})")
            elif operation in ("replace", "update"):
                body.append(f"return Response({serializer}({call([key_name, data])}).data, status={status})")
            elif operation == "delete":
                body.extend([call([key_name]), f"return Response(status={status})"])
            else:
                result = call([key_name if has_key else None, data])
                if endpoint["output"] == "none" or endpoint["status"] == 204:
                    body.extend([result, f"return Response(status={status})"])
                else:
                    many = ", many=True" if endpoint["output"] == "list" else ""
                    body.append(f"return Response({serializer}({result}{many}).data, status={status})")
            methods.append(
                lines(signature, f'        """{endpoint["summary"]}."""', [f"        {line}" for line in body])
            )
        module["blocks"].append(
            lines(
                f"class {class_name}(APIView):",
                f'    """{path}"""',
                "",
                "    # Who may call each method of this path",
                "    rules = {",
                rules,
                "    }",
                "",
                "    def get_permissions(self):  # type: ignore[no-untyped-def]",
                "        return self.rules.get(self.request.method, [])",
                "",
                "\n\n".join(methods),
            )
        )
        routes.append(f"    path({py_string(_route(resource, path))}, {class_name}.as_view()),")
    return routes


_VIEW_NAME = re.compile(r", (\w+)\.as_view", re.ASCII)


def service_and_view_blocks(context: DjangoContext, modules: Modules) -> list[dict]:
    routes_by_app: dict[str, list[str]] = {}
    for resource in context.spec["resources"]:
        _service_block(context, resource, modules)
        routes = _view_blocks(context, resource, modules)
        app = context.layout.app(resource)
        routes_by_app[app] = [*routes_by_app.get(app, []), *routes]
    files = []
    for app, routes in routes_by_app.items():
        views = list(
            dict.fromkeys(
                module_of(context, resource, "views")
                for resource in context.spec["resources"]
                if context.layout.app(resource) == app
            )
        )
        view_names = sorted(set(_VIEW_NAME.search(line).group(1) for line in routes))
        content = lines(
            f'"""URLs of the {app} app."""',
            "",
            "from django.urls import path",
            "",
            f"from {views[0]} import {', '.join(view_names)}",
            "",
            "urlpatterns = [",
            routes,
            "]",
        )
        files.append({"path": f"{app}/urls.py", "content": file_text(content)})
    return files
