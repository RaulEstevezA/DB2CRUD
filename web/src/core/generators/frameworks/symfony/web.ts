/**
 * Controllers and responses of the Symfony project (the services are shared with every PHP framework:
 * languages/php/service.ts). The controller only translates HTTP to service calls: parameters, bodies, status
 * codes and the protection each endpoint declares.
 */
import type { SpecEndpoint, SpecField, SpecResource } from '../../../api/spec.ts'
import { alwaysInResponse, PAGE_SIZE, shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpDoc, phpHeader, phpName, phpRegex, phpString } from '../../languages/php/php.ts'
import { capitalize, article } from '../../languages/php/project.ts'
import { classPath, names, qualified, type SymfonyContext } from './context.ts'

function isObject(field: SpecField): boolean {
  return !field.reference && (field.type.kind === 'object' || field.type.kind === 'map')
}

/** The response of a resource: the fields clients read, an optional one only when it has a value. */
export function presenterFile(context: SymfonyContext, resource: SpecResource): GeneratedFile {
  const namespace = context.layout.resource(resource, 'presenter')
  const name = names(resource)
  const fields = shapeFields(resource.fields, 'read')
  const statements = fields.flatMap((field) => {
    const wire = phpString(field.wire)
    // Objects and maps are JSON objects even when empty
    const value = isObject(field) ? `self::object($item[${wire}] ?? null)` : `$item[${wire}] ?? null`
    return alwaysInResponse(field)
      ? [`        $response[${wire}] = ${value};`]
      : [`        if (isset($item[${wire}])) {`, `            $response[${wire}] = ${value};`, '        }']
  })
  const content = lines(
    ...phpHeader(namespace, new PhpImports(namespace)),
    phpDoc(`${capitalize(article(resource.singular))} as the API returns it: everything but what clients only send.`),
    `final class ${name.presenter}`,
    '{',
    '    /**',
    '     * @param  array<string, mixed>  $item',
    '     * @return array<string, mixed>',
    '     */',
    '    public static function one(array $item): array',
    '    {',
    '        $response = [];',
    statements,
    '',
    '        return $response;',
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
    fields.some(isObject) && [
      '',
      '    /** An empty array is an empty JSON object here, not a list. */',
      '    private static function object(mixed $value): mixed',
      '    {',
      '        return $value === [] ? new \\stdClass() : $value;',
      '    }',
    ],
    '}',
  )
  return { path: classPath(namespace, name.presenter), content: fileText(content) }
}

/** The statement that reads a filter of the query string, with the type of its field. */
function filterRead(context: SymfonyContext, field: SpecField): string {
  const wire = phpString(field.wire)
  const target = field.reference ? context.spec.resources.find((item) => item.name === field.reference) : undefined
  const type = target ? target.key.type : field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    const choices = item.values.map((value) => (item.valueType === 'integer' ? String(value) : phpString(String(value))))
    return `$this->choiceQuery($request, ${wire}, [${choices.join(', ')}])`
  }
  if (type.kind === 'scalar') {
    if (type.scalar === 'integer') return `$this->integerQuery($request, ${wire})`
    if (type.scalar === 'float' || type.scalar === 'decimal') return `$this->numberQuery($request, ${wire})`
    if (type.scalar === 'boolean') return `$this->booleanQuery($request, ${wire})`
    if (type.scalar === 'uuid') {
      return `$this->textQuery($request, ${wire}, ${phpString(phpRegex('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))})`
    }
    if (type.scalar === 'date') return `$this->textQuery($request, ${wire}, ${phpString(phpRegex('^\\d{4}-\\d{2}-\\d{2}$'))})`
  }
  return `$this->textQuery($request, ${wire})`
}

/** The statement that reads the key of a path, with its type: a malformed key is a 400. */
function keyRead(resource: SpecResource): string {
  const param = phpString(resource.key.param)
  if (resource.key.type.scalar === 'integer') return `$key = $this->integerKey($request, ${param});`
  if (resource.key.type.scalar === 'uuid') return `$key = $this->uuidKey($request, ${param});`
  return `$key = $this->textKey($request, ${param});`
}

/** The protection an endpoint declares, or null for a public one. */
function guard(context: SymfonyContext, endpoint: SpecEndpoint, imports: PhpImports): string | null {
  if (endpoint.access === 'public' || context.settings.auth === 'none') return null
  imports.add('App\\Security\\RequiresAccess')
  if (endpoint.access === 'roles' && context.settings.auth === 'jwt')
    return `    #[RequiresAccess(roles: [${endpoint.roles.map(phpString).join(', ')}])]`
  return '    #[RequiresAccess]'
}

