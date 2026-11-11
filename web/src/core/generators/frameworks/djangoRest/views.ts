/**
 * Services, views and URLs of the Django REST Framework project.
 *
 * The service of a resource holds its rules: items that must exist, keys that must not repeat, references
 * inside lists and embedded objects that must point to stored items. Business endpoints get a method that
 * answers 501 with a TODO where their logic goes.
 *
 * Views translate HTTP to service calls: one APIView per path, with the protection of each method.
 */
import type { SpecEndpoint, SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { PAGE_SIZE } from '../../../openapi/build.ts'
import { fileText, lines } from '../../common/text.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { pyClass, pyName, pyString, type PyImports } from '../../languages/python/python.ts'
import { attr, isForeignKey, keyField, moduleOf, names, type DjangoContext, type Modules } from './context.ts'

type ModuleRef = { imports: PyImports; blocks: string[] }

function innerObject(type: SpecType): string | null {
  if (type.kind === 'object') return type.name
  if (type.kind === 'array') return innerObject(type.items)
  if (type.kind === 'map') return innerObject(type.value)
  return null
}

/** Checks of references Django does not check itself: lists of keys and keys inside embedded objects. */
function referenceChecks(
  context: DjangoContext,
  fields: SpecField[],
  source: string,
  label: string,
  depth: number,
  nested: boolean,
  module: ModuleRef,
): string[] {
  const checks: string[] = []
  for (const field of fields) {
    const key = nested ? field.wire : attr(field)
    const value = `${source}.get(${pyString(key)})`
    const where = label ? `${label}.${field.wire}` : field.wire
    if (field.reference && (nested || !isForeignKey(field))) {
      const target = context.spec.resources.find((item) => item.name === field.reference)!
      module.imports.add(moduleOf(context, target, 'models'), names(target).model)
      const model = names(target).model
      if (field.type.kind === 'array') checks.push(`for key in ${value} or []:`, `    _require(${model}, key, ${pyString(where)})`)
      else checks.push(`_require(${model}, ${value}, ${pyString(where)})`)
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3) continue
    const inside = referenceChecks(context, object.fields, `item${depth}`, where, depth + 1, true, module)
    if (inside.length === 0) continue
    if (field.type.kind === 'array') checks.push(`for item${depth} in ${value} or []:`, ...inside.map((line) => `    ${line}`))
    else checks.push(`if ${value} is not None:`, `    item${depth} = ${value}`, ...inside.map((line) => `    ${line}`))
  }
  return checks
}

/** The ORM name of a field for filters and sorting: foreign keys by their column (`customer_id`). */
function lookup(field: SpecField): string {
  return isForeignKey(field) ? `${attr(field)}_id` : attr(field)
}

function serviceBlock(context: DjangoContext, resource: SpecResource, modules: Modules): void {
  const here = moduleOf(context, resource, 'services')
  const module = modules.get(
    here,
    context.settings.architecture === 'modular'
      ? `Rules of ${resource.plural}.`
      : 'Rules of each resource: what each operation checks and changes.',
  )
  const name = names(resource)
  module.imports.add('typing', 'Any')
  module.imports.add(moduleOf(context, resource, 'models'), name.model)
  module.imports.add('config.errors', 'NotFoundError')
  const checks = referenceChecks(context, resource.fields, 'data', '', 0, false, module)
  if (checks.length > 0) module.imports.add('config.errors', 'require as _require')
  const key = keyField(resource)
  const writable = resource.fields
    .filter((field) => field.access !== 'readOnly' && field.name !== resource.key.field)
    .map((field) => attr(field))
  const sortable = resource.fields.map((field) => `${pyString(field.wire)}: ${pyString(lookup(field))}`)
  const sortFields = `_SORT_FIELDS_${name.model.toUpperCase()}`
  const methods: string[] = [
    lines(
      '    @staticmethod',
      `    def find(key: Any) -> ${name.model}:`,
      '        try:',
      `            return ${name.model}.objects.get(pk=key)`,
      `        except (${name.model}.DoesNotExist, ValueError, TypeError) as error:`,
      `            raise NotFoundError(${pyString(resource.singular)}) from error`,
    ),
  ]
  if (checks.length > 0)
    methods.push(
      lines(
        '    @staticmethod',
        '    def check_references(data: dict[str, Any]) -> None:',
        checks.map((line) => `        ${line}`),
      ),
    )
  const checkCall = checks.length > 0 ? `        ${name.service}.check_references(data)` : false
  for (const endpoint of resource.endpoints) {
    const fn = pyName(endpoint.name)
    switch (endpoint.operation) {
      case 'list':
        methods.push(
          lines(
            '    @staticmethod',
            `    def ${fn}(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[${name.model}], int]:`,
            `        """${endpoint.summary}: \`sort\` is a JSON field name, with a leading "-" for descending order."""`,
            `        query = ${name.model}.objects.filter(**filters)`,
            '        if sort:',
            `            field = ${sortFields}[sort.lstrip("-")]`,
            '            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")',
            '        total = query.count()',
            '        items = query[offset : offset + limit] if limit is not None else query',
            '        return list(items), total',
          ),
        )
        break
      case 'get':
        methods.push(
          lines(
            '    @staticmethod',
            `    def ${fn}(key: Any) -> ${name.model}:`,
            `        """${endpoint.summary}."""`,
            `        return ${name.service}.find(key)`,
          ),
        )
        break
      case 'create':
        if (resource.key.generated === null) module.imports.add('config.errors', 'ConflictError')
        methods.push(
          lines(
            '    @staticmethod',
            `    def ${fn}(data: dict[str, Any]) -> ${name.model}:`,
            `        """${endpoint.summary}."""`,
            resource.key.generated === null && [
              `        if ${name.model}.objects.filter(pk=data[${pyString(attr(key))}]).exists():`,
              `            raise ConflictError(${pyString(`A ${resource.singular} with this key already exists`)})`,
            ],
            checkCall,
            resource.fields
              .filter((field) => field.server === 'pending')
              .map((field) => `        # TODO: ${field.todo ?? `fill "${field.name}"`}`),
            `        return ${name.model}.objects.create(**data)`,
          ),
        )
        break
      case 'replace':
        if (resource.key.generated === null) module.imports.add('config.errors', 'InvalidRequestError')
        methods.push(
          lines(
            '    @staticmethod',
            `    def ${fn}(key: Any, data: dict[str, Any]) -> ${name.model}:`,
            `        """${endpoint.summary}: every field the client may send takes the value of the body."""`,
            `        item = ${name.service}.find(key)`,
            resource.key.generated === null && [
              `        if str(data.pop(${pyString(attr(key))})) != str(item.pk):`,
              `            raise InvalidRequestError(${pyString(key.wire)}, "The key cannot change")`,
            ],
            checkCall,
            `        for field in (${writable.map(pyString).join(', ')}${writable.length === 1 ? ',' : ''}):`,
            '            setattr(item, field, data.get(field))',
            '        item.save()',
            '        return item',
          ),
        )
        break
      case 'update':
        if (resource.key.generated === null) module.imports.add('config.errors', 'InvalidRequestError')
        methods.push(
          lines(
            '    @staticmethod',
            `    def ${fn}(key: Any, data: dict[str, Any]) -> ${name.model}:`,
            `        """${endpoint.summary}: only the fields in the body change."""`,
            `        item = ${name.service}.find(key)`,
            resource.key.generated === null && [
              `        if ${pyString(attr(key))} in data and str(data.pop(${pyString(attr(key))})) != str(item.pk):`,
              `            raise InvalidRequestError(${pyString(key.wire)}, "The key cannot change")`,
            ],
            checkCall,
            '        for field, value in data.items():',
            '            setattr(item, field, value)',
            '        item.save()',
            '        return item',
          ),
        )
        break
      case 'delete':
        methods.push(
          lines(
            '    @staticmethod',
            `    def ${fn}(key: Any) -> None:`,
            `        """${endpoint.summary}."""`,
            `        ${name.service}.find(key).delete()`,
          ),
        )
        break
      case 'custom': {
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const params = [hasKey ? 'key: Any' : null, endpoint.input !== 'none' ? 'data: dict[str, Any]' : null].filter(Boolean)
        methods.push(
          lines(
            '    @staticmethod',
            `    def ${fn}(${params.join(', ')}) -> Any:`,
            `        """${endpoint.summary}."""`,
            hasKey && `        ${name.service}.find(key)`,
            `        # TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            `        raise NotImplementedError(${pyString(`${endpoint.summary} is not written yet`)})`,
          ),
        )
        break
      }
    }
  }
  if (resource.endpoints.some((endpoint) => endpoint.operation === 'list')) {
    module.blocks.push(
      `# JSON names of the fields of ${resource.plural} a list can be sorted by, and their ORM names\n${sortFields} = {${sortable.join(', ')}}`,
    )
  }
  module.blocks.push(lines(`class ${name.service}:`, `    """Rules of ${resource.plural}."""`, '', methods.join('\n\n')))
}

function permission(context: DjangoContext, endpoint: SpecEndpoint): string {
  if (context.settings.auth === 'none' || endpoint.access === 'public') return 'AllowAny()'
  if (endpoint.access === 'roles' && context.settings.auth === 'jwt') return `HasAnyRole(${endpoint.roles.map(pyString).join(', ')})`
  return 'IsAuthenticated()'
}

/** A Django URL route of a path: `/customers/{id}` → `customers/<int:id>`. */
function route(resource: SpecResource, path: string): string {
  const converter = resource.key.type.scalar === 'integer' ? 'int' : resource.key.type.scalar === 'uuid' ? 'uuid' : 'str'
  return path
    .replace(/^\//, '')
    .replace(/\{([^}]+)\}/g, (_match, param: string) => `<${param === resource.key.param ? converter : 'str'}:${pyName(param)}>`)
}

function viewBlocks(context: DjangoContext, resource: SpecResource, modules: Modules): string[] {
  const here = moduleOf(context, resource, 'views')
  const module = modules.get(
    here,
    context.settings.architecture === 'modular'
      ? `Views of ${resource.plural}: HTTP in, service calls, HTTP out.`
      : 'Views of the API: HTTP in, service calls, HTTP out.',
  )
  const name = names(resource)
  module.imports.add('rest_framework.views', 'APIView')
  module.imports.add('rest_framework.request', 'Request')
  module.imports.add('rest_framework.response', 'Response')
  module.imports.add(moduleOf(context, resource, 'serializers'), name.serializer)
  module.imports.add(moduleOf(context, resource, 'services'), name.service)
  const paths = [...new Set(resource.endpoints.map((endpoint) => endpoint.path))]
  const routes: string[] = []
  for (const path of paths) {
    const endpoints = resource.endpoints.filter((endpoint) => endpoint.path === path)
    const className = `${pyClass(endpoints[0].name)}View`
    const params = endpoints[0].pathParams.map((param) => pyName(param.name))
    const keyName = pyName(resource.key.param)
    const rules = endpoints.map((endpoint) => `        ${pyString(endpoint.method)}: [${permission(context, endpoint)}],`)
    for (const endpoint of endpoints) {
      const rule = permission(context, endpoint)
      const permissionName = rule.slice(0, rule.indexOf('('))
      module.imports.add(permissionName === 'HasAnyRole' ? 'config.security' : 'rest_framework.permissions', permissionName)
    }
    const methods = endpoints.map((endpoint) => {
      const fn = pyName(endpoint.name)
      const signature = `    def ${endpoint.method.toLowerCase()}(self, request: Request${params.map((param) => `, ${param}: str`).join('')}) -> Response:`
      const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
      const body: string[] = []
      if (endpoint.input !== 'none') {
        body.push(
          `serializer = ${name.serializer}(data=request.data${endpoint.input === 'partial' ? ', partial=True' : ''})`,
          'serializer.is_valid(raise_exception=True)',
        )
      }
      const data = endpoint.input !== 'none' ? 'dict(serializer.validated_data)' : null
      const call = (args: (string | null)[]) => `${name.service}.${fn}(${args.filter(Boolean).join(', ')})`
      switch (endpoint.operation) {
        case 'list': {
          const query = `${pyClass(endpoint.name)}Query`
          module.imports.add('rest_framework', 'serializers')
          const queryFields: string[] = []
          if (endpoint.pagination)
            queryFields.push(
              '    page = serializers.IntegerField(min_value=1, default=1)',
              `    size = serializers.IntegerField(min_value=1, max_value=${PAGE_SIZE.max}, default=${PAGE_SIZE.default})`,
            )
          const filters: string[] = []
          for (const wire of endpoint.filters) {
            const field = resource.fields.find((item) => item.wire === wire)!
            queryFields.push(`    ${pyName(wire)} = ${queryField(context, field, here, module)}`)
            filters.push(`(${pyString(lookup(field))}, query.get(${pyString(pyName(wire))}))`)
          }
          if (endpoint.sort.length > 0)
            queryFields.push(
              `    sort = serializers.ChoiceField(choices=[${endpoint.sort.flatMap((wire) => [pyString(wire), pyString(`-${wire}`)]).join(', ')}], required=False)`,
            )
          module.blocks.push(
            lines(
              `class ${query}(serializers.Serializer):`,
              `    """Query parameters of ${endpoint.summary.toLowerCase()}."""`,
              '',
              queryFields.length > 0 ? queryFields : '    pass',
            ),
          )
          body.push(
            `parameters = ${query}(data=request.query_params)`,
            'parameters.is_valid(raise_exception=True)',
            'query = parameters.validated_data',
            filters.length > 0
              ? `filters = {name: value for name, value in (${filters.join(', ')},) if value is not None}`
              : 'filters: dict[str, object] = {}',
            endpoint.pagination
              ? `items, total = ${call(['filters', endpoint.sort.length > 0 ? 'query.get("sort")' : 'None', '(query["page"] - 1) * query["size"]', 'query["size"]'])}`
              : `items, _ = ${call(['filters', endpoint.sort.length > 0 ? 'query.get("sort")' : 'None', '0', 'None'])}`,
            endpoint.pagination
              ? `return Response({"items": ${name.serializer}(items, many=True).data, "total": total, "page": query["page"], "size": query["size"]}, status=${endpoint.status})`
              : `return Response(${name.serializer}(items, many=True).data, status=${endpoint.status})`,
          )
          break
        }
        case 'get':
          body.push(`return Response(${name.serializer}(${call([keyName])}).data, status=${endpoint.status})`)
          break
        case 'create':
          body.push(`return Response(${name.serializer}(${call([data])}).data, status=${endpoint.status})`)
          break
        case 'replace':
        case 'update':
          body.push(`return Response(${name.serializer}(${call([keyName, data])}).data, status=${endpoint.status})`)
          break
        case 'delete':
          body.push(`${call([keyName])}`, `return Response(status=${endpoint.status})`)
          break
        case 'custom': {
          const result = call([hasKey ? keyName : null, data])
          if (endpoint.output === 'none' || endpoint.status === 204) body.push(result, `return Response(status=${endpoint.status})`)
          else
            body.push(
              `return Response(${name.serializer}(${result}${endpoint.output === 'list' ? ', many=True' : ''}).data, status=${endpoint.status})`,
            )
          break
        }
      }
      return lines(
        signature,
        `        """${endpoint.summary}."""`,
        body.map((line) => `        ${line}`),
      )
    })
    module.blocks.push(
      lines(
        `class ${className}(APIView):`,
        `    """${path}"""`,
        '',
        '    # Who may call each method of this path',
        '    rules = {',
        rules,
        '    }',
        '',
        '    def get_permissions(self):  # type: ignore[no-untyped-def]',
        '        return self.rules.get(self.request.method, [])',
        '',
        methods.join('\n\n'),
      ),
    )
    routes.push(`    path(${pyString(route(resource, path))}, ${className}.as_view()),`)
  }
  return routes
}

/** A query parameter of a filter, read with the field's type. */
function queryField(context: DjangoContext, field: SpecField, here: string, module: ModuleRef): string {
  if (field.type.kind === 'enum') {
    const shared = context.layout.sharedEnums()
    if (shared !== here) module.imports.add(shared, pyClass(field.type.name))
    return `serializers.ChoiceField(choices=${pyClass(field.type.name)}.choices, required=False)`
  }
  const scalar = field.reference
    ? context.spec.resources.find((item) => item.name === field.reference)!.key.type.scalar
    : field.type.kind === 'scalar'
      ? field.type.scalar
      : 'string'
  const map: Record<string, string> = {
    integer: 'IntegerField',
    float: 'FloatField',
    decimal: 'FloatField',
    boolean: 'BooleanField',
    uuid: 'UUIDField',
    date: 'DateField',
    datetime: 'DateTimeField',
  }
  return `serializers.${map[scalar] ?? 'CharField'}(required=False${scalar === 'boolean' ? ', allow_null=True, default=None' : ''})`
}

export function serviceAndViewBlocks(context: DjangoContext, modules: Modules): GeneratedFile[] {
  const routesByApp = new Map<string, string[]>()
  for (const resource of context.spec.resources) {
    serviceBlock(context, resource, modules)
    const routes = viewBlocks(context, resource, modules)
    const app = context.layout.app(resource)
    routesByApp.set(app, [...(routesByApp.get(app) ?? []), ...routes])
  }
  const files: GeneratedFile[] = []
  for (const [app, routes] of routesByApp) {
    const views = [
      ...new Set(
        context.spec.resources
          .filter((resource) => context.layout.app(resource) === app)
          .map((resource) => moduleOf(context, resource, 'views')),
      ),
    ]
    const viewNames = routes.map((line) => line.match(/, (\w+)\.as_view/)![1])
    const content = lines(
      `"""URLs of the ${app} app."""`,
      '',
      'from django.urls import path',
      '',
      `from ${views[0]} import ${[...new Set(viewNames)].sort().join(', ')}`,
      '',
      'urlpatterns = [',
      routes,
      ']',
    )
    files.push({ path: `${app}/urls.py`, content: fileText(content) })
  }
  return files
}
