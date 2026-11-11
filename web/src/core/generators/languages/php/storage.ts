/**
 * Storage of each resource in a PHP project (Laravel and Symfony) that every framework writes the same: the
 * repository interface the service depends on, the in-memory implementation and the one left to write (501).
 * Items travel as arrays keyed by their JSON names. Each framework adds its own ORM implementation.
 */
import type { SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpDoc, phpHeader, phpString } from './php.ts'
import { keyField, keyType, resourceNames, type PhpProject } from './project.ts'

type Line = string | false | null | undefined | Line[]

function phpFile(context: PhpProject, namespace: string, name: string, imports: PhpImports, body: Line[]): GeneratedFile {
  return { path: context.classPath(namespace, name), content: fileText(lines(...phpHeader(namespace, imports), ...body)) }
}

/** Helpers the in-memory repositories share: comparing values as JSON would. */
export function valuesFile(context: PhpProject): GeneratedFile | null {
  if (context.settings.persistence !== 'memory') return null
  const namespace = context.support
  return phpFile(context, namespace, 'Values', new PhpImports(namespace), [
    phpDoc('Compares values as JSON does: a whole number equals the same number with decimals.'),
    'final class Values',
    '{',
    '    public static function same(mixed $left, mixed $right): bool',
    '    {',
    '        if (is_numeric($left) && is_numeric($right) && ! is_string($left) && ! is_string($right)) {',
    '            return $left == $right;',
    '        }',
    '',
    '        return $left === $right;',
    '    }',
    '',
    '    /** Texts in character order, numbers by value. */',
    '    public static function compare(mixed $left, mixed $right): int',
    '    {',
    '        if (is_string($left) && is_string($right)) {',
    '            return strcmp($left, $right);',
    '        }',
    '',
    '        return $left <=> $right;',
    '    }',
    '}',
  ])
}

/** The repository interface of a resource. */
export function repositoryContractFile(context: PhpProject, resource: SpecResource): GeneratedFile {
  const namespace = context.namespace(resource, 'repository')
  const name = resourceNames(resource)
  const key = keyType(resource)
  const generated = resource.key.generated
  const plural = resource.plural
  const listing = [`${context.support}\\ListQuery`, `${context.support}\\ListResult`]
  return phpFile(context, namespace, name.repository, new PhpImports(namespace).add(...listing), [
    phpDoc(`Where ${plural} are kept. The service depends only on this interface; items are arrays keyed by JSON name.`),
    `interface ${name.repository}`,
    '{',
    '    /** Items equal to every filter, in order, within the window; and how many match. */',
    '    public function list(ListQuery $query): ListResult;',
    '',
    '    /** @return array<string, mixed>|null The item with this key, or null. */',
    `    public function get(${key} $key): ?array;`,
    '',
    '    /**',
    `     * Stores a new item${generated ? ' and assigns its key' : ''}.`,
    '     *',
    '     * @param  array<string, mixed>  $item',
    '     * @return array<string, mixed> The item as stored.',
    '     */',
    '    public function add(array $item): array;',
    '',
    '    /**',
    '     * Stores the new state of an existing item: every field, as given.',
    '     *',
    '     * @param  array<string, mixed>  $item',
    '     * @return array<string, mixed> The item as stored.',
    '     */',
    `    public function save(${key} $key, array $item): array;`,
    '',
    '    /** Removes an existing item. */',
    `    public function delete(${key} $key): void;`,
    '}',
  ])
}

