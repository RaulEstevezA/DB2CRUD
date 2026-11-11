/**
 * Controllers, responses and routes of the Laravel project (the services are shared with every PHP
 * framework: languages/php/service.ts).
 *
 * The controller only translates HTTP to service calls: parameters, bodies and status codes. Protection is
 * declared on the routes.
 */
import { alwaysInResponse, PAGE_SIZE, shapeFields } from '../../../openapi/build.ts'
import type { SpecEndpoint, SpecField, SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpClass, phpDoc, phpHeader, phpName, phpString } from '../../languages/php/php.ts'
import { classPath, names, qualified, type LaravelContext } from './context.ts'
import { requestClass } from './requests.ts'

/** The response of a resource: the fields clients read, an optional one only when it has a value. */
export function resourceFile(context: LaravelContext, resource: SpecResource): GeneratedFile {
  const namespace = context.layout.resource(resource, 'resource')
  const name = names(resource)
  const imports = new PhpImports(namespace).add('Illuminate\\Http\\Request', 'Illuminate\\Http\\Resources\\Json\\JsonResource')
  const entries = shapeFields(resource.fields, 'read').map((field) => {
    const wire = phpString(field.wire)
    // Objects and maps are JSON objects even when empty
    const object = !field.reference && (field.type.kind === 'object' || field.type.kind === 'map')
    const value = object ? `self::object($item[${wire}] ?? null)` : `$item[${wire}] ?? null`
    return alwaysInResponse(field)
      ? `            ${wire} => ${value},`
      : `            ${wire} => $this->when(isset($item[${wire}]), fn () => ${value}),`
  })
  const objects = shapeFields(resource.fields, 'read').some(
    (field) => !field.reference && (field.type.kind === 'object' || field.type.kind === 'map'),
  )
  const content = lines(
    ...phpHeader(namespace, imports),
    phpDoc(`${article(resource.singular)} as the API returns it: everything but what clients only send.`),
    `final class ${name.resource} extends JsonResource`,
    '{',
    '    /** @return array<string, mixed> */',
    '    public function toArray(Request $request): array',
    '    {',
    '        $item = $this->resource;',
    '',
    '        return [',
    entries,
    '        ];',
    '    }',
    '',
    '    /**',
    '     * @param  array<string, mixed>  $item',
    '     * @return array<string, mixed>',
    '     */',
    '    public static function one(array $item): array',
    '    {',
    '        return (new self($item))->resolve();',
    '    }',
    '',
    '    /**',
    '     * @param  list<array<string, mixed>>  $items',
    '     * @return list<array<string, mixed>>',
    '     */',
    '    public static function many(array $items): array',
    '    {',
    '        return array_map(self::one(...), $items);',
    '    }',
    objects && [
      '',
      '    /** An empty array is an empty JSON object here, not a list. */',
      '    private static function object(mixed $value): mixed',
      '    {',
      '        return $value === [] ? new \\stdClass() : $value;',
      '    }',
    ],
    '}',
  )
  return { path: classPath(namespace, name.resource), content: fileText(content) }
}

function article(text: string): string {
  const word = /^[aeiou]/i.test(text) ? `An ${text}` : `A ${text}`
  return word
}

/** The rule and the conversion of a query value: query strings are text, so numbers and booleans are read. */
function queryValue(context: LaravelContext, field: SpecField, imports: PhpImports): { rules: string[]; read: (value: string) => string } {
  const target = field.reference ? context.spec.resources.find((item) => item.name === field.reference) : undefined
  const type = target ? target.key.type : field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    imports.add('Illuminate\\Validation\\Rule')
    const integer = item.valueType === 'integer'
    return {
      rules: [`Rule::in([${item.values.map((value) => (integer ? String(value) : phpString(String(value)))).join(', ')}])`],
      read: (value) => (integer ? `(int) ${value}` : value),
    }
  }
  if (type.kind === 'scalar') {
    if (type.scalar === 'integer') return { rules: ["'integer'"], read: (value) => `(int) ${value}` }
    if (type.scalar === 'float' || type.scalar === 'decimal') return { rules: ["'numeric'"], read: (value) => `(float) ${value}` }
    if (type.scalar === 'boolean') return { rules: ["'in:true,false'"], read: (value) => `${value} === 'true'` }
    if (type.scalar === 'uuid') return { rules: ["'uuid'"], read: (value) => value }
    if (type.scalar === 'date') return { rules: ["'date_format:Y-m-d'"], read: (value) => value }
  }
  return { rules: ["'string'"], read: (value) => value }
}

