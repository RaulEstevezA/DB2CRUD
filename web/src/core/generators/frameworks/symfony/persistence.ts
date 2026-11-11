/**
 * Storage of each resource with Doctrine ORM in the Symfony project: an entity mapped with attributes, and a
 * repository that maps entities to the arrays the service works with (keyed by JSON name). The interface, the
 * in-memory and the pending repositories are shared with every PHP framework (languages/php/storage.ts).
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpDoc, phpHeader, phpString } from '../../languages/php/php.ts'
import { keyField, keyType } from '../../languages/php/project.ts'
import { memoryRepositoryFile, pendingRepositoryFile, repositoryContractFile } from '../../languages/php/storage.ts'
import { classPath, column, names, property, qualified, type SymfonyContext } from './context.ts'

function isScalar(field: SpecField, scalar: string): boolean {
  return !field.reference && field.type.kind === 'scalar' && field.type.scalar === scalar
}

/** Whether a field is stored as JSON: lists, maps, embedded objects and values of any shape. */
function storedAsJson(field: SpecField): boolean {
  return field.type.kind === 'array' || field.type.kind === 'map' || field.type.kind === 'object' || isScalar(field, 'any')
}

/** The Doctrine column type, its PHP property type and the extra column options of a field. */
function columnOf(context: SymfonyContext, field: SpecField): { type: string; php: string; options: string } {
  if (storedAsJson(field)) return { type: 'Types::JSON', php: 'mixed', options: '' }
  // A reference column has the type of the key it holds, BIGINT included
  const keyColumn = (target: SpecResource) =>
    target.key.type.scalar === 'integer'
      ? { type: target.key.type.bits === 64 ? 'Types::BIGINT' : 'Types::INTEGER', php: '?int', options: '' }
      : target.key.type.scalar === 'uuid'
        ? { type: 'Types::GUID', php: '?string', options: '' }
        : { type: 'Types::STRING', php: '?string', options: `, length: ${keyField(target).constraints.maxLength ?? 191}` }
  if (field.reference) return keyColumn(context.spec.resources.find((item) => item.name === field.reference)!)
  if (field.type.kind === 'enum') {
    const name = field.type.name
    const item = context.spec.enums.find((entry) => entry.name === name)
    return item?.valueType === 'integer'
      ? { type: 'Types::INTEGER', php: '?int', options: '' }
      : { type: 'Types::STRING', php: '?string', options: ', length: 64' }
  }
  if (field.type.kind !== 'scalar') return { type: 'Types::TEXT', php: '?string', options: '' }
  const max = field.constraints.maxLength
  switch (field.type.scalar) {
    case 'string':
      return max !== undefined && max <= 255
        ? { type: 'Types::STRING', php: '?string', options: `, length: ${max}` }
        : { type: 'Types::TEXT', php: '?string', options: '' }
    case 'integer':
      return { type: field.type.bits === 64 ? 'Types::BIGINT' : 'Types::INTEGER', php: '?int', options: '' }
    case 'float':
      return { type: 'Types::FLOAT', php: '?float', options: '' }
    case 'decimal':
      return { type: 'Types::DECIMAL', php: '?string', options: ', precision: 18, scale: 4' }
    case 'boolean':
      return { type: 'Types::BOOLEAN', php: '?bool', options: '' }
    case 'date':
      return { type: 'Types::DATE_IMMUTABLE', php: '?\\DateTimeImmutable', options: '' }
    case 'datetime':
      return { type: 'Types::DATETIME_IMMUTABLE', php: '?\\DateTimeImmutable', options: '' }
    case 'time':
      return { type: 'Types::STRING', php: '?string', options: ', length: 15' }
    case 'uuid':
      return { type: 'Types::GUID', php: '?string', options: '' }
    default:
      return { type: 'Types::TEXT', php: '?string', options: '' }
  }
}

/**
 * A table or column name in backticks: Doctrine then quotes it with each database's own quotes, so a name that
 * is a reserved word somewhere (MySQL: `lines`, `groups`; PostgreSQL: `user`) still works.
 */
function quoted(identifier: string): string {
  return `\`${identifier}\``
}

