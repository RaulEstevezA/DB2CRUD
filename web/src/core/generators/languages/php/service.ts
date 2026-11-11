/**
 * The service of a resource in a PHP project (Laravel and Symfony): its rules. Items that must exist, keys
 * that must not repeat, references that must point to stored items, and the values the server fills (keys,
 * timestamps, defaults). Business endpoints get a method that answers 501 with a TODO where their logic
 * goes. Items are arrays keyed by their JSON names.
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import type { JsonValue } from '../../common/samples.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpDoc, phpHeader, phpLiteral, phpName, phpString } from './php.ts'
import { innerObject, keyField, keyType, referencedResources, resourceNames, type PhpProject } from './project.ts'

/** PHP statements that check every reference of a set of values, nested objects included. */
function referenceChecks(
  context: PhpProject,
  resource: SpecResource,
  fields: SpecField[],
  source: string,
  label: string,
  depth: number,
): string[] {
  const checks: string[] = []
  for (const field of fields) {
    const value = `${source}[${phpString(field.wire)}]`
    const where = label ? `${label}.${field.wire}` : field.wire
    if (field.reference) {
      const repository = field.reference === resource.name ? '$this->repository' : `$this->${phpName(field.reference)}Repository`
      if (field.type.kind === 'array')
        checks.push(
          `foreach (${value} ?? [] as $key) {`,
          `    $this->require(${repository}, $key, ${phpString(where)}, ${phpString(field.reference)});`,
          '}',
        )
      else checks.push(`$this->require(${repository}, ${value} ?? null, ${phpString(where)}, ${phpString(field.reference)});`)
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3) continue
    const variable = `$item${depth}`
    const nested = referenceChecks(context, resource, object.fields, variable, where, depth + 1)
    if (nested.length === 0) continue
    if (field.type.kind === 'array') checks.push(`foreach (${value} ?? [] as ${variable}) {`, ...nested.map((line) => `    ${line}`), '}')
    else if (field.type.kind === 'object')
      checks.push(`if (is_array(${value} ?? null)) {`, `    ${variable} = ${value};`, ...nested.map((line) => `    ${line}`), '}')
  }
  return checks
}

/** Assignments of the values the server gives read-only fields in an operation. */
function serverValues(resource: SpecResource, operation: 'create' | 'replace' | 'update'): string[] {
  const result: string[] = []
  for (const field of resource.fields) {
    if (field.access !== 'readOnly' || field.server === 'key') continue
    const target = `$item[${phpString(field.wire)}]`
    if (field.server === 'updated') result.push(`${target} = $now;`)
    else if (field.server === 'created' && operation === 'create') result.push(`${target} = $now;`)
    else if (field.server === 'default' && operation === 'create')
      result.push(`${target} = ${phpLiteral((field.defaultValue ?? null) as JsonValue)};`)
    else if (field.server === 'pending' && operation === 'create')
      result.push(`// TODO: ${field.todo ?? `fill "${field.name}"`}`, `${target} = null;`)
  }
  return result
}

function usesNow(resource: SpecResource, operation: 'create' | 'replace' | 'update'): boolean {
  return resource.fields.some(
    (field) => field.access === 'readOnly' && (field.server === 'updated' || (field.server === 'created' && operation === 'create')),
  )
}

