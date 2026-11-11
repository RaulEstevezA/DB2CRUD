"""Storage of each resource with Doctrine ORM in the Symfony project: an entity mapped with attributes, and a
repository that maps entities to the arrays the service works with (keyed by JSON name). The interface, the
in-memory and the pending repositories are shared with every PHP framework (languages/php/storage.py). Mirrors
web/src/core/generators/frameworks/symfony/persistence.ts.
"""

import re

from ....js import coalesce, number_text
from ...common.text import file_text, lines
from ...languages.php.php import PhpImports, php_doc, php_header, php_string
from ...languages.php.project import key_field, key_type
from ...languages.php.storage import memory_repository_file, pending_repository_file, repository_contract_file
from .context import SymfonyContext, class_path, column, names, property_name, qualified


def _is_scalar(field: dict, scalar: str) -> bool:
    type_ref = field["type"]
    return not field.get("reference") and type_ref["kind"] == "scalar" and type_ref["scalar"] == scalar


def _stored_as_json(field: dict) -> bool:
    """Whether a field is stored as JSON: lists, maps, embedded objects and values of any shape."""
    return field["type"]["kind"] in ("array", "map", "object") or _is_scalar(field, "any")


def _column(type_name: str, php: str, options: str = "") -> dict:
    return {"type": type_name, "php": php, "options": options}


