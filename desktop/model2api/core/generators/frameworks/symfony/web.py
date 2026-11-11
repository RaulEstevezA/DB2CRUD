"""Controllers and responses of the Symfony project (the services are shared with every PHP framework:
languages/php/service.py). The controller only translates HTTP to service calls: parameters, bodies, status codes
and the protection each endpoint declares. Mirrors web/src/core/generators/frameworks/symfony/web.ts.
"""

from ....js import js_string, number_text
from ....openapi.build import PAGE_SIZE, always_in_response, shape_fields
from ...common.text import file_text, lines
from ...languages.php.php import PhpImports, php_doc, php_header, php_name, php_regex, php_string
from ...languages.php.project import article, capitalize
from .context import SymfonyContext, class_path, names, qualified

_UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
_DATE = r"^\d{4}-\d{2}-\d{2}$"


def _is_object(field: dict) -> bool:
    return not field.get("reference") and field["type"]["kind"] in ("object", "map")


def presenter_file(context: SymfonyContext, resource: dict) -> dict:
    """The response of a resource: the fields clients read, an optional one only when it has a value."""
    namespace = context.layout.resource(resource, "presenter")
    name = names(resource)
    fields = shape_fields(resource["fields"], "read")
    statements = []
    for field in fields:
        wire = php_string(field["wire"])
        # Objects and maps are JSON objects even when empty
        value = f"self::object($item[{wire}] ?? null)" if _is_object(field) else f"$item[{wire}] ?? null"
        if always_in_response(field):
            statements.append(f"        $response[{wire}] = {value};")
        else:
            statements.extend(
                [f"        if (isset($item[{wire}])) {{", f"            $response[{wire}] = {value};", "        }"]
            )
    content = lines(
        *php_header(namespace, PhpImports(namespace)),
        php_doc(
            f"{capitalize(article(resource['singular']))} as the API returns it: everything but what clients only send."
        ),
        f"final class {name['presenter']}",
        "{",
        "    /**",
        "     * @param  array<string, mixed>  $item",
        "     * @return array<string, mixed>",
        "     */",
        "    public static function one(array $item): array",
        "    {",
        "        $response = [];",
        statements,
        "",
        "        return $response;",
        "    }",
        "",
        "    /**",
        "     * @param  list<array<string, mixed>>  $items",
        "     * @return list<array<string, mixed>>",
        "     */",
        "    public static function many(array $items): array",
        "    {",
        "        return array_map(self::one(...), $items);",
        "    }",
        any(_is_object(field) for field in fields)
        and [
            "",
            "    /** An empty array is an empty JSON object here, not a list. */",
            "    private static function object(mixed $value): mixed",
            "    {",
            "        return $value === [] ? new \\stdClass() : $value;",
            "    }",
        ],
        "}",
    )
    return {"path": class_path(namespace, name["presenter"]), "content": file_text(content)}


def _filter_read(context: SymfonyContext, field: dict) -> str:
    """The statement that reads a filter of the query string, with the type of its field."""
    wire = php_string(field["wire"])
    target = (
        next((item for item in context.spec["resources"] if item["name"] == field["reference"]), None)
        if field.get("reference")
        else None
    )
    type_ref = target["key"]["type"] if target else field["type"]
    if type_ref["kind"] == "enum":
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        integer = item["valueType"] == "integer"
        choices = [number_text(value) if integer else php_string(js_string(value)) for value in item["values"]]
        return f"$this->choiceQuery($request, {wire}, [{', '.join(choices)}])"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return f"$this->integerQuery($request, {wire})"
        if scalar in ("float", "decimal"):
            return f"$this->numberQuery($request, {wire})"
        if scalar == "boolean":
            return f"$this->booleanQuery($request, {wire})"
        if scalar == "uuid":
            return f"$this->textQuery($request, {wire}, {php_string(php_regex(_UUID))})"
        if scalar == "date":
            return f"$this->textQuery($request, {wire}, {php_string(php_regex(_DATE))})"
    return f"$this->textQuery($request, {wire})"


def _key_read(resource: dict) -> str:
    """The statement that reads the key of a path, with its type: a malformed key is a 400."""
    param = php_string(resource["key"]["param"])
    scalar = resource["key"]["type"]["scalar"]
    if scalar == "integer":
        return f"$key = $this->integerKey($request, {param});"
    if scalar == "uuid":
        return f"$key = $this->uuidKey($request, {param});"
    return f"$key = $this->textKey($request, {param});"


def _guard(context: SymfonyContext, endpoint: dict, imports: PhpImports) -> str | None:
    """The protection an endpoint declares, or None for a public one."""
    if endpoint["access"] == "public" or context.settings["auth"] == "none":
        return None
    imports.add("App\\Security\\RequiresAccess")
    if endpoint["access"] == "roles" and context.settings["auth"] == "jwt":
        return f"    #[RequiresAccess(roles: [{', '.join(php_string(role) for role in endpoint['roles'])}])]"
    return "    #[RequiresAccess]"