/** The Doctrine entity of a resource. */
export function entityFile(context: SymfonyContext, resource: SpecResource): GeneratedFile | null {
  if (!context.doctrine) return null
  const namespace = context.layout.resource(resource, 'entity')
  const name = names(resource)
  const imports = new PhpImports(namespace).add('Doctrine\\DBAL\\Types\\Types', 'Doctrine\\ORM\\Mapping as ORM')
  const properties = resource.fields.map((field) => {
    const { type, php, options } = columnOf(context, field)
    const isKey = field.name === resource.key.field
    const attributes = [
      isKey && '    #[ORM\\Id]',
      isKey && resource.key.generated === 'increment' && '    #[ORM\\GeneratedValue]',
      `    #[ORM\\Column(name: ${phpString(quoted(column(field)))}, type: ${type}${options}${isKey ? '' : ', nullable: true'})]`,
    ]
    return lines(field.todo && `    // TODO: ${field.todo}`, attributes, `    public ${php} $${property(field)} = null;`)
  })
  const content = lines(
    ...phpHeader(namespace, imports),
    resource.todo && `// TODO: ${resource.todo}`,
    phpDoc(`A row of the ${name.table} table. Every column but the key accepts null: the requests check what is required.`),
    '#[ORM\\Entity]',
    `#[ORM\\Table(name: ${phpString(quoted(name.table))})]`,
    `class ${name.entity}`,
    '{',
    properties.join('\n\n'),
    '}',
  )
  return { path: classPath(namespace, name.entity), content: fileText(content) }
}

