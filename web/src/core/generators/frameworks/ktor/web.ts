/**
 * Services and routes of the Ktor project.
 *
 * The service of a resource holds its rules: items that must exist, keys that must not repeat, references that
 * must point to stored items, and the values the server fills. Business endpoints get a function that calls
 * `TODO()` (501) where their logic goes. Presence, null and the declared validations are checked on the request
 * body itself (common/Bodies.kt).
 *
 * The routes only translate HTTP to service calls: parameters, bodies, status codes and protection.
 */
import type { SpecEndpoint, SpecField, SpecResource } from '../../../api/spec.ts'
import { PAGE_SIZE, shapeFields } from '../../../openapi/build.ts'
import { innerObject, referencedResources } from '../../common/references.ts'
import type { JsonValue } from '../../common/samples.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { KtImports, ktClass, ktConstant, ktDoc, ktHeader, ktName, ktNumber, ktString } from '../../languages/kotlin/kotlin.ts'
import { commonPackage, keyField, keyType, names, property, sourcePath, type KtorContext } from './context.ts'
import { serializerOf } from './model.ts'

/** The function of a service for an endpoint: `listCustomers`. */
export function serviceFunction(endpoint: SpecEndpoint): string {
  return ktName(endpoint.name)
}

/** A default value written in Kotlin for the field's type. */
function ktDefault(context: KtorContext, field: SpecField, imports: KtImports): string {
  const value = field.defaultValue
  if (value === null || value === undefined) return 'null'
  const type = field.type
  if (type.kind === 'enum') {
    imports.add(`${context.layout.shared()}.${ktClass(type.name)}`)
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    const used = new Set<string>()
    const constants = item.values.map((entry) => {
      let constant = ktConstant(entry)
      for (let n = 2; used.has(constant); n++) constant = `${ktConstant(entry)}_${n}`
      used.add(constant)
      return constant
    })
    return `${ktClass(type.name)}.${constants[item.values.indexOf(value as string | number)]}`
  }
  if (type.kind === 'scalar') {
    switch (type.scalar) {
      case 'integer':
        return ktNumber(value as number, type.bits === 64 ? 'Long' : 'Int')
      case 'float':
        return ktNumber(value as number, 'Double')
      case 'decimal':
        imports.add('java.math.BigDecimal')
        return `BigDecimal(${ktString(String(value))})`
      case 'boolean':
        return String(value)
      case 'date':
        imports.add('java.time.LocalDate')
        return `LocalDate.parse(${ktString(String(value))})`
      case 'datetime':
        imports.add('java.time.OffsetDateTime')
        return `OffsetDateTime.parse(${ktString(String(value))}).toInstant()`
      case 'uuid':
        imports.add('java.util.UUID')
        return `UUID.fromString(${ktString(String(value))})`
      case 'any':
        break
      default:
        return ktString(String(value))
    }
  }
  // Lists, maps, objects and values of any shape: written in JSON
  imports.add(`${commonPackage(context)}.JsonFormat`)
  return `JsonFormat.decodeFromString(${serializerOf(context, field, imports)}, ${ktString(JSON.stringify(value as JsonValue))})`
}

/** The value the server gives a read-only field, or null when it gives none in this operation. */
function serverValue(
  context: KtorContext,
  field: SpecField,
  operation: 'create' | 'replace' | 'update',
  imports: KtImports,
): string | null {
  if (field.access !== 'readOnly' || field.server === 'key') return null
  const now = () => {
    imports.add(`${commonPackage(context)}.Clock`)
    if (field.type.kind === 'scalar' && field.type.scalar === 'date') return 'Clock.today()'
    if (field.type.kind === 'scalar' && field.type.scalar === 'datetime') return 'Clock.now()'
    return 'Clock.text()'
  }
  if (field.server === 'updated') return now()
  if (operation !== 'create') return null
  if (field.server === 'created') return now()
  if (field.server === 'default') return ktDefault(context, field, imports)
  return null
}

