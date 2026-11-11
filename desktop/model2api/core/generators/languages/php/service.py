"""The service of a resource in a PHP project (Laravel and Symfony): its rules. Items that must exist, keys that
must not repeat, references that must point to stored items, and the values the server fills (keys, timestamps,
defaults). Business endpoints get a method that answers 501 with a TODO where their logic goes. Items are arrays
keyed by their JSON names. Mirrors web/src/core/generators/languages/php/service.ts.
"""

from ....js import coalesce
from ...common.text import file_text, lines
from .php import PhpImports, php_doc, php_header, php_literal, php_name, php_string
from .project import inner_object, key_field, key_type, referenced_resources, resource_names


def _reference_checks(context, resource: dict, fields: list[dict], source: str, label: str, depth: int) -> list[str]:
    """PHP statements that check every reference of a set of values, nested objects included."""
    checks: list[str] = []
    for field in fields:
        value = f"{source}[{php_string(field['wire'])}]"
        where = f"{label}.{field['wire']}" if label else field["wire"]
        reference = field.get("reference")
        if reference:
            repository = (
                "$this->repository" if reference == resource["name"] else f"$this->{php_name(reference)}Repository"
            )
            if field["type"]["kind"] == "array":
                checks.extend(
                    [
                        f"foreach ({value} ?? [] as $key) {{",
                        f"    $this->require({repository}, $key, {php_string(where)}, {php_string(reference)});",
                        "}",
                    ]
                )
            else:
                checks.append(
                    f"$this->require({repository}, {value} ?? null, {php_string(where)}, {php_string(reference)});"
                )
            continue
        inner = inner_object(field["type"])
        spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None) if inner else None
        if not spec_object or depth > 3:
            continue
        variable = f"$item{depth}"
        nested = _reference_checks(context, resource, spec_object["fields"], variable, where, depth + 1)
        if not nested:
            continue
        if field["type"]["kind"] == "array":
            checks.extend([f"foreach ({value} ?? [] as {variable}) {{", *(f"    {line}" for line in nested), "}"])
        elif field["type"]["kind"] == "object":
            checks.extend(
                [
                    f"if (is_array({value} ?? null)) {{",
                    f"    {variable} = {value};",
                    *(f"    {line}" for line in nested),
                    "}",
                ]
            )
    return checks


def _server_values(resource: dict, operation: str) -> list[str]:
    """Assignments of the values the server gives read-only fields in an operation."""
    result: list[str] = []
    for field in resource["fields"]:
        server = field.get("server")
        if field["access"] != "readOnly" or server == "key":
            continue
        target = f"$item[{php_string(field['wire'])}]"
        if server == "updated":
            result.append(f"{target} = $now;")
        elif server == "created" and operation == "create":
            result.append(f"{target} = $now;")
        elif server == "default" and operation == "create":
            result.append(f"{target} = {php_literal(field.get('defaultValue'))};")
        elif server == "pending" and operation == "create":
            fallback = 'fill "' + field["name"] + '"'
            result.extend([f"// TODO: {coalesce(field.get('todo'), fallback)}", f"{target} = null;"])
    return result


def _uses_now(resource: dict, operation: str) -> bool:
    return any(
        field["access"] == "readOnly"
        and (field.get("server") == "updated" or (field.get("server") == "created" and operation == "create"))
        for field in resource["fields"]
    )