export function repositoryFiles(context: SymfonyContext, resource: SpecResource): GeneratedFile[] {
  const files = [repositoryContractFile(context, resource)]
  if (context.pending) return [...files, pendingRepositoryFile(context, resource)]
  if (!context.doctrine) return [...files, memoryRepositoryFile(context, resource)]
  const namespace = context.layout.resource(resource, 'repository')
  const name = names(resource)
  const key = keyType(resource)
  const generated = resource.key.generated
  const entity = qualified(context, resource, 'entity', name.entity)
  const imports = new PhpImports(namespace).add(
    'App\\Support\\ListQuery',
    'App\\Support\\ListResult',
    'Doctrine\\ORM\\EntityManagerInterface',
    entity,
  )
  if (generated === 'uuid') imports.add('Symfony\\Component\\Uid\\Uuid')
  const keyProperty = property(keyField(resource))
  const properties = resource.fields.map((field) => `        ${phpString(field.wire)} => ${phpString(property(field))},`)
  // From the JSON value to the property, and back
  // An expression such as `$item['total'] ?? null` goes in parentheses: `??` binds looser than `===`
  const toProperty = (field: SpecField, value: string) => {
    const operand = /^\$\w+$/.test(value) ? value : `(${value})`
    if (isScalar(field, 'datetime'))
      return `${operand} === null ? null : (new \\DateTimeImmutable(${value}))->setTimezone(new \\DateTimeZone('UTC'))`
    if (isScalar(field, 'date')) return `${operand} === null ? null : \\DateTimeImmutable::createFromFormat('!Y-m-d', ${value})`
    if (isScalar(field, 'decimal')) return `${operand} === null ? null : (string) ${operand}`
    return value
  }
  const toValue = (field: SpecField, value: string) => {
    if (isScalar(field, 'datetime')) return `${value}?->setTimezone(new \\DateTimeZone('UTC'))->format('Y-m-d\\TH:i:s\\Z')`
    if (isScalar(field, 'date')) return `${value}?->format('Y-m-d')`
    if (isScalar(field, 'decimal')) return `${value} === null ? null : (float) ${value}`
    return value
  }
  const fill = resource.fields
    .filter((field) => field.name !== resource.key.field)
    .map((field) => `        $entity->${property(field)} = ${toProperty(field, `$item[${phpString(field.wire)}] ?? null`)};`)
  const conversions = resource.fields
    .filter((field) => isScalar(field, 'datetime') || isScalar(field, 'date') || isScalar(field, 'decimal'))
    .map((field) => `            ${phpString(field.wire)} => ${toProperty(field, '$value')},`)
  const content = lines(
    ...phpHeader(namespace, imports),
    phpDoc(`Keeps ${resource.plural} in the database with Doctrine.`),
    `final class ${name.doctrineRepository} implements ${name.repository}`,
    '{',
    '    /** The entity property of each JSON field */',
    '    private const PROPERTIES = [',
    properties,
    '    ];',
    '',
    '    public function __construct(private readonly EntityManagerInterface $manager)',
    '    {',
    '    }',
    '',
    '    public function list(ListQuery $query): ListResult',
    '    {',
    `        $builder = $this->manager->createQueryBuilder()->select('item')->from(${name.entity}::class, 'item');`,
    '        $index = 0;',
    '        foreach ($query->filters as $field => $value) {',
    "            $parameter = 'filter'.$index++;",
    "            $builder->andWhere('item.'.self::PROPERTIES[$field].' = :'.$parameter)->setParameter($parameter, $this->toProperty($field, $value));",
    '        }',
    "        $total = (int) (clone $builder)->select('COUNT(item)')->getQuery()->getSingleScalarResult();",
    '        if ($query->sortField !== null) {',
    "            $sorted = 'item.'.self::PROPERTIES[$query->sortField];",
    '            // Items without a value go last, whatever the order',
    '            $builder->addSelect("CASE WHEN {$sorted} IS NULL THEN 1 ELSE 0 END AS HIDDEN missing")',
    "                ->addOrderBy('missing', 'ASC')",
    "                ->addOrderBy($sorted, $query->descending ? 'DESC' : 'ASC');",
    '        }',
    `        $builder->addOrderBy(${phpString(`item.${keyProperty}`)}, 'ASC')->setFirstResult($query->offset);`,
    '        if ($query->limit !== null) {',
    '            $builder->setMaxResults($query->limit);',
    '        }',
    '',
    '        return new ListResult(array_map($this->toItem(...), $builder->getQuery()->getResult()), $total);',
    '    }',
    '',
    `    public function get(${key} $key): ?array`,
    '    {',
    `        $entity = $this->manager->find(${name.entity}::class, $key);`,
    '',
    '        return $entity === null ? null : $this->toItem($entity);',
    '    }',
    '',
    '    public function add(array $item): array',
    '    {',
    `        $entity = new ${name.entity}();`,
    generated === 'uuid' && `        $entity->${keyProperty} = Uuid::v4()->toRfc4122();`,
    generated === null && `        $entity->${keyProperty} = $item[${phpString(keyField(resource).wire)}];`,
    '        $this->fill($entity, $item);',
    '        $this->manager->persist($entity);',
    '        $this->manager->flush();',
    '        // Read back, so the answer has what the database keeps (dates without fractions of a second)',
    '        $this->manager->refresh($entity);',
    '',
    '        return $this->toItem($entity);',
    '    }',
    '',
    `    public function save(${key} $key, array $item): array`,
    '    {',
    `        $entity = $this->manager->find(${name.entity}::class, $key);`,
    '        $this->fill($entity, $item);',
    '        $this->manager->flush();',
    '        $this->manager->refresh($entity);',
    '',
    '        return $this->toItem($entity);',
    '    }',
    '',
    `    public function delete(${key} $key): void`,
    '    {',
    `        $entity = $this->manager->find(${name.entity}::class, $key);`,
    '        if ($entity !== null) {',
    '            $this->manager->remove($entity);',
    '            $this->manager->flush();',
    '        }',
    '    }',
    '',
    '    /** Every field but the key takes the value of the item; a field left out is null. */',
    `    private function fill(${name.entity} $entity, array $item): void`,
    '    {',
    fill,
    '    }',
    '',
    '    /** The value a filter compares, as the entity holds it. */',
    '    private function toProperty(string $field, mixed $value): mixed',
    '    {',
    conversions.length > 0
      ? ['        return match ($field) {', conversions, '            default => $value,', '        };']
      : '        return $value;',
    '    }',
    '',
    '    /** @return array<string, mixed> */',
    `    private function toItem(${name.entity} $entity): array`,
    '    {',
    '        return [',
    resource.fields.map((field) => `            ${phpString(field.wire)} => ${toValue(field, `$entity->${property(field)}`)},`),
    '        ];',
    '    }',
    '}',
  )
  return [...files, { path: classPath(namespace, name.doctrineRepository), content: fileText(content) }]
}
