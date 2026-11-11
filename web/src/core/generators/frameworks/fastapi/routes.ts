/**
 * Services and routers of the FastAPI project.
 *
 * The service of a resource holds its rules: items that must exist, keys that must not repeat, references
 * that must point to stored items, and the values the server fills (keys, timestamps). Business endpoints
 * get a method that answers 501 with a TODO where their logic goes.
 *
 * The router only translates HTTP to service calls: parameters, bodies, status codes and protection.
 */
import type { SpecEndpoint, SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { PAGE_SIZE } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, indent, lines } from '../../common/text.ts'
import { PyImports, pyClass, pyDocstring, pyLiteral, pyName, pyString, pyType } from '../../languages/python/python.ts'
import { innerObject, referencedResources } from './app.ts'
import { attr, classes, keyField, names, type FastApiContext } from './context.ts'

/** Python name of a service or route function: `listCustomers` → `list_customers`. */
export function functionName(endpoint: SpecEndpoint): string {
  return pyName(endpoint.name)
}

/** Python names of path parameters, and the route path that uses them. */
function routePath(endpoint: SpecEndpoint): { path: string; params: { wire: string; name: string; type: SpecType }[] } {
  const params = endpoint.pathParams.map((param) => ({ wire: param.name, name: pyName(param.name), type: param.type as SpecType }))
  let path = endpoint.path
  for (const param of params) path = path.replace(`{${param.wire}}`, `{${param.name}}`)
  return { path, params }
}

/** Python statements that check every reference of a set of values, nested objects included. */
function referenceChecks(
  context: FastApiContext,
  resource: SpecResource,
  fields: SpecField[],
  source: string,
  label: string,
  depth: number,
): string[] {
  const checks: string[] = []
  for (const field of fields) {
    const value = `${source}.get(${pyString(attr(field))})`
    const where = label ? `${label}.${field.wire}` : field.wire
    if (field.reference) {
      const repository =
        field.reference === resource.name
          ? 'self._repository'
          : `self._${names(context.spec.resources.find((item) => item.name === field.reference)!).many}`
      if (field.type.kind === 'array')
        checks.push(`for key in ${value} or []:`, `    self._require(${repository}, key, ${pyString(where)}, ${pyString(field.reference)})`)
      else checks.push(`self._require(${repository}, ${value}, ${pyString(where)}, ${pyString(field.reference)})`)
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3) continue
    const nested = referenceChecks(context, resource, object.fields, `item${depth}`, where, depth + 1)
    if (nested.length === 0) continue
    if (field.type.kind === 'array') checks.push(`for item${depth} in ${value} or []:`, ...nested.map((line) => `    ${line}`))
    else if (field.type.kind === 'object')
      checks.push(`if ${value} is not None:`, `    item${depth} = ${value}`, ...nested.map((line) => `    ${line}`))
  }
  return checks
}

function serverValues(resource: SpecResource, operation: 'create' | 'replace' | 'update'): string[] {
  const result: string[] = []
  for (const field of resource.fields) {
    if (field.access !== 'readOnly' || field.server === 'key') continue
    const name = pyString(attr(field))
    if (field.server === 'updated') result.push(`values[${name}] = now`)
    else if (field.server === 'created' && operation === 'create') result.push(`values[${name}] = now`)
    else if (field.server === 'default' && operation === 'create') result.push(`values[${name}] = ${pyLiteral(field.defaultValue ?? null)}`)
    else if (field.server === 'pending' && operation === 'create')
      result.push(`# TODO: ${field.todo ?? `fill "${field.name}"`}`, `values[${name}] = None`)
  }
  return result
}

function usesNow(resource: SpecResource, operation: 'create' | 'replace' | 'update'): boolean {
  return resource.fields.some(
    (field) => field.access === 'readOnly' && (field.server === 'updated' || (field.server === 'created' && operation === 'create')),
  )
}