export function controllerFile(context: SymfonyContext, resource: SpecResource): GeneratedFile {
  const namespace = context.layout.resource(resource, 'controller')
  const name = names(resource)
  const service = qualified(context, resource, 'service', name.service)
  const imports = new PhpImports(namespace).add(
    'App\\Controller\\ApiController',
    'Symfony\\Component\\HttpFoundation\\Request',
    'Symfony\\Component\\HttpFoundation\\Response',
    'Symfony\\Component\\HttpKernel\\Attribute\\AsController',
    'Symfony\\Component\\Routing\\Attribute\\Route',
    service,
    qualified(context, resource, 'presenter', name.presenter),
  )
  const keyParam = resource.key.param
  const usesBody = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  if (usesBody) imports.add('App\\Http\\JsonBody', qualified(context, resource, 'input', name.input))
  const methods = resource.endpoints.map((endpoint) => {
    const fn = phpName(endpoint.name)
    const body: string[] = []
    const hasKey = endpoint.pathParams.some((param) => param.name === keyParam)
    if (hasKey) body.push(keyRead(resource))
    if (endpoint.input === 'resource')
      body.push(`$values = ${name.input}::createValues($this->body->read($request, ${name.input}::create()));`)
    if (endpoint.input === 'partial')
      body.push(`$values = ${name.input}::updateValues($this->body->read($request, ${name.input}::update()));`)
    const status = endpoint.status
    switch (endpoint.operation) {
      case 'list': {
        imports.add('App\\Support\\ListQuery')
        if (endpoint.pagination)
          body.push(
            "$page = $this->integerQuery($request, 'page', 1, 1);",
            `$size = $this->integerQuery($request, 'size', ${PAGE_SIZE.default}, 1, ${PAGE_SIZE.max});`,
          )
        body.push('$filters = [];')
        for (const wire of endpoint.filters) {
          const field = resource.fields.find((item) => item.wire === wire)!
          body.push(
            `if ($request->query->has(${phpString(wire)})) {`,
            `    $filters[${phpString(wire)}] = ${filterRead(context, field)};`,
            '}',
          )
        }
        const sort =
          endpoint.sort.length > 0
            ? `$this->choiceQuery($request, 'sort', [${endpoint.sort.flatMap((wire) => [phpString(wire), phpString(`-${wire}`)]).join(', ')}])`
            : 'null'
        if (endpoint.pagination) {
          body.push(
            `$result = $this->service->${fn}(ListQuery::of($filters, ${sort}, ($page - 1) * $size, $size));`,
            '',
            `return $this->answer(['items' => ${name.presenter}::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], ${status});`,
          )
        } else {
          body.push(
            `$result = $this->service->${fn}(ListQuery::of($filters, ${sort}));`,
            '',
            `return $this->answer(${name.presenter}::many($result->items), ${status});`,
          )
        }
        break
      }
      case 'get':
        body.push('', `return $this->answer(${name.presenter}::one($this->service->${fn}($key)), ${status});`)
        break
      case 'create':
        body.push('', `return $this->answer(${name.presenter}::one($this->service->${fn}($values)), ${status});`)
        break
      case 'replace':
      case 'update':
        body.push('', `return $this->answer(${name.presenter}::one($this->service->${fn}($key, $values)), ${status});`)
        break
      case 'delete':
        body.push(`$this->service->${fn}($key);`, '', `return $this->empty(${status});`)
        break
      case 'custom': {
        const call = `$this->service->${fn}(${[hasKey ? '$key' : null, endpoint.input !== 'none' ? '$values' : null].filter(Boolean).join(', ')})`
        if (endpoint.output === 'none' || status === 204) body.push(`${call};`, '', `return $this->empty(${status});`)
        else if (endpoint.output === 'list') body.push('', `return $this->answer(${name.presenter}::many(${call}), ${status});`)
        else body.push('', `return $this->answer(${name.presenter}::one(${call}), ${status});`)
        break
      }
    }
    const protection = guard(context, endpoint, imports)
    return lines(
      `    /** ${endpoint.summary}. */`,
      `    #[Route(${phpString(endpoint.path)}, name: ${phpString(fn)}, methods: [${phpString(endpoint.method)}])]`,
      protection,
      `    public function ${fn}(Request $request): Response`,
      '    {',
      body.map((line) => (line === '' ? '' : `        ${line}`)),
      '    }',
    )
  })
  const constructor = usesBody
    ? [
        '    public function __construct(',
        `        private readonly ${name.service} $service,`,
        '        private readonly JsonBody $body,',
        '    ) {',
        '    }',
      ]
    : [`    public function __construct(private readonly ${name.service} $service)`, '    {', '    }']
  const content = lines(
    ...phpHeader(namespace, imports),
    phpDoc(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`),
    '#[AsController]',
    `final class ${name.controller} extends ApiController`,
    '{',
    constructor,
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path: classPath(namespace, name.controller), content: fileText(content) }
}