/** Storage left to write: every method answers 501. */
export function pendingRepositoryFile(context: PhpProject, resource: SpecResource): GeneratedFile {
  const namespace = context.namespace(resource, 'repository')
  const name = resourceNames(resource)
  const key = keyType(resource)
  const plural = resource.plural
  const listing = [`${context.support}\\ListQuery`, `${context.support}\\ListResult`]
  const imports = new PhpImports(namespace).add(...listing, `${context.exceptions}\\NotImplementedException`)
  const message = phpString(`The storage of ${plural} is not written yet`)
  const method = (signature: string, returns: string) => [
    `    public function ${signature}: ${returns}`,
    '    {',
    `        // TODO: store ${plural} in your database`,
    `        throw new NotImplementedException(${message});`,
    '    }',
  ]
  return phpFile(context, namespace, name.pendingRepository, imports, [
    phpDoc(`Storage of ${plural} to write: every method answers 501 until it is implemented.`),
    `final class ${name.pendingRepository} implements ${name.repository}`,
    '{',
    method('list(ListQuery $query)', 'ListResult'),
    '',
    method(`get(${key} $key)`, '?array'),
    '',
    method('add(array $item)', 'array'),
    '',
    method(`save(${key} $key, array $item)`, 'array'),
    '',
    method(`delete(${key} $key)`, 'void'),
    '}',
  ])
}

/** Storage in memory, to try the API without a database. */
export function memoryRepositoryFile(context: PhpProject, resource: SpecResource): GeneratedFile {
  const namespace = context.namespace(resource, 'repository')
  const name = resourceNames(resource)
  const key = keyType(resource)
  const keyWire = keyField(resource).wire
  const generated = resource.key.generated
  const plural = resource.plural
  const listing = [`${context.support}\\ListQuery`, `${context.support}\\ListResult`]
  const imports = new PhpImports(namespace).add(...listing, `${context.support}\\Values`)
  if (generated === 'uuid') imports.add(...context.uuid.imports)
  const assign =
    generated === 'increment'
      ? `        $item[${phpString(keyWire)}] = $this->nextKey++;`
      : generated === 'uuid'
        ? `        $item[${phpString(keyWire)}] = ${context.uuid.expression};`
        : null
  return phpFile(context, namespace, name.memory, imports, [
    phpDoc(`Keeps ${plural} in memory: they are lost when the application stops. Use it to try the API.`),
    `final class ${name.memory} implements ${name.repository}`,
    '{',
    '    /** @var array<int|string, array<string, mixed>> */',
    '    private array $items = [];',
    generated === 'increment' && ['', '    private int $nextKey = 1;'],
    '',
    '    public function list(ListQuery $query): ListResult',
    '    {',
    '        $items = array_values(array_filter($this->items, function (array $item) use ($query): bool {',
    '            foreach ($query->filters as $field => $value) {',
    '                if (! Values::same($item[$field] ?? null, $value)) {',
    '                    return false;',
    '                }',
    '            }',
    '',
    '            return true;',
    '        }));',
    '        if ($query->sortField !== null) {',
    '            $field = $query->sortField;',
    '            // Items without a value go last, whatever the order',
    '            $present = array_values(array_filter($items, fn (array $item) => ($item[$field] ?? null) !== null));',
    '            $missing = array_values(array_filter($items, fn (array $item) => ($item[$field] ?? null) === null));',
    '            usort($present, fn (array $a, array $b) => $query->descending',
    '                ? Values::compare($b[$field], $a[$field])',
    '                : Values::compare($a[$field], $b[$field]));',
    '            $items = [...$present, ...$missing];',
    '        }',
    '',
    '        return new ListResult(array_slice($items, $query->offset, $query->limit), count($items));',
    '    }',
    '',
    `    public function get(${key} $key): ?array`,
    '    {',
    '        return $this->items[$key] ?? null;',
    '    }',
    '',
    '    public function add(array $item): array',
    '    {',
    assign,
    `        $this->items[$item[${phpString(keyWire)}]] = $item;`,
    '',
    '        return $item;',
    '    }',
    '',
    `    public function save(${key} $key, array $item): array`,
    '    {',
    '        $this->items[$key] = $item;',
    '',
    '        return $item;',
    '    }',
    '',
    `    public function delete(${key} $key): void`,
    '    {',
    '        unset($this->items[$key]);',
    '    }',
    '}',
  ])
}