export function serviceFile(context: FastApiContext, resource: SpecResource): GeneratedFile {
  const imports = new PyImports()
  imports.add('typing', 'Any')
  const name = classes(resource)
  const repositoryModule = context.layout.resource(resource, 'repository').module
  const schemasModule = context.layout.resource(resource, 'schemas').module
  imports.add(repositoryModule, name.repository)
  imports.add('app.errors', 'NotFoundError')
  const keyAttr = attr(keyField(resource))
  const keyPy =
    keyField(resource).type.kind === 'scalar' && resource.key.type.scalar === 'uuid'
      ? 'UUID'
      : resource.key.type.scalar === 'integer'
        ? 'int'
        : 'str'
  if (keyPy === 'UUID') imports.add('uuid', 'UUID')
  const needs = referencedResources(context, resource)
  const writes = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const hasReferences =
    resource.fields.some((field) => field.reference) ||
    needs.length > 0 ||
    referenceChecks(context, resource, resource.fields, 'values', '', 0).length > 0
  const ctor = [
    `    def __init__(self, repository: ${name.repository}${needs.map((target) => `, ${names(target).many}: ${classes(target).repository}`).join('')}) -> None:`,
    '        self._repository = repository',
  ]
  for (const target of needs) {
    imports.add(context.layout.resource(target, 'repository').module, classes(target).repository)
    ctor.push(`        self._${names(target).many} = ${names(target).many}`)
  }
  const methods: string[] = []
  methods.push(
    lines(
      `    def _find(self, key: ${keyPy}) -> dict[str, Any]:`,
      '        item = self._repository.get(key)',
      '        if item is None:',
      `            raise NotFoundError(${pyString(resource.singular)})`,
      '        return item',
    ),
  )
  if (hasReferences && writes) {
    imports.add('app.errors', 'InvalidRequestError')
    methods.push(
      lines(
        '    @staticmethod',
        '    def _require(repository: Any, key: Any, field: str, model: str) -> None:',
        '        """A reference must point to a stored item."""',
        '        if key is not None and repository.get(key) is None:',
        '            raise InvalidRequestError(field, f"No {model} has this key")',
      ),
    )
    const checks = referenceChecks(context, resource, resource.fields, 'values', '', 0)
    methods.push(
      lines(
        '    def _check_references(self, values: dict[str, Any]) -> None:',
        checks.length > 0 ? checks.map((line) => `        ${line}`) : '        pass',
      ),
    )
  }
  const check = hasReferences && writes ? '        self._check_references(values)' : false
  const nowLine = (operation: 'create' | 'replace' | 'update') => {
    if (!usesNow(resource, operation)) return false
    imports.add('datetime', 'UTC', 'datetime')
    return '        now = datetime.now(UTC)'
  }
  for (const endpoint of resource.endpoints) {
    const fn = functionName(endpoint)
    const keyArg = endpoint.pathParams.some((param) => param.name === resource.key.param) ? `key: ${keyPy}` : null
    switch (endpoint.operation) {
      case 'list':
        methods.push(
          lines(
            `    def ${fn}(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:`,
            `        """${endpoint.summary}: \`sort\` is a JSON field name, with a leading "-" for descending order."""`,
            '        order = None',
            '        if sort:',
            '            descending = sort.startswith("-")',
            '            order = (_SORT_FIELDS[sort.lstrip("-")], descending)',
            '        return self._repository.list(filters, order, offset, limit)',
          ),
        )
        break
      case 'get':
        methods.push(
          lines(
            `    def ${fn}(self, key: ${keyPy}) -> dict[str, Any]:`,
            `        """${endpoint.summary}."""`,
            '        return self._find(key)',
          ),
        )
        break
      case 'create': {
        imports.add(schemasModule, name.create)
        const clientKey = resource.key.generated === null
        if (clientKey) imports.add('app.errors', 'ConflictError')
        methods.push(
          lines(
            `    def ${fn}(self, data: ${name.create}) -> dict[str, Any]:`,
            `        """${endpoint.summary}."""`,
            '        values = data.model_dump()',
            clientKey && [
              `        if self._repository.get(values[${pyString(keyAttr)}]) is not None:`,
              `            raise ConflictError(${pyString(`A ${resource.singular} with this key already exists`)})`,
            ],
            check,
            nowLine('create'),
            serverValues(resource, 'create').map((line) => `        ${line}`),
            '        return self._repository.add(values)',
          ),
        )
        break
      }
      case 'replace': {
        imports.add(schemasModule, name.create)
        const clientKey = resource.key.generated === null
        if (clientKey) imports.add('app.errors', 'InvalidRequestError')
        methods.push(
          lines(
            `    def ${fn}(self, key: ${keyPy}, data: ${name.create}) -> dict[str, Any]:`,
            `        """${endpoint.summary}: every field the client may send takes the value of the body."""`,
            '        self._find(key)',
            '        values = data.model_dump()',
            clientKey && [
              `        if values[${pyString(keyAttr)}] != key:`,
              `            raise InvalidRequestError(${pyString(keyField(resource).wire)}, "The key cannot change")`,
            ],
            check,
            nowLine('replace'),
            serverValues(resource, 'replace').map((line) => `        ${line}`),
            '        return self._repository.update(key, values)',
          ),
        )
        break
      }
      case 'update': {
        imports.add(schemasModule, name.update)
        const clientKey = resource.key.generated === null && keyField(resource).access !== 'readOnly'
        if (clientKey) imports.add('app.errors', 'InvalidRequestError')
        methods.push(
          lines(
            `    def ${fn}(self, key: ${keyPy}, data: ${name.update}) -> dict[str, Any]:`,
            `        """${endpoint.summary}: only the fields in the body change."""`,
            '        self._find(key)',
            '        values = data.model_dump(exclude_unset=True)',
            clientKey && [
              `        if ${pyString(keyAttr)} in values and values[${pyString(keyAttr)}] != key:`,
              `            raise InvalidRequestError(${pyString(keyField(resource).wire)}, "The key cannot change")`,
            ],
            check,
            nowLine('update'),
            serverValues(resource, 'update').map((line) => `        ${line}`),
            '        return self._repository.update(key, values)',
          ),
        )
        break
      }
      case 'delete':
        methods.push(
          lines(
            `    def ${fn}(self, key: ${keyPy}) -> None:`,
            `        """${endpoint.summary}."""`,
            '        self._find(key)',
            '        self._repository.delete(key)',
          ),
        )
        break
      case 'custom': {
        const params = [
          keyArg,
          endpoint.input === 'resource' ? `data: ${name.create}` : endpoint.input === 'partial' ? `data: ${name.update}` : null,
        ].filter(Boolean)
        if (endpoint.input === 'resource') imports.add(schemasModule, name.create)
        if (endpoint.input === 'partial') imports.add(schemasModule, name.update)
        const returns = endpoint.output === 'none' ? 'None' : endpoint.output === 'list' ? 'list[dict[str, Any]]' : 'dict[str, Any]'
        methods.push(
          lines(
            `    def ${fn}(self${params.map((param) => `, ${param}`).join('')}) -> ${returns}:`,
            `        """${endpoint.summary}."""`,
            keyArg && '        item = self._find(key)',
            `        # TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            keyArg ? '        # `item` holds the stored values; return the result the endpoint describes.' : false,
            `        raise NotImplementedError(${pyString(`${endpoint.summary} is not written yet`)})`,
          ),
        )
        break
      }
    }
  }
  const list = resource.endpoints.find((endpoint) => endpoint.operation === 'list' && endpoint.sort.length > 0)
  const sortMap = list
    ? `# JSON names of the fields a list can be sorted by, and their Python names\n_SORT_FIELDS = {${list.sort
        .map((wire) => `${pyString(wire)}: ${pyString(attr(resource.fields.find((field) => field.wire === wire)!))}`)
        .join(', ')}}`
    : resource.endpoints.some((endpoint) => endpoint.operation === 'list')
      ? '_SORT_FIELDS: dict[str, str] = {}'
      : null
  const body = lines(`class ${name.service}:`, `    """Rules of ${resource.plural}."""`, '', ctor, '', methods.join('\n\n'))
  const content = lines(
    pyDocstring(`Rules of ${resource.plural}: what each operation checks and changes.`),
    '',
    imports.render(),
    '',
    sortMap ? ['', sortMap] : false,
    '',
    '',
    body,
  )
  return { path: context.layout.resource(resource, 'service').file, content: fileText(content) }
}

/** `Literal["name", "-name"]` for the sort parameter. */
function sortLiteral(endpoint: SpecEndpoint, imports: PyImports): string {
  imports.add('typing', 'Literal')
  return `Literal[${endpoint.sort.flatMap((wire) => [pyString(wire), pyString(`-${wire}`)]).join(', ')}]`
}

function protection(context: FastApiContext, endpoint: SpecEndpoint, imports: PyImports): string | null {
  if (endpoint.access === 'public' || context.settings.auth === 'none') return null
  imports.add('fastapi', 'Depends')
  if (context.settings.auth === 'apiKey') {
    imports.add('app.security', 'require_api_key')
    return 'Depends(require_api_key)'
  }
  if (endpoint.access === 'roles') {
    imports.add('app.security', 'require_roles')
    return `Depends(require_roles(${endpoint.roles.map(pyString).join(', ')}))`
  }
  imports.add('app.security', 'current_principal')
  return 'Depends(current_principal)'
}

export function routerFile(context: FastApiContext, resource: SpecResource): GeneratedFile {
  const imports = new PyImports()
  imports.add('fastapi', 'APIRouter', 'Depends')
  const name = classes(resource)
  const variable = names(resource)
  const schemasModule = context.layout.resource(resource, 'schemas').module
  imports.add(context.layout.resource(resource, 'service').module, name.service)
  imports.add('app.dependencies', `get_${variable.one}_service`)
  imports.add(schemasModule, name.read)
  const sharedNames = {
    object: (object: string) => {
      imports.add(context.layout.shared().module, pyClass(object))
      return pyClass(object)
    },
    enum: (item: string) => {
      imports.add(context.layout.shared().module, pyClass(item))
      return pyClass(item)
    },
  }
  const routes = resource.endpoints.map((endpoint) => {
    const { path, params } = routePath(endpoint)
    const args: string[] = []
    for (const param of params) {
      const type = param.name === pyName(resource.key.param) ? pyType(resource.key.type, imports, sharedNames) : 'str'
      if (param.wire !== param.name) {
        imports.add('fastapi', 'Path')
        args.push(`${param.name}: ${type} = Path(alias=${pyString(param.wire)})`)
      } else args.push(`${param.name}: ${type}`)
    }
    const keyParam = params.find((param) => param.wire === resource.key.param)
    if (endpoint.input === 'resource') {
      imports.add(schemasModule, name.create)
      args.push(`data: ${name.create}`)
    }
    if (endpoint.input === 'partial') {
      imports.add(schemasModule, name.update)
      args.push(`data: ${name.update}`)
    }
    const filters: string[] = []
    if (endpoint.operation === 'list') {
      imports.add('fastapi', 'Query')
      if (endpoint.pagination) args.push('page: int = Query(1, ge=1)', `size: int = Query(${PAGE_SIZE.default}, ge=1, le=${PAGE_SIZE.max})`)
      for (const wire of endpoint.filters) {
        const field = resource.fields.find((item) => item.wire === wire)!
        const type = pyType(field.type, imports, sharedNames)
        const param = `filter_${attr(field)}`
        args.push(`${param}: ${type} | None = Query(None, alias=${pyString(wire)})`)
        filters.push(`(${pyString(attr(field))}, ${param})`)
      }
      if (endpoint.sort.length > 0) args.push(`sort: ${sortLiteral(endpoint, imports)} | None = None`)
    }
    args.push(`service: ${name.service} = Depends(get_${variable.one}_service)`)
    const guard = protection(context, endpoint, imports)
    const decoratorArgs = [
      pyString(path),
      endpoint.output !== 'none' && endpoint.status !== 204
        ? `response_model=${endpoint.output === 'list' ? (endpoint.pagination ? `${name.read}Page` : `list[${name.read}]`) : name.read}`
        : null,
      `status_code=${endpoint.status}`,
      `summary=${pyString(endpoint.summary)}`,
      `operation_id=${pyString(endpoint.name)}`,
      guard ? `dependencies=[${guard}]` : null,
    ].filter(Boolean)
    const fn = functionName(endpoint)
    const key = keyParam ? keyParam.name : null
    let body: string[]
    let returns: string
    switch (endpoint.operation) {
      case 'list':
        returns = endpoint.pagination ? `${name.read}Page` : `list[${name.read}]`
        if (endpoint.pagination) imports.add(schemasModule, `${name.read}Page`)
        body = [
          filters.length > 0
            ? `filters = {name: value for name, value in (${filters.join(', ')},) if value is not None}`
            : 'filters: dict[str, object] = {}',
          endpoint.pagination
            ? `items, total = service.${fn}(filters, ${endpoint.sort.length > 0 ? 'sort' : 'None'}, (page - 1) * size, size)`
            : `items, _ = service.${fn}(filters, ${endpoint.sort.length > 0 ? 'sort' : 'None'}, 0, None)`,
          endpoint.pagination
            ? `return ${name.read}Page(items=[${name.read}.model_validate(item) for item in items], total=total, page=page, size=size)`
            : `return [${name.read}.model_validate(item) for item in items]`,
        ]
        break
      case 'get':
        returns = name.read
        body = [`return ${name.read}.model_validate(service.${fn}(${key}))`]
        break
      case 'create':
        returns = name.read
        body = [`return ${name.read}.model_validate(service.${fn}(data))`]
        break
      case 'replace':
      case 'update':
        returns = name.read
        body = [`return ${name.read}.model_validate(service.${fn}(${key}, data))`]
        break
      case 'delete':
        imports.add('fastapi', 'Response')
        returns = 'Response'
        body = [`service.${fn}(${key})`, `return Response(status_code=${endpoint.status})`]
        break
      case 'custom': {
        const call = `service.${fn}(${[key, endpoint.input !== 'none' ? 'data' : null].filter(Boolean).join(', ')})`
        if (endpoint.output === 'none' || endpoint.status === 204) {
          imports.add('fastapi', 'Response')
          returns = 'Response'
          body = [call, `return Response(status_code=${endpoint.status})`]
        } else if (endpoint.output === 'list') {
          returns = `list[${name.read}]`
          body = [`return [${name.read}.model_validate(item) for item in ${call}]`]
        } else {
          returns = name.read
          body = [`return ${name.read}.model_validate(${call})`]
        }
        break
      }
    }
    if (endpoint.operation === 'delete' || (endpoint.operation === 'custom' && returns === 'Response'))
      decoratorArgs.push('response_class=Response')
    return lines(
      `@router.${endpoint.method.toLowerCase()}(`,
      decoratorArgs.map((arg) => `    ${arg},`),
      ')',
      `def ${fn}(`,
      args.map((arg) => `    ${arg},`),
      `) -> ${returns}:`,
      `    ${pyDocstring(endpoint.summary + '.')}`,
      indent(body.join('\n'), 4),
    )
  })
  const content = lines(
    pyDocstring(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`),
    '',
    imports.render(),
    '',
    `router = APIRouter(tags=[${pyString(resource.plural)}])`,
    '',
    '',
    routes.join('\n\n\n'),
  )
  return { path: context.layout.resource(resource, 'router').file, content: fileText(content) }
}

/** The page schema of a paginated list, appended to the resource's schemas module. */
export function pageClass(resource: SpecResource): string | null {
  if (!resource.endpoints.some((endpoint) => endpoint.pagination)) return null
  const name = classes(resource)
  return lines(
    `class ${name.read}Page(BaseModel):`,
    `    """One page of ${resource.plural}."""`,
    '',
    `    items: list[${name.read}]`,
    '    total: int',
    '    page: int',
    '    size: int',
  )
}