def service_file(context, resource: dict) -> dict:
    namespace = context.namespace(resource, "service")
    name = resource_names(resource)
    key = key_type(resource)
    key_wire = php_string(key_field(resource)["wire"])
    imports = PhpImports(namespace).add(
        f"{context.namespace(resource, 'repository')}\\{name['repository']}", f"{context.exceptions}\\ApiException"
    )
    needs = referenced_resources(context, resource)
    for target in needs:
        imports.add(f"{context.namespace(target, 'repository')}\\{resource_names(target)['repository']}")
    checks = _reference_checks(context, resource, resource["fields"], "$values", "", 0)
    has_checks = bool(checks) and any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    client_key = resource["key"].get("generated") is None
    kept = [php_string(field["wire"]) for field in resource["fields"] if field["access"] == "readOnly"]
    methods: list[str] = [
        lines(
            "    /** @return array<string, mixed> */",
            f"    private function find({key} $key): array",
            "    {",
            f"        return $this->repository->get($key) ?? throw ApiException::notFound({php_string(resource['singular'])});",
            "    }",
        )
    ]
    if has_checks:
        methods.append(
            lines(
                "    /** A reference must point to a stored item. */",
                "    private function require(object $repository, mixed $key, string $field, string $model): void",
                "    {",
                "        if ($key !== null && $repository->get($key) === null) {",
                '            throw ApiException::invalid($field, "No {$model} has this key");',
                "        }",
                "    }",
                "",
                "    /** @param array<string, mixed> $values */",
                "    private function checkReferences(array $values): void",
                "    {",
                [f"        {line}" for line in checks],
                "    }",
            )
        )
    check = has_checks and "        $this->checkReferences($values);"

    def now(operation: str):
        return _uses_now(resource, operation) and f"        $now = {context.now};"

    def fill(operation: str) -> list[str]:
        return [f"        {line}" for line in _server_values(resource, operation)]

    for endpoint in resource["endpoints"]:
        fn = php_name(endpoint["name"])
        operation = endpoint["operation"]
        summary = endpoint["summary"]
        if operation == "list":
            imports.add(f"{context.support}\\ListQuery", f"{context.support}\\ListResult")
            methods.append(
                lines(
                    f"    /** {summary}. */",
                    f"    public function {fn}(ListQuery $query): ListResult",
                    "    {",
                    "        return $this->repository->list($query);",
                    "    }",
                )
            )
        elif operation == "get":
            methods.append(
                lines(
                    f"    /** @return array<string, mixed> {summary}. */",
                    f"    public function {fn}({key} $key): array",
                    "    {",
                    "        return $this->find($key);",
                    "    }",
                )
            )
        elif operation == "create":
            conflict = php_string(f"A {resource['singular']} with this key already exists")
            methods.append(
                lines(
                    "    /**",
                    f"     * {summary}.",
                    "     *",
                    "     * @param  array<string, mixed>  $values",
                    "     * @return array<string, mixed>",
                    "     */",
                    f"    public function {fn}(array $values): array",
                    "    {",
                    client_key
                    and [
                        f"        if (isset($values[{key_wire}]) && $this->repository->get($values[{key_wire}]) !== null) {{",
                        f"            throw ApiException::conflict({conflict});",
                        "        }",
                    ],
                    check,
                    "        $item = $values;",
                    now("create"),
                    fill("create"),
                    "",
                    "        return $this->repository->add($item);",
                    "    }",
                )
            )
        elif operation == "replace":
            methods.append(
                lines(
                    "    /**",
                    f"     * {summary}: every field the client may send takes the value of the body.",
                    "     *",
                    "     * @param  array<string, mixed>  $values",
                    "     * @return array<string, mixed>",
                    "     */",
                    f"    public function {fn}({key} $key, array $values): array",
                    "    {",
                    "        $current = $this->find($key);",
                    client_key
                    and [
                        f"        if (($values[{key_wire}] ?? null) !== $key) {{",
                        f"            throw ApiException::invalid({key_wire}, 'The key cannot change');",
                        "        }",
                    ],
                    check,
                    "        // What the server keeps (key, timestamps) stays; the rest is what the body says",
                    "        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];",
                    now("replace"),
                    fill("replace"),
                    "",
                    "        return $this->repository->save($key, $item);",
                    "    }",
                )
            )
        elif operation == "update":
            changes_key = client_key and key_field(resource)["access"] != "readOnly"
            methods.append(
                lines(
                    "    /**",
                    f"     * {summary}: only the fields in the body change.",
                    "     *",
                    "     * @param  array<string, mixed>  $values",
                    "     * @return array<string, mixed>",
                    "     */",
                    f"    public function {fn}({key} $key, array $values): array",
                    "    {",
                    "        $current = $this->find($key);",
                    changes_key
                    and [
                        f"        if (array_key_exists({key_wire}, $values) && $values[{key_wire}] !== $key) {{",
                        f"            throw ApiException::invalid({key_wire}, 'The key cannot change');",
                        "        }",
                    ],
                    check,
                    "        $item = [...$current, ...$values];",
                    now("update"),
                    fill("update"),
                    "",
                    "        return $this->repository->save($key, $item);",
                    "    }",
                )
            )
        elif operation == "delete":
            methods.append(
                lines(
                    f"    /** {summary}. */",
                    f"    public function {fn}({key} $key): void",
                    "    {",
                    "        $this->find($key);",
                    "        $this->repository->delete($key);",
                    "    }",
                )
            )
        elif operation == "custom":
            imports.add(f"{context.exceptions}\\NotImplementedException")
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            params = [
                param
                for param in (
                    f"{key} $key" if has_key else None,
                    "array $values" if endpoint["input"] != "none" else None,
                )
                if param
            ]
            returns = "void" if endpoint["output"] == "none" else "array"
            not_written = php_string(f"{summary} is not written yet")
            methods.append(
                lines(
                    "    /**",
                    f"     * {summary}.",
                    endpoint["input"] != "none" and ["     *", "     * @param  array<string, mixed>  $values"],
                    endpoint["output"] == "list" and ["     *", "     * @return list<array<string, mixed>>"],
                    endpoint["output"] == "resource" and ["     *", "     * @return array<string, mixed>"],
                    "     */",
                    f"    public function {fn}({', '.join(params)}): {returns}",
                    "    {",
                    has_key and "        $this->find($key);",
                    f'        // TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    f"        throw new NotImplementedException({not_written});",
                    "    }",
                )
            )
    replaces = any(endpoint["operation"] == "replace" for endpoint in resource["endpoints"])
    constructor_params = [
        f"        private readonly {name['repository']} $repository,",
        *(
            f"        private readonly {resource_names(target)['repository']} ${php_name(target['name'])}Repository,"
            for target in needs
        ),
    ]
    content = lines(
        *php_header(namespace, imports),
        php_doc(f"Rules of {resource['plural']}: what each operation checks and changes."),
        f"final class {name['service']}",
        "{",
        replaces
        and [
            "    /** Fields only the server writes, kept when an item is replaced */",
            f"    private const SERVER_FIELDS = [{', '.join(kept)}];",
            "",
        ],
        "    public function __construct(",
        constructor_params,
        "    ) {",
        "    }",
        "",
        "\n\n".join(methods),
        "}",
    )
    return {"path": context.class_path(namespace, name["service"]), "content": file_text(content)}