def controller_file(context: SymfonyContext, resource: dict) -> dict:
    namespace = context.layout.resource(resource, "controller")
    name = names(resource)
    service = qualified(context, resource, "service", name["service"])
    imports = PhpImports(namespace).add(
        "App\\Controller\\ApiController",
        "Symfony\\Component\\HttpFoundation\\Request",
        "Symfony\\Component\\HttpFoundation\\Response",
        "Symfony\\Component\\HttpKernel\\Attribute\\AsController",
        "Symfony\\Component\\Routing\\Attribute\\Route",
        service,
        qualified(context, resource, "presenter", name["presenter"]),
    )
    key_param = resource["key"]["param"]
    uses_body = any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    if uses_body:
        imports.add("App\\Http\\JsonBody", qualified(context, resource, "input", name["input"]))
    presenter = name["presenter"]
    methods = []
    for endpoint in resource["endpoints"]:
        fn = php_name(endpoint["name"])
        body: list[str] = []
        has_key = any(param["name"] == key_param for param in endpoint["pathParams"])
        if has_key:
            body.append(_key_read(resource))
        if endpoint["input"] == "resource":
            body.append(
                f"$values = {name['input']}::createValues($this->body->read($request, {name['input']}::create()));"
            )
        if endpoint["input"] == "partial":
            body.append(
                f"$values = {name['input']}::updateValues($this->body->read($request, {name['input']}::update()));"
            )
        status = number_text(endpoint["status"])
        operation = endpoint["operation"]
        if operation == "list":
            imports.add("App\\Support\\ListQuery")
            if endpoint.get("pagination"):
                body.extend(
                    [
                        "$page = $this->integerQuery($request, 'page', 1, 1);",
                        f"$size = $this->integerQuery($request, 'size', {number_text(PAGE_SIZE['default'])}, 1, "
                        f"{number_text(PAGE_SIZE['max'])});",
                    ]
                )
            body.append("$filters = [];")
            for wire in endpoint["filters"]:
                field = next(item for item in resource["fields"] if item["wire"] == wire)
                body.extend(
                    [
                        f"if ($request->query->has({php_string(wire)})) {{",
                        f"    $filters[{php_string(wire)}] = {_filter_read(context, field)};",
                        "}",
                    ]
                )
            if endpoint["sort"]:
                options = ", ".join(
                    text for wire in endpoint["sort"] for text in (php_string(wire), php_string(f"-{wire}"))
                )
                sort = f"$this->choiceQuery($request, 'sort', [{options}])"
            else:
                sort = "null"
            if endpoint.get("pagination"):
                body.extend(
                    [
                        f"$result = $this->service->{fn}(ListQuery::of($filters, {sort}, ($page - 1) * $size, $size));",
                        "",
                        f"return $this->answer(['items' => {presenter}::many($result->items), 'total' => $result->total, "
                        f"'page' => $page, 'size' => $size], {status});",
                    ]
                )
            else:
                body.extend(
                    [
                        f"$result = $this->service->{fn}(ListQuery::of($filters, {sort}));",
                        "",
                        f"return $this->answer({presenter}::many($result->items), {status});",
                    ]
                )
        elif operation == "get":
            body.extend(["", f"return $this->answer({presenter}::one($this->service->{fn}($key)), {status});"])
        elif operation == "create":
            body.extend(["", f"return $this->answer({presenter}::one($this->service->{fn}($values)), {status});"])
        elif operation in ("replace", "update"):
            body.extend(["", f"return $this->answer({presenter}::one($this->service->{fn}($key, $values)), {status});"])
        elif operation == "delete":
            body.extend([f"$this->service->{fn}($key);", "", f"return $this->empty({status});"])
        elif operation == "custom":
            args = [
                arg for arg in ("$key" if has_key else None, "$values" if endpoint["input"] != "none" else None) if arg
            ]
            call = f"$this->service->{fn}({', '.join(args)})"
            if endpoint["output"] == "none" or endpoint["status"] == 204:
                body.extend([f"{call};", "", f"return $this->empty({status});"])
            elif endpoint["output"] == "list":
                body.extend(["", f"return $this->answer({presenter}::many({call}), {status});"])
            else:
                body.extend(["", f"return $this->answer({presenter}::one({call}), {status});"])
        protection = _guard(context, endpoint, imports)
        methods.append(
            lines(
                f"    /** {endpoint['summary']}. */",
                f"    #[Route({php_string(endpoint['path'])}, name: {php_string(fn)}, "
                f"methods: [{php_string(endpoint['method'])}])]",
                protection,
                f"    public function {fn}(Request $request): Response",
                "    {",
                ["" if line == "" else f"        {line}" for line in body],
                "    }",
            )
        )
    if uses_body:
        constructor = [
            "    public function __construct(",
            f"        private readonly {name['service']} $service,",
            "        private readonly JsonBody $body,",
            "    ) {",
            "    }",
        ]
    else:
        constructor = [
            f"    public function __construct(private readonly {name['service']} $service)",
            "    {",
            "    }",
        ]
    content = lines(
        *php_header(namespace, imports),
        php_doc(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out."),
        "#[AsController]",
        f"final class {name['controller']} extends ApiController",
        "{",
        constructor,
        "",
        "\n\n".join(methods),
        "}",
    )
    return {"path": class_path(namespace, name["controller"]), "content": file_text(content)}