def _column_of(context: SymfonyContext, field: dict) -> dict:
    """The Doctrine column type, its PHP property type and the extra column options of a field."""
    if _stored_as_json(field):
        return _column("Types::JSON", "mixed")
    if field.get("reference"):
        # A reference column has the type of the key it holds, BIGINT included
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        key = target["key"]["type"]
        if key["scalar"] == "integer":
            return _column("Types::BIGINT" if key.get("bits") == 64 else "Types::INTEGER", "?int")
        if key["scalar"] == "uuid":
            return _column("Types::GUID", "?string")
        length = coalesce(key_field(target)["constraints"].get("maxLength"), 191)
        return _column("Types::STRING", "?string", f", length: {number_text(length)}")
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next((entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"]), None)
        if item and item["valueType"] == "integer":
            return _column("Types::INTEGER", "?int")
        return _column("Types::STRING", "?string", ", length: 64")
    if type_ref["kind"] != "scalar":
        return _column("Types::TEXT", "?string")
    scalar = type_ref["scalar"]
    max_length = field["constraints"].get("maxLength")
    if scalar == "string":
        if max_length is not None and max_length <= 255:
            return _column("Types::STRING", "?string", f", length: {number_text(max_length)}")
        return _column("Types::TEXT", "?string")
    if scalar == "integer":
        return _column("Types::BIGINT" if type_ref.get("bits") == 64 else "Types::INTEGER", "?int")
    if scalar == "float":
        return _column("Types::FLOAT", "?float")
    if scalar == "decimal":
        return _column("Types::DECIMAL", "?string", ", precision: 18, scale: 4")
    if scalar == "boolean":
        return _column("Types::BOOLEAN", "?bool")
    if scalar == "date":
        return _column("Types::DATE_IMMUTABLE", "?\\DateTimeImmutable")
    if scalar == "datetime":
        return _column("Types::DATETIME_IMMUTABLE", "?\\DateTimeImmutable")
    if scalar == "time":
        return _column("Types::STRING", "?string", ", length: 15")
    if scalar == "uuid":
        return _column("Types::GUID", "?string")
    return _column("Types::TEXT", "?string")


def _quoted(identifier: str) -> str:
    """A table or column name in backticks: Doctrine then quotes it with each database's own quotes, so a name that
    is a reserved word somewhere (MySQL: lines, groups; PostgreSQL: user) still works."""
    return f"`{identifier}`"


def entity_file(context: SymfonyContext, resource: dict) -> dict | None:
    """The Doctrine entity of a resource."""
    if not context.doctrine:
        return None
    namespace = context.layout.resource(resource, "entity")
    name = names(resource)
    imports = PhpImports(namespace).add("Doctrine\\DBAL\\Types\\Types", "Doctrine\\ORM\\Mapping as ORM")
    properties = []
    for field in resource["fields"]:
        mapped = _column_of(context, field)
        is_key = field["name"] == resource["key"]["field"]
        nullable = "" if is_key else ", nullable: true"
        attributes = [
            is_key and "    #[ORM\\Id]",
            is_key and resource["key"]["generated"] == "increment" and "    #[ORM\\GeneratedValue]",
            f"    #[ORM\\Column(name: {php_string(_quoted(column(field)))}, type: {mapped['type']}{mapped['options']}{nullable})]",
        ]
        properties.append(
            lines(
                field.get("todo") and f"    // TODO: {field['todo']}",
                attributes,
                f"    public {mapped['php']} ${property_name(field)} = null;",
            )
        )
    content = lines(
        *php_header(namespace, imports),
        resource.get("todo") and f"// TODO: {resource['todo']}",
        php_doc(
            f"A row of the {name['table']} table. Every column but the key accepts null: the requests check what is required."
        ),
        "#[ORM\\Entity]",
        f"#[ORM\\Table(name: {php_string(_quoted(name['table']))})]",
        f"class {name['entity']}",
        "{",
        "\n\n".join(properties),
        "}",
    )
    return {"path": class_path(namespace, name["entity"]), "content": file_text(content)}


_VARIABLE = re.compile(r"^\$\w+$")


def _to_property(field: dict, value: str) -> str:
    """From the JSON value to the property. An expression such as $item['total'] ?? null goes in parentheses: ??
    binds looser than ===."""
    operand = value if _VARIABLE.match(value) else f"({value})"
    if _is_scalar(field, "datetime"):
        return f"{operand} === null ? null : (new \\DateTimeImmutable({value}))->setTimezone(new \\DateTimeZone('UTC'))"
    if _is_scalar(field, "date"):
        return f"{operand} === null ? null : \\DateTimeImmutable::createFromFormat('!Y-m-d', {value})"
    if _is_scalar(field, "decimal"):
        return f"{operand} === null ? null : (string) {operand}"
    return value


def _item_value(field: dict) -> str:
    """The value of a field in an item, null when the item leaves it out."""
    return f"$item[{php_string(field['wire'])}] ?? null"


def _to_value(field: dict, value: str) -> str:
    """From the property back to the JSON value."""
    if _is_scalar(field, "datetime"):
        return f"{value}?->setTimezone(new \\DateTimeZone('UTC'))->format('Y-m-d\\TH:i:s\\Z')"
    if _is_scalar(field, "date"):
        return f"{value}?->format('Y-m-d')"
    if _is_scalar(field, "decimal"):
        return f"{value} === null ? null : (float) {value}"
    return value


def repository_files(context: SymfonyContext, resource: dict) -> list[dict]:
    files = [repository_contract_file(context, resource)]
    if context.pending:
        return [*files, pending_repository_file(context, resource)]
    if not context.doctrine:
        return [*files, memory_repository_file(context, resource)]
    namespace = context.layout.resource(resource, "repository")
    name = names(resource)
    key = key_type(resource)
    generated = resource["key"]["generated"]
    entity = qualified(context, resource, "entity", name["entity"])
    imports = PhpImports(namespace).add(
        "App\\Support\\ListQuery",
        "App\\Support\\ListResult",
        "Doctrine\\ORM\\EntityManagerInterface",
        entity,
    )
    if generated == "uuid":
        imports.add("Symfony\\Component\\Uid\\Uuid")
    key_property = property_name(key_field(resource))
    properties = [
        f"        {php_string(field['wire'])} => {php_string(property_name(field))}," for field in resource["fields"]
    ]
    fill = [
        f"        $entity->{property_name(field)} = {_to_property(field, _item_value(field))};"
        for field in resource["fields"]
        if field["name"] != resource["key"]["field"]
    ]
    conversions = [
        f"            {php_string(field['wire'])} => {_to_property(field, '$value')},"
        for field in resource["fields"]
        if _is_scalar(field, "datetime") or _is_scalar(field, "date") or _is_scalar(field, "decimal")
    ]
    entity_name = name["entity"]
    content = lines(
        *php_header(namespace, imports),
        php_doc(f"Keeps {resource['plural']} in the database with Doctrine."),
        f"final class {name['doctrineRepository']} implements {name['repository']}",
        "{",
        "    /** The entity property of each JSON field */",
        "    private const PROPERTIES = [",
        properties,
        "    ];",
        "",
        "    public function __construct(private readonly EntityManagerInterface $manager)",
        "    {",
        "    }",
        "",
        "    public function list(ListQuery $query): ListResult",
        "    {",
        f"        $builder = $this->manager->createQueryBuilder()->select('item')->from({entity_name}::class, 'item');",
        "        $index = 0;",
        "        foreach ($query->filters as $field => $value) {",
        "            $parameter = 'filter'.$index++;",
        "            $builder->andWhere('item.'.self::PROPERTIES[$field].' = :'.$parameter)->setParameter($parameter, $this->toProperty($field, $value));",
        "        }",
        "        $total = (int) (clone $builder)->select('COUNT(item)')->getQuery()->getSingleScalarResult();",
        "        if ($query->sortField !== null) {",
        "            $sorted = 'item.'.self::PROPERTIES[$query->sortField];",
        "            // Items without a value go last, whatever the order",
        '            $builder->addSelect("CASE WHEN {$sorted} IS NULL THEN 1 ELSE 0 END AS HIDDEN missing")',
        "                ->addOrderBy('missing', 'ASC')",
        "                ->addOrderBy($sorted, $query->descending ? 'DESC' : 'ASC');",
        "        }",
        f"        $builder->addOrderBy({php_string(f'item.{key_property}')}, 'ASC')->setFirstResult($query->offset);",
        "        if ($query->limit !== null) {",
        "            $builder->setMaxResults($query->limit);",
        "        }",
        "",
        "        return new ListResult(array_map($this->toItem(...), $builder->getQuery()->getResult()), $total);",
        "    }",
        "",
        f"    public function get({key} $key): ?array",
        "    {",
        f"        $entity = $this->manager->find({entity_name}::class, $key);",
        "",
        "        return $entity === null ? null : $this->toItem($entity);",
        "    }",
        "",
        "    public function add(array $item): array",
        "    {",
        f"        $entity = new {entity_name}();",
        generated == "uuid" and f"        $entity->{key_property} = Uuid::v4()->toRfc4122();",
        generated is None and f"        $entity->{key_property} = $item[{php_string(key_field(resource)['wire'])}];",
        "        $this->fill($entity, $item);",
        "        $this->manager->persist($entity);",
        "        $this->manager->flush();",
        "        // Read back, so the answer has what the database keeps (dates without fractions of a second)",
        "        $this->manager->refresh($entity);",
        "",
        "        return $this->toItem($entity);",
        "    }",
        "",
        f"    public function save({key} $key, array $item): array",
        "    {",
        f"        $entity = $this->manager->find({entity_name}::class, $key);",
        "        $this->fill($entity, $item);",
        "        $this->manager->flush();",
        "        $this->manager->refresh($entity);",
        "",
        "        return $this->toItem($entity);",
        "    }",
        "",
        f"    public function delete({key} $key): void",
        "    {",
        f"        $entity = $this->manager->find({entity_name}::class, $key);",
        "        if ($entity !== null) {",
        "            $this->manager->remove($entity);",
        "            $this->manager->flush();",
        "        }",
        "    }",
        "",
        "    /** Every field but the key takes the value of the item; a field left out is null. */",
        f"    private function fill({entity_name} $entity, array $item): void",
        "    {",
        fill,
        "    }",
        "",
        "    /** The value a filter compares, as the entity holds it. */",
        "    private function toProperty(string $field, mixed $value): mixed",
        "    {",
        ["        return match ($field) {", conversions, "            default => $value,", "        };"]
        if conversions
        else "        return $value;",
        "    }",
        "",
        "    /** @return array<string, mixed> */",
        f"    private function toItem({entity_name} $entity): array",
        "    {",
        "        return [",
        [
            f"            {php_string(field['wire'])} => {_to_value(field, f'$entity->{property_name(field)}')},"
            for field in resource["fields"]
        ],
        "        ];",
        "    }",
        "}",
    )
    return [*files, {"path": class_path(namespace, name["doctrineRepository"]), "content": file_text(content)}]
