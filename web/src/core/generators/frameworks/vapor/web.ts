/**
 * Services and controllers of the Vapor project.
 *
 * The service of a resource holds its rules: items that must exist, keys that must not repeat, references that
 * must point to stored items, and the values the server fills. Business endpoints get a method that answers 501
 * where their logic goes. Presence, null and the declared validations are checked on the request body itself
 * (Common/Body.swift).
 *
 * The controllers only translate HTTP to service calls: parameters, bodies, status codes and protection.
 */
import type { SpecEndpoint, SpecField, SpecResource } from '../../../api/spec.ts'
import { PAGE_SIZE, shapeFields } from '../../../openapi/build.ts'
import { innerObject, referencedResources } from '../../common/references.ts'
import type { JsonValue } from '../../common/samples.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { swDoc, swHeader, swName, swString, swType, swTypeOf } from '../../languages/swift/swift.ts'
import { keyField, keyType, names, property, sourcePath, typeNames, type VaporContext } from './context.ts'
import { enumCases } from './model.ts'
import { filterFields } from './persistence.ts'

/** The method of a service, and the handler, of an endpoint: `listCustomers`. */
export function endpointFunction(endpoint: SpecEndpoint): string {
  return swName(endpoint.name)
}

/** A default value written in Swift for the field's type. */
function swDefault(context: VaporContext, field: SpecField): string {
  const value = field.defaultValue
  if (value === null || value === undefined) return 'nil'
  const type = field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    return `${swType(type.name)}.${enumCases(item.values)[item.values.indexOf(value as string | number)]}`
  }
  if (type.kind === 'scalar') {
    switch (type.scalar) {
      case 'integer':
        return String(value)
      case 'float':
        return Number.isInteger(value) ? `${value}.0` : String(value)
      case 'decimal':
        return `Decimal(string: ${swString(String(value))})`
      case 'boolean':
        return String(value)
      case 'datetime':
        return `parseDateTime(${swString(String(value))})`
      case 'uuid':
        return `UUID(uuidString: ${swString(String(value))})`
      case 'any':
        break
      default:
        return swString(String(value))
    }
  }
  // Lists, maps, objects and values of any shape: written in JSON
  return `jsonValue(${swString(JSON.stringify(value as JsonValue))}, as: ${swTypeOf(type, typeNames)}.self)`
}

/** The value the server gives a read-only field, or null when it gives none in this operation. */
function serverValue(context: VaporContext, field: SpecField, operation: 'create' | 'replace' | 'update'): string | null {
  if (field.access !== 'readOnly' || field.server === 'key') return null
  const now = () => {
    if (field.type.kind === 'scalar' && field.type.scalar === 'date') return 'ServerClock.today()'
    if (field.type.kind === 'scalar' && field.type.scalar === 'datetime') return 'ServerClock.now()'
    return 'ServerClock.text()'
  }
  if (field.server === 'updated') return now()
  if (operation !== 'create') return null
  if (field.server === 'created') return now()
  if (field.server === 'default') return swDefault(context, field)
  return null
}

/** Swift statements that check every reference of an item, nested objects included. */
function referenceChecks(
  context: VaporContext,
  resource: SpecResource,
  fields: SpecField[],
  source: string,
  label: string,
  depth: number,
  counter: { next: number },
): string[] {
  const checks: string[] = []
  for (const field of fields) {
    const value = `${source}.${property(field)}`
    const where = label ? `${label}.${field.wire}` : field.wire
    if (field.reference) {
      const target = context.spec.resources.find((item) => item.name === field.reference)!
      const repository = field.reference === resource.name ? 'repository' : `${names(target).one}Repository`
      const variable = `reference${counter.next++}`
      const failure = `throw ApiError.invalid(${swString(where)}, ${swString(`No ${field.reference} has this key`)})`
      if (field.type.kind === 'array')
        checks.push(
          `for ${variable} in ${value} ?? [] {`,
          `    if try await ${repository}.get(${variable}) == nil {`,
          `        ${failure}`,
          '    }',
          '}',
        )
      else checks.push(`if let ${variable} = ${value}, try await ${repository}.get(${variable}) == nil {`, `    ${failure}`, '}')
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3 || field.type.kind === 'map') continue
    const variable = `item${depth}`
    const nested = referenceChecks(context, resource, object.fields, variable, where, depth + 1, counter)
    if (nested.length === 0) continue
    if (field.type.kind === 'array') checks.push(`for ${variable} in ${value} ?? [] {`, ...nested.map((line) => `    ${line}`), '}')
    else if (field.type.kind === 'object') checks.push(`if let ${variable} = ${value} {`, ...nested.map((line) => `    ${line}`), '}')
  }
  return checks
}

