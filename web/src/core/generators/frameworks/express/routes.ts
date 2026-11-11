/**
 * Services and routes of the Express project.
 *
 * The service of a resource holds its rules: items that must exist, keys that must not repeat, references
 * that must point to stored items, and the values the server fills (keys, timestamps). Business endpoints
 * get a method that answers 501 with a TODO where their logic goes.
 *
 * The routes only translate HTTP to service calls: parameters, bodies, status codes and protection.
 */
import type { SpecEndpoint, SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { PAGE_SIZE } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, indent, lines } from '../../common/text.ts'
import { TsImports, tsAccess, tsDoc, tsLiteral, tsName, tsProperty, tsString, tsType } from '../../languages/typescript/typescript.ts'
import { importPath, keyField, keyType, names, type ExpressContext } from './context.ts'

/** Resources a resource refers to, directly or inside its embedded objects, other than itself. */
export function referencedResources(context: ExpressContext, resource: SpecResource): SpecResource[] {
  const found = new Set<string>()
  const visit = (fields: SpecField[], seen: Set<string>) => {
    for (const field of fields) {
      if (field.reference) found.add(field.reference)
      const inner = innerObject(field.type)
      if (inner && !seen.has(inner)) {
        const object = context.spec.objects.find((item) => item.name === inner)
        if (object) visit(object.fields, new Set([...seen, inner]))
      }
    }
  }
  visit(resource.fields, new Set())
  found.delete(resource.name)
  return context.spec.resources.filter((item) => found.has(item.name))
}

function innerObject(type: SpecType): string | null {
  if (type.kind === 'object') return type.name
  if (type.kind === 'array') return innerObject(type.items)
  if (type.kind === 'map') return innerObject(type.value)
  return null
}

/** TypeScript statements that check every reference of a set of values, nested objects included. */
function referenceChecks(
  context: ExpressContext,
  resource: SpecResource,
  fields: SpecField[],
  source: string,
  label: string,
  depth: number,
): string[] {
  const checks: string[] = []
  for (const field of fields) {
    const value = tsAccess(source, field.wire)
    const where = label ? `${label}.${field.wire}` : field.wire
    if (field.reference) {
      const repository =
        field.reference === resource.name
          ? 'this.repository'
          : `this.${names(context.spec.resources.find((item) => item.name === field.reference)!).many}`
      if (field.type.kind === 'array')
        checks.push(
          `for (const key of ${value} ?? []) await this.require(${repository}, key, ${tsString(where)}, ${tsString(field.reference)})`,
        )
      else checks.push(`await this.require(${repository}, ${value}, ${tsString(where)}, ${tsString(field.reference)})`)
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3) continue
    const nested = referenceChecks(context, resource, object.fields, `item${depth}`, where, depth + 1)
    if (nested.length === 0) continue
    if (field.type.kind === 'array') checks.push(`for (const item${depth} of ${value} ?? []) {`, ...nested.map((line) => `  ${line}`), '}')
    else if (field.type.kind === 'object')
      checks.push(`if (${value}) {`, `  const item${depth} = ${value}`, ...nested.map((line) => `  ${line}`), '}')
  }
  return checks
}

function serverValues(resource: SpecResource, operation: 'create' | 'replace' | 'update'): string[] {
  const result: string[] = []
  for (const field of resource.fields) {
    if (field.access !== 'readOnly' || field.server === 'key') continue
    const property = tsProperty(field.wire)
    if (field.server === 'updated') result.push(`${property}: now,`)
    else if (field.server === 'created' && operation === 'create') result.push(`${property}: now,`)
    else if (field.server === 'default' && operation === 'create') result.push(`${property}: ${tsLiteral(field.defaultValue ?? null)},`)
    else if (field.server === 'pending' && operation === 'create')
      result.push(`// TODO: ${field.todo ?? `fill "${field.name}"`}`, `${property}: null,`)
  }
  return result
}

function usesNow(resource: SpecResource, operation: 'create' | 'replace' | 'update'): boolean {
  return resource.fields.some(
    (field) => field.access === 'readOnly' && (field.server === 'updated' || (field.server === 'created' && operation === 'create')),
  )
}

