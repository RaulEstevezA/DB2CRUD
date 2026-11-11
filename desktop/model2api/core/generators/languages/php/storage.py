"""Storage of each resource in a PHP project (Laravel and Symfony) that every framework writes the same: the
repository interface the service depends on, the in-memory implementation and the one left to write (501). Items
travel as arrays keyed by their JSON names. Each framework adds its own ORM implementation. Mirrors
web/src/core/generators/languages/php/storage.ts.
"""

from ...common.text import file_text, lines
from .php import PhpImports, php_doc, php_header, php_string
from .project import key_field, key_type, resource_names


def php_file(context, namespace: str, name: str, imports: PhpImports, body: list) -> dict:
    return {
        "path": context.class_path(namespace, name),
        "content": file_text(lines(*php_header(namespace, imports), *body)),
    }


def _listing(context) -> tuple[str, str]:
    return (f"{context.support}\\ListQuery", f"{context.support}\\ListResult")


def values_file(context) -> dict | None:
    """Helpers the in-memory repositories share: comparing values as JSON would."""
    if context.settings["persistence"] != "memory":
        return None
    namespace = context.support
    return php_file(
        context,
        namespace,
        "Values",
        PhpImports(namespace),
        [
            php_doc("Compares values as JSON does: a whole number equals the same number with decimals."),
            "final class Values",
            "{",
            "    public static function same(mixed $left, mixed $right): bool",
            "    {",
            "        if (is_numeric($left) && is_numeric($right) && ! is_string($left) && ! is_string($right)) {",
            "            return $left == $right;",
            "        }",
            "",
            "        return $left === $right;",
            "    }",
            "",
            "    /** Texts in character order, numbers by value. */",
            "    public static function compare(mixed $left, mixed $right): int",
            "    {",
            "        if (is_string($left) && is_string($right)) {",
            "            return strcmp($left, $right);",
            "        }",
            "",
            "        return $left <=> $right;",
            "    }",
            "}",
        ],
    )


def repository_contract_file(context, resource: dict) -> dict:
    """The repository interface of a resource."""
    namespace = context.namespace(resource, "repository")
    name = resource_names(resource)
    key = key_type(resource)
    plural = resource["plural"]
    generated = resource["key"].get("generated")
    return php_file(
        context,
        namespace,
        name["repository"],
        PhpImports(namespace).add(*_listing(context)),
        [
            php_doc(
                f"Where {plural} are kept. The service depends only on this interface; items are arrays keyed by JSON name."
            ),
            f"interface {name['repository']}",
            "{",
            "    /** Items equal to every filter, in order, within the window; and how many match. */",
            "    public function list(ListQuery $query): ListResult;",
            "",
            "    /** @return array<string, mixed>|null The item with this key, or null. */",
            f"    public function get({key} $key): ?array;",
            "",
            "    /**",
            f"     * Stores a new item{' and assigns its key' if generated else ''}.",
            "     *",
            "     * @param  array<string, mixed>  $item",
            "     * @return array<string, mixed> The item as stored.",
            "     */",
            "    public function add(array $item): array;",
            "",
            "    /**",
            "     * Stores the new state of an existing item: every field, as given.",
            "     *",
            "     * @param  array<string, mixed>  $item",
            "     * @return array<string, mixed> The item as stored.",
            "     */",
            f"    public function save({key} $key, array $item): array;",
            "",
            "    /** Removes an existing item. */",
            f"    public function delete({key} $key): void;",
            "}",
        ],
    )


def pending_repository_file(context, resource: dict) -> dict:
    """Storage left to write: every method answers 501."""
    namespace = context.namespace(resource, "repository")
    name = resource_names(resource)
    key = key_type(resource)
    plural = resource["plural"]
    imports = PhpImports(namespace).add(*_listing(context), f"{context.exceptions}\\NotImplementedException")
    message = php_string(f"The storage of {plural} is not written yet")

    def method(signature: str, returns: str) -> list[str]:
        return [
            f"    public function {signature}: {returns}",
            "    {",
            f"        // TODO: store {plural} in your database",
            f"        throw new NotImplementedException({message});",
            "    }",
        ]

    return php_file(
        context,
        namespace,
        name["pendingRepository"],
        imports,
        [
            php_doc(f"Storage of {plural} to write: every method answers 501 until it is implemented."),
            f"final class {name['pendingRepository']} implements {name['repository']}",
            "{",
            method("list(ListQuery $query)", "ListResult"),
            "",
            method(f"get({key} $key)", "?array"),
            "",
            method("add(array $item)", "array"),
            "",
            method(f"save({key} $key, array $item)", "array"),
            "",
            method(f"delete({key} $key)", "void"),
            "}",
        ],
    )


def memory_repository_file(context, resource: dict) -> dict:
    """Storage in memory, to try the API without a database."""
    namespace = context.namespace(resource, "repository")
    name = resource_names(resource)
    key = key_type(resource)
    plural = resource["plural"]
    key_wire = key_field(resource)["wire"]
    generated = resource["key"].get("generated")
    imports = PhpImports(namespace).add(*_listing(context), f"{context.support}\\Values")
    if generated == "uuid":
        imports.add(*context.uuid["imports"])
    if generated == "increment":
        assign = f"        $item[{php_string(key_wire)}] = $this->nextKey++;"
    elif generated == "uuid":
        assign = f"        $item[{php_string(key_wire)}] = {context.uuid['expression']};"
    else:
        assign = None
    return php_file(
        context,
        namespace,
        name["memory"],
        imports,
        [
            php_doc(f"Keeps {plural} in memory: they are lost when the application stops. Use it to try the API."),
            f"final class {name['memory']} implements {name['repository']}",
            "{",
            "    /** @var array<int|string, array<string, mixed>> */",
            "    private array $items = [];",
            generated == "increment" and ["", "    private int $nextKey = 1;"],
            "",
            "    public function list(ListQuery $query): ListResult",
            "    {",
            "        $items = array_values(array_filter($this->items, function (array $item) use ($query): bool {",
            "            foreach ($query->filters as $field => $value) {",
            "                if (! Values::same($item[$field] ?? null, $value)) {",
            "                    return false;",
            "                }",
            "            }",
            "",
            "            return true;",
            "        }));",
            "        if ($query->sortField !== null) {",
            "            $field = $query->sortField;",
            "            // Items without a value go last, whatever the order",
            "            $present = array_values(array_filter($items, fn (array $item) => ($item[$field] ?? null) !== null));",
            "            $missing = array_values(array_filter($items, fn (array $item) => ($item[$field] ?? null) === null));",
            "            usort($present, fn (array $a, array $b) => $query->descending",
            "                ? Values::compare($b[$field], $a[$field])",
            "                : Values::compare($a[$field], $b[$field]));",
            "            $items = [...$present, ...$missing];",
            "        }",
            "",
            "        return new ListResult(array_slice($items, $query->offset, $query->limit), count($items));",
            "    }",
            "",
            f"    public function get({key} $key): ?array",
            "    {",
            "        return $this->items[$key] ?? null;",
            "    }",
            "",
            "    public function add(array $item): array",
            "    {",
            assign,
            f"        $this->items[$item[{php_string(key_wire)}]] = $item;",
            "",
            "        return $item;",
            "    }",
            "",
            f"    public function save({key} $key, array $item): array",
            "    {",
            "        $this->items[$key] = $item;",
            "",
            "        return $item;",
            "    }",
            "",
            f"    public function delete({key} $key): void",
            "    {",
            "        unset($this->items[$key]);",
            "    }",
            "}",
        ],
    )