export function serviceFile(context: VaporContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const key = keyType(resource)
  const keyName = property(keyField(resource))
  const keyWire = keyField(resource).wire
  const needs = referencedResources(context, resource)
  const checks = referenceChecks(context, resource, resource.fields, 'item', '', 0, { next: 0 })
  const clientKey = resource.key.generated === null
  const operations = new Set(resource.endpoints.map((endpoint) => endpoint.operation))
  const customWithKey = resource.endpoints.some(
    (endpoint) => endpoint.operation === 'custom' && endpoint.pathParams.some((param) => param.name === resource.key.param),
  )
  const usesFind =
    ['get', 'replace', 'update', 'delete'].some((operation) => operations.has(operation as SpecEndpoint['operation'])) || customWithKey
  const usesApply = operations.has('create') || operations.has('replace')
  const usesChanges = operations.has('update')
  const usesChecks = checks.length > 0 && (usesApply || usesChanges)
  const methods: string[] = []
  if (usesFind)
    methods.push(
      lines(
        `    private func find(_ key: ${key}) async throws -> ${name.type} {`,
        '        guard let item = try await repository.get(key) else {',
        `            throw ApiError.notFound(${swString(resource.singular)})`,
        '        }',
        '        return item',
        '    }',
      ),
    )
  if (usesChecks)
    methods.push(
      lines(
        '    /// Every reference must point to a stored item.',
        `    private func checkReferences(_ item: ${name.type}) async throws {`,
        checks.map((line) => `        ${line}`),
        '    }',
      ),
    )
  if (usesApply)
    methods.push(
      lines(
        '    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.',
        `    private static func apply(_ item: inout ${name.type}, _ body: Body<${name.create}>) {`,
        '        let data = body.value',
        shapeFields(resource.fields, 'create')
          .filter((field) => field.name !== resource.key.field || clientKey)
          .map((field) => {
            const prop = property(field)
            if (field.name === resource.key.field)
              return `        item.${prop} = data.${prop} ?? ${key === 'UUID' ? 'UUID()' : key === 'Int64' ? '0' : '""'}`
            if (field.defaultValue !== undefined)
              return `        item.${prop} = body.has(${swString(field.wire)}) ? data.${prop} : ${swDefault(context, field)}`
            return `        item.${prop} = data.${prop}`
          }),
        '    }',
      ),
    )
  if (usesChanges)
    methods.push(
      lines(
        '    /// Sets the fields a partial change carries; the others stay as they are.',
        `    private static func applyChanges(_ item: inout ${name.type}, _ body: Body<${name.update}>) {`,
        '        let data = body.value',
        shapeFields(resource.fields, 'update')
          .filter((field) => field.name !== resource.key.field)
          .map((field) => [
            `        if body.has(${swString(field.wire)}) {`,
            `            item.${property(field)} = data.${property(field)}`,
            '        }',
          ]),
        '    }',
      ),
    )
  const server = (operation: 'create' | 'replace' | 'update') =>
    resource.fields.flatMap((field) => {
      const value = serverValue(context, field, operation)
      if (value !== null) return [`        item.${property(field)} = ${value}`]
      if (operation === 'create' && field.access === 'readOnly' && field.server === 'pending')
        return [`        // TODO: ${field.todo ?? `fill "${field.name}"`}`]
      return []
    })
  const check = usesChecks && '        try await checkReferences(item)'
  for (const endpoint of resource.endpoints) {
    const fn = endpointFunction(endpoint)
    const doc = `    /// ${endpoint.summary}.`
    switch (endpoint.operation) {
      case 'list':
        methods.push(
          lines(
            doc,
            `    func ${fn}(_ query: ListQuery<${name.filters}>) async throws -> ListResult<${name.type}> {`,
            '        try await repository.list(query)',
            '    }',
          ),
        )
        break
      case 'get':
        methods.push(lines(doc, `    func ${fn}(_ key: ${key}) async throws -> ${name.type} {`, '        try await find(key)', '    }'))
        break
      case 'create':
        methods.push(
          lines(
            doc,
            `    func ${fn}(_ body: Body<${name.create}>) async throws -> ${name.type} {`,
            `        var item = ${name.type}()`,
            '        Self.apply(&item, body)',
            clientKey && [
              `        if try await repository.get(item.${keyName}) != nil {`,
              `            throw ApiError.conflict(${swString(`A ${resource.singular} with this key already exists`)})`,
              '        }',
            ],
            check,
            server('create'),
            '        return try await repository.add(item)',
            '    }',
          ),
        )
        break
      case 'replace':
        methods.push(
          lines(
            `    /// ${endpoint.summary}: every field the client may send takes the value of the body.`,
            `    func ${fn}(_ key: ${key}, _ body: Body<${name.create}>) async throws -> ${name.type} {`,
            clientKey && [
              `        if body.value.${keyName} != key {`,
              `            throw ApiError.invalid(${swString(keyWire)}, "The key cannot change")`,
              '        }',
            ],
            '        var item = try await find(key)',
            '        Self.apply(&item, body)',
            check,
            server('replace'),
            '        return try await repository.update(item)',
            '    }',
          ),
        )
        break
      case 'update': {
        const changesKey = clientKey && keyField(resource).access !== 'readOnly'
        methods.push(
          lines(
            `    /// ${endpoint.summary}: only the fields in the body change.`,
            `    func ${fn}(_ key: ${key}, _ body: Body<${name.update}>) async throws -> ${name.type} {`,
            changesKey && [
              `        if body.has(${swString(keyWire)}) && body.value.${keyName} != key {`,
              `            throw ApiError.invalid(${swString(keyWire)}, "The key cannot change")`,
              '        }',
            ],
            '        var item = try await find(key)',
            '        Self.applyChanges(&item, body)',
            check,
            server('update'),
            '        return try await repository.update(item)',
            '    }',
          ),
        )
        break
      }
      case 'delete':
        methods.push(
          lines(
            doc,
            `    func ${fn}(_ key: ${key}) async throws {`,
            '        _ = try await find(key)',
            '        try await repository.delete(key)',
            '    }',
          ),
        )
        break
      case 'custom': {
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const bodyClass = endpoint.input === 'resource' ? name.create : endpoint.input === 'partial' ? name.update : null
        const params = [hasKey ? `_ key: ${key}` : null, bodyClass ? `_ body: Body<${bodyClass}>` : null].filter(Boolean)
        const returns = endpoint.output === 'none' ? '' : endpoint.output === 'list' ? ` -> [${name.type}]` : ` -> ${name.type}`
        methods.push(
          lines(
            doc,
            `    func ${fn}(${params.join(', ')}) async throws${returns} {`,
            hasKey && '        _ = try await find(key)',
            `        // TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            `        throw ApiError.notImplemented(${swString(`${endpoint.summary} is not written yet`)})`,
            '    }',
          ),
        )
        break
      }
    }
  }
  const content = lines(
    ...swHeader(`Rules of ${resource.plural}: what each operation checks and changes.`, ['Foundation']),
    swDoc(`Rules of ${resource.plural}.`),
    `struct ${name.service}: Sendable {`,
    `    let repository: any ${name.repository}`,
    needs.map((item) => `    let ${names(item).one}Repository: any ${names(item).repository}`),
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path: sourcePath(context.layout.resource(resource, 'service'), name.service), content: fileText(content) }
}

/** The expression that reads a filter of the query string with the type of its field. */
function filterRead(context: VaporContext, field: SpecField): string {
  const wire = swString(field.wire)
  if (field.reference) {
    const key = keyType(context.spec.resources.find((item) => item.name === field.reference)!)
    if (key === 'Int64') return `try queryFilter(req, ${wire}) { Int64($0) }`
    if (key === 'UUID') return `try queryFilter(req, ${wire}, parseUUID)`
    return `try queryFilter(req, ${wire}) { $0 }`
  }
  const type = field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    const enumType = swType(type.name)
    return item.valueType === 'integer'
      ? `try queryFilter(req, ${wire}) { Int64($0).flatMap(${enumType}.init(rawValue:)) }`
      : `try queryFilter(req, ${wire}) { ${enumType}(rawValue: $0) }`
  }
  if (type.kind === 'scalar') {
    switch (type.scalar) {
      case 'integer':
        return `try queryFilter(req, ${wire}) { ${type.bits === 64 ? 'Int64' : 'Int32'}($0) }`
      case 'float':
        return `try queryFilter(req, ${wire}) { Double($0) }`
      case 'decimal':
        return `try queryFilter(req, ${wire}) { Double($0) == nil ? nil : Decimal(string: $0) }`
      case 'boolean':
        return `try queryFilter(req, ${wire}, parseBool)`
      case 'date':
        return `try queryFilter(req, ${wire}, parseDate)`
      case 'datetime':
        return `try queryFilter(req, ${wire}, parseDateTime)`
      case 'uuid':
        return `try queryFilter(req, ${wire}, parseUUID)`
    }
  }
  return `try queryFilter(req, ${wire}) { $0 }`
}

/** The path components of an endpoint for Vapor: `"customers", ":id"`. */
function pathComponents(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.map((part) => swString(part.replace(/^\{(.+)\}$/, ':$1'))).join(', ')
}

export function controllerFile(context: VaporContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const keyRead = () => {
    const fn = resource.key.type.scalar === 'integer' ? 'intKey' : resource.key.type.scalar === 'uuid' ? 'uuidKey' : 'textKey'
    return `let key = try ${fn}(req, ${swString(resource.key.param)})`
  }
  const filterStruct = filterFields(resource)
  const handlers = resource.endpoints.map((endpoint) => {
    const fn = endpointFunction(endpoint)
    const body: string[] = []
    if (context.security && endpoint.access !== 'public') {
      if (endpoint.access === 'roles' && context.settings.auth === 'jwt')
        body.push('let auth = try await security.authenticate(req)', `try auth.requireRoles([${endpoint.roles.map(swString).join(', ')}])`)
      else body.push('_ = try await security.authenticate(req)')
    }
    const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
    if (hasKey) body.push(keyRead())
    const status = `HTTPStatus(statusCode: ${endpoint.status})`
    const service = `service.${fn}`
    if (endpoint.operation === 'list') {
      if (endpoint.pagination)
        body.push(
          'let page = try intQuery(req, "page", default: 1, min: 1, max: nil)',
          `let size = try intQuery(req, "size", default: ${PAGE_SIZE.default}, min: 1, max: ${PAGE_SIZE.max})`,
        )
      const own = resource.fields.filter((field) => endpoint.filters.includes(field.wire) && filterStruct.includes(field))
      if (own.length > 0) {
        body.push(`var filters = ${name.filters}()`)
        for (const field of own) body.push(`filters.${property(field)} = ${filterRead(context, field)}`)
      } else body.push(`let filters = ${name.filters}()`)
      if (endpoint.sort.length > 0) {
        const choices = endpoint.sort.flatMap((wire) => [swString(wire), swString(`-${wire}`)]).join(', ')
        body.push(`let sort = try choiceQuery(req, "sort", [${choices}])`)
      }
      const sort = endpoint.sort.length > 0 ? 'sort' : 'nil'
      if (endpoint.pagination)
        body.push(
          `let result = try await ${service}(ListQuery(filters: filters, sort: ${sort}, offset: (page - 1) * size, limit: size))`,
          `return try jsonResponse(${status}, PageResponse(items: result.items.map(${name.response}.init), total: result.total, page: page, size: size))`,
        )
      else
        body.push(
          `let result = try await ${service}(ListQuery(filters: filters, sort: ${sort}, offset: 0, limit: nil))`,
          `return try jsonResponse(${status}, result.items.map(${name.response}.init))`,
        )
    } else {
      if (endpoint.input !== 'none') {
        const bodyClass = endpoint.input === 'partial' ? name.update : name.create
        body.push(`let body = try readBody(req, as: ${bodyClass}.self, rules: ${bodyClass}.rules)`)
      }
      const args = [hasKey ? 'key' : null, endpoint.input !== 'none' ? 'body' : null].filter(Boolean).join(', ')
      switch (endpoint.operation) {
        case 'get':
        case 'create':
        case 'replace':
        case 'update':
          body.push(`return try jsonResponse(${status}, ${name.response}(try await ${service}(${args})))`)
          break
        case 'delete':
          body.push(`try await ${service}(key)`, `return Response(status: ${status})`)
          break
        case 'custom':
          if (endpoint.output === 'none' || endpoint.status === 204)
            body.push(`${endpoint.output === 'none' ? '' : '_ = '}try await ${service}(${args})`, `return Response(status: ${status})`)
          else if (endpoint.output === 'list')
            body.push(`return try jsonResponse(${status}, try await ${service}(${args}).map(${name.response}.init))`)
          else body.push(`return try jsonResponse(${status}, ${name.response}(try await ${service}(${args})))`)
          break
      }
    }
    return lines(
      `    /// ${endpoint.summary}.`,
      '    @Sendable',
      `    func ${fn}(req: Request) async throws -> Response {`,
      body.map((line) => `        ${line}`),
      '    }',
    )
  })
  const routes = resource.endpoints.map(
    (endpoint) => `        routes.on(.${endpoint.method}, ${pathComponents(endpoint.path)}, use: self.${endpointFunction(endpoint)})`,
  )
  const content = lines(
    ...swHeader(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`, ['Vapor']),
    swDoc(`The routes of ${resource.plural}.`),
    `struct ${name.controller}: RouteCollection {`,
    `    let service: ${name.service}`,
    context.security && '    let security: Security',
    '',
    '    func boot(routes: any RoutesBuilder) throws {',
    routes,
    '    }',
    '',
    handlers.join('\n\n'),
    '}',
  )
  return { path: sourcePath(context.layout.resource(resource, 'controller'), name.controller), content: fileText(content) }
}