export function serviceFile(context: PhpProject, resource: SpecResource): GeneratedFile {
  const namespace = context.namespace(resource, 'service')
  const name = resourceNames(resource)
  const key = keyType(resource)
  const keyWire = keyField(resource).wire
  const imports = new PhpImports(namespace).add(
    `${context.namespace(resource, 'repository')}\\${name.repository}`,
    `${context.exceptions}\\ApiException`,
  )
  const needs = referencedResources(context, resource)
  for (const target of needs) imports.add(`${context.namespace(target, 'repository')}\\${resourceNames(target).repository}`)
  const checks = referenceChecks(context, resource, resource.fields, '$values', '', 0)
  const hasChecks = checks.length > 0 && resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const clientKey = resource.key.generated === null
  const kept = resource.fields.filter((field) => field.access === 'readOnly').map((field) => phpString(field.wire))
  const methods: string[] = [
    lines(
      '    /** @return array<string, mixed> */',
      `    private function find(${key} $key): array`,
      '    {',
      `        return $this->repository->get($key) ?? throw ApiException::notFound(${phpString(resource.singular)});`,
      '    }',
    ),
  ]
  if (hasChecks)
    methods.push(
      lines(
        '    /** A reference must point to a stored item. */',
        '    private function require(object $repository, mixed $key, string $field, string $model): void',
        '    {',
        '        if ($key !== null && $repository->get($key) === null) {',
        '            throw ApiException::invalid($field, "No {$model} has this key");',
        '        }',
        '    }',
        '',
        '    /** @param array<string, mixed> $values */',
        '    private function checkReferences(array $values): void',
        '    {',
        checks.map((line) => `        ${line}`),
        '    }',
      ),
    )
  const check = hasChecks && '        $this->checkReferences($values);'
  const now = (operation: 'create' | 'replace' | 'update') => usesNow(resource, operation) && `        $now = ${context.now};`
  const fill = (operation: 'create' | 'replace' | 'update') => serverValues(resource, operation).map((line) => `        ${line}`)
  for (const endpoint of resource.endpoints) {
    const fn = phpName(endpoint.name)
    switch (endpoint.operation) {
      case 'list':
        imports.add(`${context.support}\\ListQuery`, `${context.support}\\ListResult`)
        methods.push(
          lines(
            `    /** ${endpoint.summary}. */`,
            `    public function ${fn}(ListQuery $query): ListResult`,
            '    {',
            '        return $this->repository->list($query);',
            '    }',
          ),
        )
        break
      case 'get':
        methods.push(
          lines(
            `    /** @return array<string, mixed> ${endpoint.summary}. */`,
            `    public function ${fn}(${key} $key): array`,
            '    {',
            '        return $this->find($key);',
            '    }',
          ),
        )
        break
      case 'create':
        methods.push(
          lines(
            '    /**',
            `     * ${endpoint.summary}.`,
            '     *',
            '     * @param  array<string, mixed>  $values',
            '     * @return array<string, mixed>',
            '     */',
            `    public function ${fn}(array $values): array`,
            '    {',
            clientKey && [
              `        if (isset($values[${phpString(keyWire)}]) && $this->repository->get($values[${phpString(keyWire)}]) !== null) {`,
              `            throw ApiException::conflict(${phpString(`A ${resource.singular} with this key already exists`)});`,
              '        }',
            ],
            check,
            '        $item = $values;',
            now('create'),
            fill('create'),
            '',
            '        return $this->repository->add($item);',
            '    }',
          ),
        )
        break
      case 'replace':
        methods.push(
          lines(
            '    /**',
            `     * ${endpoint.summary}: every field the client may send takes the value of the body.`,
            '     *',
            '     * @param  array<string, mixed>  $values',
            '     * @return array<string, mixed>',
            '     */',
            `    public function ${fn}(${key} $key, array $values): array`,
            '    {',
            '        $current = $this->find($key);',
            clientKey && [
              `        if (($values[${phpString(keyWire)}] ?? null) !== $key) {`,
              `            throw ApiException::invalid(${phpString(keyWire)}, 'The key cannot change');`,
              '        }',
            ],
            check,
            '        // What the server keeps (key, timestamps) stays; the rest is what the body says',
            `        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];`,
            now('replace'),
            fill('replace'),
            '',
            '        return $this->repository->save($key, $item);',
            '    }',
          ),
        )
        break
      case 'update': {
        const changesKey = clientKey && keyField(resource).access !== 'readOnly'
        methods.push(
          lines(
            '    /**',
            `     * ${endpoint.summary}: only the fields in the body change.`,
            '     *',
            '     * @param  array<string, mixed>  $values',
            '     * @return array<string, mixed>',
            '     */',
            `    public function ${fn}(${key} $key, array $values): array`,
            '    {',
            '        $current = $this->find($key);',
            changesKey && [
              `        if (array_key_exists(${phpString(keyWire)}, $values) && $values[${phpString(keyWire)}] !== $key) {`,
              `            throw ApiException::invalid(${phpString(keyWire)}, 'The key cannot change');`,
              '        }',
            ],
            check,
            '        $item = [...$current, ...$values];',
            now('update'),
            fill('update'),
            '',
            '        return $this->repository->save($key, $item);',
            '    }',
          ),
        )
        break
      }
      case 'delete':
        methods.push(
          lines(
            `    /** ${endpoint.summary}. */`,
            `    public function ${fn}(${key} $key): void`,
            '    {',
            '        $this->find($key);',
            '        $this->repository->delete($key);',
            '    }',
          ),
        )
        break
      case 'custom': {
        imports.add(`${context.exceptions}\\NotImplementedException`)
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const params = [hasKey ? `${key} $key` : null, endpoint.input !== 'none' ? 'array $values' : null].filter(Boolean)
        const returns = endpoint.output === 'none' ? 'void' : 'array'
        methods.push(
          lines(
            '    /**',
            `     * ${endpoint.summary}.`,
            endpoint.input !== 'none' && ['     *', '     * @param  array<string, mixed>  $values'],
            endpoint.output === 'list' && ['     *', '     * @return list<array<string, mixed>>'],
            endpoint.output === 'resource' && ['     *', '     * @return array<string, mixed>'],
            '     */',
            `    public function ${fn}(${params.join(', ')}): ${returns}`,
            '    {',
            hasKey && '        $this->find($key);',
            `        // TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            `        throw new NotImplementedException(${phpString(`${endpoint.summary} is not written yet`)});`,
            '    }',
          ),
        )
        break
      }
    }
  }
  const replaces = resource.endpoints.some((endpoint) => endpoint.operation === 'replace')
  const constructorParams = [
    `        private readonly ${name.repository} $repository,`,
    ...needs.map((target) => `        private readonly ${resourceNames(target).repository} $${phpName(target.name)}Repository,`),
  ]
  const content = lines(
    ...phpHeader(namespace, imports),
    phpDoc(`Rules of ${resource.plural}: what each operation checks and changes.`),
    `final class ${name.service}`,
    '{',
    replaces && [
      '    /** Fields only the server writes, kept when an item is replaced */',
      `    private const SERVER_FIELDS = [${kept.join(', ')}];`,
      '',
    ],
    '    public function __construct(',
    constructorParams,
    '    ) {',
    '    }',
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path: context.classPath(namespace, name.service), content: fileText(content) }
}