/** The statement that reads the key of a path, with its type: a malformed key is a 400. */
function keyRead(resource: SpecResource, param: string): string {
  const variable = `$${phpName(param)}`
  if (resource.key.type.scalar === 'integer') return `$key = $this->integerKey(${variable}, ${phpString(param)});`
  if (resource.key.type.scalar === 'uuid') return `$key = $this->uuidKey(${variable}, ${phpString(param)});`
  return `$key = ${variable};`
}

export function controllerFile(context: LaravelContext, resource: SpecResource): GeneratedFile {
  const namespace = context.layout.resource(resource, 'controller')
  const name = names(resource)
  const imports = new PhpImports(namespace).add(
    'App\\Http\\Controllers\\Controller',
    'Symfony\\Component\\HttpFoundation\\Response',
    qualified(context, resource, 'service', name.service),
    qualified(context, resource, 'resource', name.resource),
  )
  const keyParam = resource.key.param
  const methods = resource.endpoints.map((endpoint) => {
    const fn = phpName(endpoint.name)
    const params: string[] = []
    const body: string[] = []
    const hasKey = endpoint.pathParams.some((param) => param.name === keyParam)
    if (endpoint.input !== 'none') {
      const request = requestClass(context, resource, endpoint.input === 'partial' ? 'update' : 'create')
      imports.add(request)
      params.push(`${request.slice(request.lastIndexOf('\\') + 1)} $request`)
    }
    if (endpoint.operation === 'list') {
      imports.add('Illuminate\\Http\\Request')
      params.push('Request $request')
    }
    for (const param of endpoint.pathParams) params.push(`string $${phpName(param.name)}`)
    if (hasKey) body.push(keyRead(resource, keyParam))
    if (endpoint.input !== 'none') body.push('$values = $request->values();')
    const status = endpoint.status
    switch (endpoint.operation) {
      case 'list': {
        imports.add('App\\Support\\ListQuery')
        const rules: string[] = []
        if (endpoint.pagination) {
          rules.push("'page' => ['sometimes', 'integer', 'min:1'],", `'size' => ['sometimes', 'integer', 'min:1', 'max:${PAGE_SIZE.max}'],`)
        }
        const reads: string[] = []
        for (const wire of endpoint.filters) {
          const field = resource.fields.find((item) => item.wire === wire)!
          const { rules: filterRules, read } = queryValue(context, field, imports)
          rules.push(`${phpString(wire)} => ['sometimes', ${filterRules.join(', ')}],`)
          reads.push(
            `if (array_key_exists(${phpString(wire)}, $query)) {`,
            `    $filters[${phpString(wire)}] = ${read(`$query[${phpString(wire)}]`)};`,
            '}',
          )
        }
        if (endpoint.sort.length > 0) {
          imports.add('Illuminate\\Validation\\Rule')
          rules.push(
            `'sort' => ['sometimes', Rule::in([${endpoint.sort.flatMap((wire) => [phpString(wire), phpString(`-${wire}`)]).join(', ')}])],`,
          )
        }
        body.push(
          rules.length > 0 ? ['$query = $request->validate([', ...rules.map((rule) => `    ${rule}`), ']);'].join('\n') : '$query = [];',
        )
        body.push('$filters = [];', ...reads)
        const sort = endpoint.sort.length > 0 ? "$query['sort'] ?? null" : 'null'
        if (endpoint.pagination) {
          body.push(
            "$page = (int) ($query['page'] ?? 1);",
            `$size = (int) ($query['size'] ?? ${PAGE_SIZE.default});`,
            `$result = $this->service->${fn}(ListQuery::of($filters, ${sort}, ($page - 1) * $size, $size));`,
            '',
            `return response()->json(['items' => ${name.resource}::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], ${status});`,
          )
        } else {
          body.push(
            `$result = $this->service->${fn}(ListQuery::of($filters, ${sort}));`,
            '',
            `return response()->json(${name.resource}::many($result->items), ${status});`,
          )
        }
        if (rules.length === 0) body.splice(body.indexOf('$query = [];'), 1)
        break
      }
      case 'get':
        body.push('', `return response()->json(${name.resource}::one($this->service->${fn}($key)), ${status});`)
        break
      case 'create':
        body.push('', `return response()->json(${name.resource}::one($this->service->${fn}($values)), ${status});`)
        break
      case 'replace':
      case 'update':
        body.push('', `return response()->json(${name.resource}::one($this->service->${fn}($key, $values)), ${status});`)
        break
      case 'delete':
        body.push(`$this->service->${fn}($key);`, '', `return response()->noContent(${status});`)
        break
      case 'custom': {
        const call = `$this->service->${fn}(${[hasKey ? '$key' : null, endpoint.input !== 'none' ? '$values' : null].filter(Boolean).join(', ')})`
        if (endpoint.output === 'none' || status === 204) body.push(`${call};`, '', `return response()->noContent(${status});`)
        else if (endpoint.output === 'list') body.push('', `return response()->json(${name.resource}::many(${call}), ${status});`)
        else body.push('', `return response()->json(${name.resource}::one(${call}), ${status});`)
        break
      }
    }
    const code = body
    return lines(
      `    /** ${endpoint.summary}. */`,
      `    public function ${fn}(${params.join(', ')}): Response`,
      '    {',
      code.flatMap((line) => line.split('\n')).map((line) => (line === '' ? '' : `        ${line}`)),
      '    }',
    )
  })
  const content = lines(
    ...phpHeader(namespace, imports),
    phpDoc(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`),
    `final class ${name.controller} extends Controller`,
    '{',
    `    public function __construct(private readonly ${name.service} $service)`,
    '    {',
    '    }',
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path: classPath(namespace, name.controller), content: fileText(content) }
}

/** The base controller: reading keys from paths with their type. */
export function baseControllerFile(): GeneratedFile {
  const namespace = 'App\\Http\\Controllers'
  const content = lines(
    ...phpHeader(namespace, new PhpImports(namespace).add('App\\Exceptions\\ApiException', 'Illuminate\\Support\\Str')),
    phpDoc('Base of the controllers: the key in a path, read with its type. A malformed key is a 400, not a missing item.'),
    'abstract class Controller',
    '{',
    '    protected function integerKey(string $value, string $name): int',
    '    {',
    "        if (preg_match('/^-?\\d+$/', $value) !== 1) {",
    "            throw ApiException::invalid($name, 'Must be a whole number');",
    '        }',
    '',
    '        return (int) $value;',
    '    }',
    '',
    '    protected function uuidKey(string $value, string $name): string',
    '    {',
    '        if (! Str::isUuid($value)) {',
    "            throw ApiException::invalid($name, 'Must be a UUID');",
    '        }',
    '',
    '        return $value;',
    '    }',
    '}',
  )
  return { path: 'app/Http/Controllers/Controller.php', content: fileText(content) }
}

/** The middleware that protects an endpoint, or null for a public one. */
function guard(context: LaravelContext, endpoint: SpecEndpoint): string | null {
  if (endpoint.access === 'public' || context.settings.auth === 'none') return null
  if (context.settings.auth === 'apiKey') return 'api.key'
  return endpoint.access === 'roles' ? `token:${endpoint.roles.join(',')}` : 'token'
}

export function routesFile(context: LaravelContext): GeneratedFile {
  const imports = new Set<string>(['Illuminate\\Support\\Facades\\Route'])
  const blocks = context.spec.resources.map((resource) => {
    const name = names(resource)
    imports.add(qualified(context, resource, 'controller', name.controller))
    const routes = resource.endpoints.map((endpoint) => {
      const protection = guard(context, endpoint)
      const route = `Route::${endpoint.method.toLowerCase()}(${phpString(endpoint.path)}, [${name.controller}::class, ${phpString(phpName(endpoint.name))}])`
      return `${route}${protection ? `->middleware(${phpString(protection)})` : ''};`
    })
    return lines(`// ${phpClass(resource.plural)}`, routes)
  })
  const content = lines(
    '<?php',
    '',
    [...imports].sort().map((name) => `use ${name};`),
    '',
    '// Every route of the API, with its protection. The contract is in openapi.yaml.',
    '',
    blocks.join('\n\n'),
  )
  return { path: 'routes/api.php', content: fileText(content) }
}