export function serviceFile(context: ExpressContext, resource: SpecResource): GeneratedFile {
  const path = context.layout.resource(resource, 'service')
  const name = names(resource)
  const key = keyType(resource)
  const keyWire = keyField(resource).wire
  const imports = new TsImports()
  const schemas = importPath(path, context.layout.resource(resource, 'schemas'))
  imports.addType(importPath(path, context.layout.resource(resource, 'repository')), name.repository)
  imports.addType(schemas, name.record)
  imports.add(importPath(path, 'src/errors.ts'), 'notFound')
  const needs = referencedResources(context, resource)
  for (const target of needs) imports.addType(importPath(path, context.layout.resource(target, 'repository')), names(target).repository)
  const checks = referenceChecks(context, resource, resource.fields, 'values', '', 0)
  const hasChecks = checks.length > 0 && resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const methods: string[] = []
  methods.push(
    lines(
      `  private async find(key: ${key}): Promise<${name.record}> {`,
      '    const item = await this.repository.get(key)',
      `    if (item === undefined) throw notFound(${tsString(resource.singular)})`,
      '    return item',
      '  }',
    ),
  )
  if (hasChecks) {
    imports.add(importPath(path, 'src/errors.ts'), 'invalid')
    methods.push(
      lines(
        '  /** A reference must point to a stored item. */',
        '  private async require(repository: { get(key: never): Promise<unknown> }, key: unknown, field: string, model: string): Promise<void> {',
        '    if (key !== undefined && key !== null && (await repository.get(key as never)) === undefined) throw invalid(field, `No ${model} has this key`)',
        '  }',
        '',
        `  private async checkReferences(values: Partial<${name.record}>): Promise<void> {`,
        checks.map((line) => `    ${line}`),
        '  }',
      ),
    )
  }
  const check = hasChecks ? '    await this.checkReferences(values)' : false
  const now = (operation: 'create' | 'replace' | 'update') => usesNow(resource, operation) && '    const now = new Date().toISOString()'
  const clientKey = resource.key.generated === null
  for (const endpoint of resource.endpoints) {
    const fn = tsName(endpoint.name)
    switch (endpoint.operation) {
      case 'list':
        imports.addType(importPath(path, 'src/listing.ts'), 'ListQuery', 'ListResult')
        methods.push(
          lines(
            `  /** ${endpoint.summary}. */`,
            `  ${fn}(query: ListQuery): Promise<ListResult<${name.record}>> {`,
            '    return this.repository.list(query)',
            '  }',
          ),
        )
        break
      case 'get':
        methods.push(
          lines(`  /** ${endpoint.summary}. */`, `  ${fn}(key: ${key}): Promise<${name.record}> {`, '    return this.find(key)', '  }'),
        )
        break
      case 'create':
        imports.addType(schemas, name.create)
        if (clientKey) imports.add(importPath(path, 'src/errors.ts'), 'conflict')
        methods.push(
          lines(
            `  /** ${endpoint.summary}. */`,
            `  async ${fn}(values: ${name.create}): Promise<${name.record}> {`,
            clientKey && [
              `    if ((await this.repository.get(${tsAccess('values', keyWire)})) !== undefined) {`,
              `      throw conflict(${tsString(`A ${resource.singular} with this key already exists`)})`,
              '    }',
            ],
            check,
            now('create'),
            serverValues(resource, 'create').length > 0
              ? [
                  '    return this.repository.add({',
                  '      ...values,',
                  serverValues(resource, 'create').map((line) => `      ${line}`),
                  '    })',
                ]
              : '    return this.repository.add(values)',
            '  }',
          ),
        )
        break
      case 'replace':
        imports.addType(schemas, name.create)
        if (clientKey) imports.add(importPath(path, 'src/errors.ts'), 'invalid')
        methods.push(
          lines(
            `  /** ${endpoint.summary}: every field the client may send takes the value of the body. */`,
            `  async ${fn}(key: ${key}, values: ${name.create}): Promise<${name.record}> {`,
            '    await this.find(key)',
            clientKey && [`    if (${tsAccess('values', keyWire)} !== key) throw invalid(${tsString(keyWire)}, 'The key cannot change')`],
            check,
            now('replace'),
            serverValues(resource, 'replace').length > 0
              ? [
                  '    return this.repository.update(key, {',
                  '      ...values,',
                  serverValues(resource, 'replace').map((line) => `      ${line}`),
                  '    })',
                ]
              : '    return this.repository.update(key, values)',
            '  }',
          ),
        )
        break
      case 'update': {
        imports.addType(schemas, name.update)
        const changesKey = clientKey && keyField(resource).access !== 'readOnly'
        if (changesKey) imports.add(importPath(path, 'src/errors.ts'), 'invalid')
        methods.push(
          lines(
            `  /** ${endpoint.summary}: only the fields in the body change. */`,
            `  async ${fn}(key: ${key}, values: ${name.update}): Promise<${name.record}> {`,
            '    await this.find(key)',
            changesKey && [
              `    if (${tsAccess('values', keyWire)} !== undefined && ${tsAccess('values', keyWire)} !== key) throw invalid(${tsString(keyWire)}, 'The key cannot change')`,
            ],
            check,
            now('update'),
            serverValues(resource, 'update').length > 0
              ? [
                  '    return this.repository.update(key, {',
                  `      ...(values as Partial<${name.record}>),`,
                  serverValues(resource, 'update').map((line) => `      ${line}`),
                  '    })',
                ]
              : `    return this.repository.update(key, values as Partial<${name.record}>)`,
            '  }',
          ),
        )
        break
      }
      case 'delete':
        methods.push(
          lines(
            `  /** ${endpoint.summary}. */`,
            `  async ${fn}(key: ${key}): Promise<void> {`,
            '    await this.find(key)',
            '    await this.repository.delete(key)',
            '  }',
          ),
        )
        break
      case 'custom': {
        imports.add(importPath(path, 'src/errors.ts'), 'NotImplementedError')
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const params = [
          hasKey ? `key: ${key}` : null,
          endpoint.input === 'resource' ? `_values: ${name.create}` : endpoint.input === 'partial' ? `_values: ${name.update}` : null,
        ].filter(Boolean)
        if (endpoint.input === 'resource') imports.addType(schemas, name.create)
        if (endpoint.input === 'partial') imports.addType(schemas, name.update)
        const returns = endpoint.output === 'none' ? 'void' : endpoint.output === 'list' ? `${name.record}[]` : name.record
        methods.push(
          lines(
            `  /** ${endpoint.summary}. */`,
            `  async ${fn}(${params.join(', ')}): Promise<${returns}> {`,
            hasKey && '    await this.find(key)',
            `    // TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            `    throw new NotImplementedError(${tsString(`${endpoint.summary} is not written yet`)})`,
            '  }',
          ),
        )
        break
      }
    }
  }
  const constructorParams = [
    `private readonly repository: ${name.repository}`,
    ...needs.map((target) => `private readonly ${names(target).many}: ${names(target).repository}`),
  ]
  const content = lines(
    tsDoc(`Rules of ${resource.plural}: what each operation checks and changes.`),
    '',
    imports.render(),
    '',
    `export class ${name.service} {`,
    `  constructor(${constructorParams.join(', ')}) {}`,
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path, content: fileText(content) }
}

/** The Zod schema a query value is read with: query strings are text, so numbers and booleans are converted. */
function querySchema(type: SpecType, context: ExpressContext, imports: TsImports, path: string): string {
  if (type.kind === 'enum') {
    imports.add(importPath(path, context.layout.shared()), tsType(type.name))
    return tsType(type.name)
  }
  if (type.kind !== 'scalar') return 'z.string()'
  if (type.scalar === 'integer') return 'z.coerce.number().int()'
  if (type.scalar === 'float' || type.scalar === 'decimal') return 'z.coerce.number()'
  if (type.scalar === 'boolean') return "z.enum(['true', 'false']).transform((value) => value === 'true')"
  if (type.scalar === 'uuid') return 'z.uuid()'
  return 'z.string()'
}

/** The parameter that identifies one item, read with its type. */
function keySchema(resource: SpecResource): string {
  if (resource.key.type.scalar === 'integer') return 'z.coerce.number().int()'
  if (resource.key.type.scalar === 'uuid') return 'z.uuid()'
  return 'z.string()'
}

function guard(context: ExpressContext, endpoint: SpecEndpoint, imports: TsImports, path: string): string | null {
  if (endpoint.access === 'public' || context.settings.auth === 'none') return null
  const security = importPath(path, 'src/security.ts')
  if (context.settings.auth === 'apiKey') {
    imports.add(security, 'requireApiKey')
    return 'requireApiKey'
  }
  if (endpoint.access === 'roles') {
    imports.add(security, 'requireRoles')
    return `requireRoles(${endpoint.roles.map(tsString).join(', ')})`
  }
  imports.add(security, 'authenticate')
  return 'authenticate'
}

export function routesFile(context: ExpressContext, resource: SpecResource): GeneratedFile {
  const path = context.layout.resource(resource, 'routes')
  const name = names(resource)
  const imports = new TsImports()
  const schemas = importPath(path, context.layout.resource(resource, 'schemas'))
  imports.add('express', 'Router')
  imports.add('zod', 'z')
  imports.addType(importPath(path, context.layout.resource(resource, 'service')), name.service)
  imports.add(schemas, name.toResponse)
  const keyParam = resource.key.param
  const routes = resource.endpoints.map((endpoint) => {
    const routePath = endpoint.path.replace(/\{([^}]+)\}/g, ':$1')
    const fn = tsName(endpoint.name)
    const hasKey = endpoint.pathParams.some((param) => param.name === keyParam)
    const body: string[] = []
    if (hasKey) body.push(`const key = keyParam.parse(request.params[${tsString(keyParam)}])`)
    if (endpoint.input === 'resource') {
      imports.add(schemas, name.create)
      body.push(`const values = ${name.create}.parse(request.body)`)
    }
    if (endpoint.input === 'partial') {
      imports.add(schemas, name.update)
      body.push(`const values = ${name.update}.parse(request.body)`)
    }
    switch (endpoint.operation) {
      case 'list': {
        imports.add(importPath(path, 'src/listing.ts'), 'parseSort')
        const queryFields: string[] = []
        if (endpoint.pagination) {
          queryFields.push(
            `page: z.coerce.number().int().min(1).default(1),`,
            `size: z.coerce.number().int().min(1).max(${PAGE_SIZE.max}).default(${PAGE_SIZE.default}),`,
          )
        }
        for (const wire of endpoint.filters) {
          const field = resource.fields.find((item) => item.wire === wire)!
          queryFields.push(`${tsProperty(wire)}: ${querySchema(field.type, context, imports, path)}.optional(),`)
        }
        if (endpoint.sort.length > 0)
          queryFields.push(
            `sort: z.enum([${endpoint.sort.flatMap((wire) => [tsString(wire), tsString(`-${wire}`)]).join(', ')}]).optional(),`,
          )
        body.push(
          queryFields.length > 0
            ? `const query = z.object({\n${queryFields.map((line) => `  ${line}`).join('\n')}\n}).parse(request.query)`
            : 'const query = {}',
        )
        const filters = endpoint.filters.map((wire) => `${tsProperty(wire)}: ${tsAccess('query', wire)}`)
        body.push(
          filters.length > 0
            ? `const filters = Object.fromEntries(Object.entries({ ${filters.join(', ')} }).filter(([, value]) => value !== undefined))`
            : 'const filters = {}',
        )
        const sort = endpoint.sort.length > 0 ? 'parseSort(query.sort)' : 'undefined'
        if (endpoint.pagination) {
          body.push(
            `const { items, total } = await service.${fn}({ filters, sort: ${sort}, offset: (query.page - 1) * query.size, limit: query.size })`,
            `response.status(${endpoint.status}).json({ items: items.map(${name.toResponse}), total, page: query.page, size: query.size })`,
          )
        } else {
          body.push(
            `const { items } = await service.${fn}({ filters, sort: ${sort}, offset: 0 })`,
            `response.status(${endpoint.status}).json(items.map(${name.toResponse}))`,
          )
        }
        if (filters.length === 0 && queryFields.length === 0) body.splice(body.indexOf('const query = {}'), 1)
        break
      }
      case 'get':
        body.push(`response.status(${endpoint.status}).json(${name.toResponse}(await service.${fn}(key)))`)
        break
      case 'create':
        body.push(`response.status(${endpoint.status}).json(${name.toResponse}(await service.${fn}(values)))`)
        break
      case 'replace':
      case 'update':
        body.push(`response.status(${endpoint.status}).json(${name.toResponse}(await service.${fn}(key, values)))`)
        break
      case 'delete':
        body.push(`await service.${fn}(key)`, `response.status(${endpoint.status}).end()`)
        break
      case 'custom': {
        const call = `await service.${fn}(${[hasKey ? 'key' : null, endpoint.input !== 'none' ? 'values' : null].filter(Boolean).join(', ')})`
        if (endpoint.output === 'none' || endpoint.status === 204) body.push(call, `response.status(${endpoint.status}).end()`)
        else if (endpoint.output === 'list') body.push(`response.status(${endpoint.status}).json((${call}).map(${name.toResponse}))`)
        else body.push(`response.status(${endpoint.status}).json(${name.toResponse}(${call}))`)
        break
      }
    }
    const protection = guard(context, endpoint, imports, path)
    const handlerArgs = [tsString(routePath), protection, `async (request, response) => {\n${indent(body.join('\n'), 2)}\n}`].filter(
      Boolean,
    )
    return lines(`// ${endpoint.summary}`, `router.${endpoint.method.toLowerCase()}(${handlerArgs.join(', ')})`)
  })
  const usesKey = resource.endpoints.some((endpoint) => endpoint.pathParams.some((param) => param.name === keyParam))
  const content = lines(
    tsDoc(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`),
    '',
    imports.render(),
    '',
    usesKey && [
      `/** The key in a path, read with its type: a malformed key is a 400, not a missing item. */`,
      `const keyParam = ${keySchema(resource)}`,
      '',
    ],
    `export function ${name.routes}(service: ${name.service}): Router {`,
    '  const router = Router()',
    '',
    indent(routes.join('\n\n'), 2),
    '',
    '  return router',
    '}',
  )
  return { path, content: fileText(content) }
}