/** Kotlin statements that check every reference of an item, nested objects included. */
function referenceChecks(
  context: KtorContext,
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
      const repository = field.reference === resource.name ? 'repository' : `${names(target(context, field.reference)).one}Repository`
      const variable = `reference${counter.next++}`
      const failure = `throw ApiException.invalid(${ktString(where)}, ${ktString(`No ${field.reference} has this key`)})`
      const call = field.type.kind === 'array' ? 'forEach' : 'let'
      checks.push(`${value}?.${call} { ${variable} ->`, `    if (${repository}.get(${variable}) == null) ${failure}`, '}')
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3 || field.type.kind === 'map') continue
    const variable = `item${depth}`
    const nested = referenceChecks(context, resource, object.fields, variable, where, depth + 1, counter)
    if (nested.length === 0) continue
    const call = field.type.kind === 'array' ? 'forEach' : 'let'
    checks.push(`${value}?.${call} { ${variable} ->`, ...nested.map((line) => `    ${line}`), '}')
  }
  return checks
}

function target(context: KtorContext, name: string): SpecResource {
  return context.spec.resources.find((item) => item.name === name)!
}

export function serviceFile(context: KtorContext, resource: SpecResource): GeneratedFile {
  const pkg = context.layout.resource(resource, 'service')
  const name = names(resource)
  const common = commonPackage(context)
  const dto = context.layout.resource(resource, 'dto')
  const imports = new KtImports(pkg).add(
    `${context.layout.resource(resource, 'model')}.${name.type}`,
    `${context.layout.resource(resource, 'repository')}.${name.repository}`,
    `${common}.ApiException`,
  )
  const key = keyType(resource)
  if (key === 'JsonUuid') imports.add(`${common}.JsonUuid`)
  const keyProp = property(keyField(resource))
  const keyWire = keyField(resource).wire
  const needs = referencedResources(context, resource)
  for (const item of needs) imports.add(`${context.layout.resource(item, 'repository')}.${names(item).repository}`)
  const checks = referenceChecks(context, resource, resource.fields, 'item', '', 0, { next: 0 })
  const writes = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const clientKey = resource.key.generated === null
  const functions: string[] = [
    lines(
      `    private suspend fun find(key: ${key}): ${name.type} =`,
      `        repository.get(key) ?: throw ApiException.notFound(${ktString(resource.singular)})`,
    ),
  ]
  if (writes) {
    imports.add(`${common}.Body`, `${dto}.${name.create}`, `${dto}.${name.update}`)
    if (checks.length > 0)
      functions.push(
        lines(
          '    /** Every reference must point to a stored item. */',
          `    private suspend fun checkReferences(item: ${name.type}) {`,
          checks.map((line) => `        ${line}`),
          '    }',
        ),
      )
    functions.push(
      lines(
        '    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */',
        `    private fun apply(item: ${name.type}, body: Body<${name.create}>) {`,
        '        val data = body.value',
        shapeFields(resource.fields, 'create')
          .filter((field) => field.name !== resource.key.field || clientKey)
          .map((field) => {
            const prop = property(field)
            if (field.name === resource.key.field) return `        item.${prop} = data.${prop}!!`
            if (field.defaultValue !== undefined)
              return `        item.${prop} = if (body.has(${ktString(field.wire)})) data.${prop} else ${ktDefault(context, field, imports)}`
            return `        item.${prop} = data.${prop}`
          }),
        '    }',
        '',
        '    /** Sets the fields a partial change carries; the others stay as they are. */',
        `    private fun applyChanges(item: ${name.type}, body: Body<${name.update}>) {`,
        '        val data = body.value',
        shapeFields(resource.fields, 'update')
          .filter((field) => field.name !== resource.key.field)
          .map((field) => `        if (body.has(${ktString(field.wire)})) item.${property(field)} = data.${property(field)}`),
        '    }',
      ),
    )
  }
  const server = (operation: 'create' | 'replace' | 'update') =>
    resource.fields.flatMap((field) => {
      const value = serverValue(context, field, operation, imports)
      if (value !== null) return [`        item.${property(field)} = ${value}`]
      if (operation === 'create' && field.access === 'readOnly' && field.server === 'pending')
        return [`        // TODO: ${field.todo ?? `fill "${field.name}"`}`]
      return []
    })
  const check = checks.length > 0 && '        checkReferences(item)'
  for (const endpoint of resource.endpoints) {
    const fn = serviceFunction(endpoint)
    const doc = `    /** ${endpoint.summary}. */`
    switch (endpoint.operation) {
      case 'list':
        imports.add(`${common}.ListQuery`, `${common}.ListResult`)
        functions.push(lines(doc, `    suspend fun ${fn}(query: ListQuery): ListResult<${name.type}> = repository.list(query)`))
        break
      case 'get':
        functions.push(lines(doc, `    suspend fun ${fn}(key: ${key}): ${name.type} = find(key)`))
        break
      case 'create':
        functions.push(
          lines(
            doc,
            `    suspend fun ${fn}(body: Body<${name.create}>): ${name.type} {`,
            `        val item = ${name.type}()`,
            '        apply(item, body)',
            clientKey && [
              `        if (repository.get(item.${keyProp}) != null) {`,
              `            throw ApiException.conflict(${ktString(`A ${resource.singular} with this key already exists`)})`,
              '        }',
            ],
            check,
            server('create'),
            '        return repository.add(item)',
            '    }',
          ),
        )
        break
      case 'replace':
        functions.push(
          lines(
            `    /** ${endpoint.summary}: every field the client may send takes the value of the body. */`,
            `    suspend fun ${fn}(key: ${key}, body: Body<${name.create}>): ${name.type} {`,
            '        val item = find(key)',
            clientKey && [
              `        if (body.value.${keyProp} != key) throw ApiException.invalid(${ktString(keyWire)}, "The key cannot change")`,
            ],
            '        apply(item, body)',
            check,
            server('replace'),
            '        return repository.update(item)',
            '    }',
          ),
        )
        break
      case 'update': {
        const changesKey = clientKey && keyField(resource).access !== 'readOnly'
        functions.push(
          lines(
            `    /** ${endpoint.summary}: only the fields in the body change. */`,
            `    suspend fun ${fn}(key: ${key}, body: Body<${name.update}>): ${name.type} {`,
            '        val item = find(key)',
            changesKey && [
              `        if (body.has(${ktString(keyWire)}) && body.value.${keyProp} != key) {`,
              `            throw ApiException.invalid(${ktString(keyWire)}, "The key cannot change")`,
              '        }',
            ],
            '        applyChanges(item, body)',
            check,
            server('update'),
            '        return repository.update(item)',
            '    }',
          ),
        )
        break
      }
      case 'delete':
        functions.push(lines(doc, `    suspend fun ${fn}(key: ${key}) {`, '        find(key)', '        repository.delete(key)', '    }'))
        break
      case 'custom': {
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const params = [
          hasKey ? `key: ${key}` : null,
          endpoint.input === 'resource' ? `body: Body<${name.create}>` : endpoint.input === 'partial' ? `body: Body<${name.update}>` : null,
        ].filter(Boolean)
        if (endpoint.input !== 'none') imports.add(`${common}.Body`, `${dto}.${name.create}`, `${dto}.${name.update}`)
        const returns = endpoint.output === 'none' ? '' : endpoint.output === 'list' ? `: List<${name.type}>` : `: ${name.type}`
        functions.push(
          lines(
            doc,
            `    suspend fun ${fn}(${params.join(', ')})${returns} {`,
            hasKey && '        find(key)',
            `        // TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            `        TODO(${ktString(`${endpoint.summary} is not written yet`)})`,
            '    }',
          ),
        )
        break
      }
    }
  }
  const parameters = [
    `private val repository: ${name.repository}`,
    ...needs.map((item) => `private val ${names(item).one}Repository: ${names(item).repository}`),
  ]
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc(`Rules of ${resource.plural}: what each operation checks and changes.`),
    `class ${name.service}(`,
    parameters.map((parameter) => `    ${parameter},`),
    ') {',
    functions.join('\n\n'),
    '}',
  )
  return { path: sourcePath(pkg, name.service), content: fileText(content) }
}

/** The expression that reads a filter of the query string with the type of its field. */
function filterRead(context: KtorContext, field: SpecField, imports: KtImports): string {
  const wire = ktString(field.wire)
  const common = commonPackage(context)
  const helper = (fn: string) => {
    imports.add(`${common}.${fn}`)
    return fn
  }
  if (field.reference) {
    const key = keyType(target(context, field.reference))
    if (key === 'Long') return `call.filter(${wire}) { it.toLongOrNull() }`
    if (key === 'JsonUuid') return `call.filter(${wire}, ::${helper('parseUuid')})`
    return `call.filter(${wire}) { it }`
  }
  const type = field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    imports.add(`${context.layout.shared()}.${ktClass(type.name)}`)
    return item.valueType === 'integer'
      ? `call.filter(${wire}) { text -> text.toLongOrNull()?.let { ${ktClass(type.name)}.fromValue(it) } }`
      : `call.filter(${wire}) { ${ktClass(type.name)}.fromValue(it) }`
  }
  if (type.kind === 'scalar') {
    switch (type.scalar) {
      case 'integer':
        return type.bits === 64 ? `call.filter(${wire}) { it.toLongOrNull() }` : `call.filter(${wire}) { it.toIntOrNull() }`
      case 'float':
        return `call.filter(${wire}) { it.toDoubleOrNull() }`
      case 'decimal':
        return `call.filter(${wire}) { it.toBigDecimalOrNull() }`
      case 'boolean':
        return `call.filter(${wire}) { it.toBooleanStrictOrNull() }`
      case 'date':
        return `call.filter(${wire}, ::${helper('parseDate')})`
      case 'datetime':
        return `call.filter(${wire}, ::${helper('parseDateTime')})`
      case 'uuid':
        return `call.filter(${wire}, ::${helper('parseUuid')})`
    }
  }
  return `call.filter(${wire}) { it }`
}

/** The statement that reads the key of a path with its type: a malformed key is a 400. */
function keyRead(context: KtorContext, resource: SpecResource, imports: KtImports): string {
  const param = ktString(resource.key.param)
  const fn = resource.key.type.scalar === 'integer' ? 'longKey' : resource.key.type.scalar === 'uuid' ? 'uuidKey' : 'textKey'
  imports.add(`${commonPackage(context)}.${fn}`)
  return `val key = call.${fn}(${param})`
}

export function routesFile(context: KtorContext, resource: SpecResource): GeneratedFile {
  const pkg = context.layout.resource(resource, 'routes')
  const name = names(resource)
  const common = commonPackage(context)
  const dto = context.layout.resource(resource, 'dto')
  const imports = new KtImports(pkg).add(
    'io.ktor.http.HttpStatusCode',
    'io.ktor.server.response.respond',
    'io.ktor.server.routing.Route',
    `${context.layout.resource(resource, 'service')}.${name.service}`,
    `${dto}.${name.response}`,
  )
  const routes = resource.endpoints.map((endpoint) => {
    const fn = serviceFunction(endpoint)
    const verb = endpoint.method.toLowerCase()
    imports.add(`io.ktor.server.routing.${verb}`)
    const body: string[] = []
    const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
    if (endpoint.access === 'roles' && context.settings.auth === 'jwt') {
      imports.add(`${context.base}.security.requireRoles`)
      body.push(`call.requireRoles(${endpoint.roles.map(ktString).join(', ')})`)
    }
    if (hasKey) body.push(keyRead(context, resource, imports))
    if (endpoint.input !== 'none') {
      const bodyClass = endpoint.input === 'partial' ? name.update : name.create
      imports.add(`${common}.receiveBody`, `${dto}.${bodyClass}`)
      body.push(`val body = call.receiveBody(${bodyClass}.serializer(), ${bodyClass}::rules)`)
    }
    const status = `HttpStatusCode.fromValue(${endpoint.status})`
    switch (endpoint.operation) {
      case 'list': {
        imports.add(`${common}.ListQuery`)
        if (endpoint.pagination) {
          imports.add(`${common}.intQuery`, `${common}.PageResponse`)
          body.push('val page = call.intQuery("page", 1, 1)', `val size = call.intQuery("size", ${PAGE_SIZE.default}, 1, ${PAGE_SIZE.max})`)
        }
        if (endpoint.filters.length > 0) {
          imports.add(`${common}.filter`)
          body.push('val filters = buildMap<String, Any> {')
          for (const wire of endpoint.filters) {
            const field = resource.fields.find((item) => item.wire === wire)!
            body.push(`    ${filterRead(context, field, imports)}?.let { put(${ktString(wire)}, it) }`)
          }
          body.push('}')
        } else body.push('val filters = emptyMap<String, Any>()')
        if (endpoint.sort.length > 0) {
          imports.add(`${common}.choiceQuery`)
          const choices = endpoint.sort.flatMap((wire) => [ktString(wire), ktString(`-${wire}`)]).join(', ')
          body.push(`val sort = call.choiceQuery("sort", listOf(${choices}))`)
        }
        const sort = endpoint.sort.length > 0 ? 'sort' : 'null'
        if (endpoint.pagination)
          body.push(
            `val result = service.${fn}(ListQuery.of(filters, ${sort}, (page - 1) * size, size))`,
            `call.respond(${status}, PageResponse(result.items.map(${name.response}::from), result.total, page, size))`,
          )
        else
          body.push(
            `val result = service.${fn}(ListQuery.of(filters, ${sort}))`,
            `call.respond(${status}, result.items.map(${name.response}::from))`,
          )
        break
      }
      case 'get':
        body.push(`call.respond(${status}, ${name.response}.from(service.${fn}(key)))`)
        break
      case 'create':
        body.push(`call.respond(${status}, ${name.response}.from(service.${fn}(body)))`)
        break
      case 'replace':
      case 'update':
        body.push(`call.respond(${status}, ${name.response}.from(service.${fn}(key, body)))`)
        break
      case 'delete':
        body.push(`service.${fn}(key)`, `call.respond(${status})`)
        break
      case 'custom': {
        const invocation = `service.${fn}(${[hasKey ? 'key' : null, endpoint.input !== 'none' ? 'body' : null].filter(Boolean).join(', ')})`
        if (endpoint.output === 'none' || endpoint.status === 204) body.push(invocation, `call.respond(${status})`)
        else if (endpoint.output === 'list') body.push(`call.respond(${status}, ${invocation}.map(${name.response}::from))`)
        else body.push(`call.respond(${status}, ${name.response}.from(${invocation}))`)
        break
      }
    }
    const handler = [`${verb}(${ktString(endpoint.path)}) {`, ...body.map((line) => `    ${line}`), '}']
    const protectedRoute = context.security && endpoint.access !== 'public'
    if (protectedRoute) imports.add('io.ktor.server.auth.authenticate', `${context.base}.security.AUTH`)
    const block = protectedRoute ? ['authenticate(AUTH) {', ...handler.map((line) => `    ${line}`), '}'] : handler
    return lines(
      `    // ${endpoint.summary}`,
      block.map((line) => `    ${line}`),
    )
  })
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`),
    `fun Route.${name.routesFunction}(service: ${name.service}) {`,
    routes.join('\n\n'),
    '}',
  )
  return { path: sourcePath(pkg, name.routes), content: fileText(content) }
}
