/**
 * Services and controllers of the ASP.NET Core project.
 *
 * The service of a resource holds its rules: items that must exist, keys that must not repeat, references that
 * must point to stored items, and the values the server fills. Business endpoints get a method that throws
 * NotImplementedException (501) with a TODO where their logic goes. Null where the contract forbids it is
 * rejected by the request bodies themselves (Common/Payload.cs).
 *
 * The controller only translates HTTP to service calls: parameters, bodies, status codes and protection.
 */
import type { SpecEndpoint, SpecField, SpecResource } from '../../../api/spec.ts'
import { PAGE_SIZE, shapeFields } from '../../../openapi/build.ts'
import type { JsonValue } from '../../common/samples.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { CsUsings, csClass, csDoc, csHeader, csNumber, csPascal, csString, csType } from '../../languages/csharp/csharp.ts'
import { innerObject, referencedResources } from '../../common/references.ts'
import { commonNamespace, keyField, keyType, names, namespaceOf, property, sharedNames, sourcePath, type AspNetContext } from './context.ts'
import { enumMember, fieldType } from './model.ts'

/** The method of a service for an endpoint: `listCustomers` → `ListCustomersAsync`. */
export function serviceMethod(endpoint: SpecEndpoint): string {
  return `${csPascal(endpoint.name)}Async`
}

/** A default value written in C# for the field's type. */
function csDefault(context: AspNetContext, field: SpecField, usings: CsUsings): string {
  const value = field.defaultValue
  if (value === null || value === undefined) return 'null'
  const type = field.type
  if (type.kind === 'enum') {
    usings.add(sharedNames(context).namespace())
    return `${csClass(type.name)}.${enumMember(context, type.name, value as string | number)}`
  }
  if (type.kind === 'scalar') {
    const invariant = () => usings.add('System.Globalization')
    switch (type.scalar) {
      case 'integer':
        return csNumber(value as number, type.bits === 64 ? 'long' : 'int')
      case 'float':
        return csNumber(value as number, 'double')
      case 'decimal':
        return csNumber(value as number, 'decimal')
      case 'boolean':
        return String(value)
      case 'date':
        invariant()
        return `DateOnly.Parse(${csString(String(value))}, CultureInfo.InvariantCulture)`
      case 'datetime':
        invariant()
        return `DateTimeOffset.Parse(${csString(String(value))}, CultureInfo.InvariantCulture)`
      case 'uuid':
        return `Guid.Parse(${csString(String(value))})`
      case 'binary':
        return `Convert.FromBase64String(${csString(String(value))})`
      case 'string':
      case 'time':
      case 'duration':
        return csString(String(value))
    }
  }
  // Lists, maps, objects and values of any shape: written in JSON
  usings.add(commonNamespace(context))
  return `JsonValues.Parse<${csType(type, usings, sharedNames(context), false)}>(${csString(JSON.stringify(value as JsonValue))})`
}

/** The value the server gives a read-only field, or null when it gives none in this operation. */
function serverValue(
  context: AspNetContext,
  field: SpecField,
  operation: 'create' | 'replace' | 'update',
  usings: CsUsings,
): string | null {
  if (field.access !== 'readOnly' || field.server === 'key') return null
  const now = () => {
    usings.add(commonNamespace(context))
    if (field.type.kind === 'scalar' && field.type.scalar === 'date') return 'Clock.Today()'
    if (field.type.kind === 'scalar' && field.type.scalar === 'datetime') return 'Clock.Now()'
    return 'Clock.Text()'
  }
  if (field.server === 'updated') return now()
  if (operation !== 'create') return null
  if (field.server === 'created') return now()
  if (field.server === 'default') return csDefault(context, field, usings)
  return null
}

/** C# statements that check every reference of an item, nested objects included. */
function referenceChecks(
  context: AspNetContext,
  resource: SpecResource,
  fields: SpecField[],
  owner: string,
  source: string,
  label: string,
  depth: number,
  counter: { next: number },
): string[] {
  const checks: string[] = []
  for (const field of fields) {
    const value = `${source}.${property(field, owner)}`
    const where = label ? `${label}.${field.wire}` : field.wire
    if (field.reference) {
      const repository = field.reference === resource.name ? 'repository' : `${csName(field.reference)}Repository`
      const variable = `reference${counter.next++}`
      const failure = `throw ApiException.Invalid(${csString(where)}, ${csString(`No ${field.reference} has this key`)});`
      if (field.type.kind === 'array')
        checks.push(
          `foreach (var ${variable} in ${value} ?? [])`,
          '{',
          `    if (await ${repository}.GetAsync(${variable}) is null)`,
          '    {',
          `        ${failure}`,
          '    }',
          '}',
        )
      else checks.push(`if (${value} is { } ${variable} && await ${repository}.GetAsync(${variable}) is null)`, '{', `    ${failure}`, '}')
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3 || field.type.kind === 'map') continue
    const variable = `item${depth}`
    const nested = referenceChecks(context, resource, object.fields, csClass(object.name), variable, where, depth + 1, counter)
    if (nested.length === 0) continue
    if (field.type.kind === 'array')
      checks.push(`foreach (var ${variable} in ${value} ?? [])`, '{', ...nested.map((line) => `    ${line}`), '}')
    else if (field.type.kind === 'object') checks.push(`if (${value} is { } ${variable})`, '{', ...nested.map((line) => `    ${line}`), '}')
  }
  return checks
}

function csName(name: string): string {
  const pascal = csPascal(name)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/** The value of a key the body carries, as the domain class holds it (never null). */
function bodyKey(resource: SpecResource, value: string): string {
  return keyType(resource) === 'string' ? `${value}!` : `${value}!.Value`
}

export function serviceFile(context: AspNetContext, resource: SpecResource): GeneratedFile {
  const relative = context.layout.resource(resource, 'service')
  const namespace = namespaceOf(context, relative)
  const name = names(resource)
  const dto = namespaceOf(context, context.layout.resource(resource, 'dto'))
  const usings = new CsUsings(namespace).add(
    namespaceOf(context, context.layout.resource(resource, 'model')),
    namespaceOf(context, context.layout.resource(resource, 'repository')),
    commonNamespace(context),
  )
  const key = keyType(resource)
  const keyProp = property(keyField(resource), name.type)
  const keyWire = keyField(resource).wire
  const needs = referencedResources(context, resource)
  for (const target of needs) usings.add(namespaceOf(context, context.layout.resource(target, 'repository')))
  const checks = referenceChecks(context, resource, resource.fields, name.type, 'item', '', 0, { next: 0 })
  const writes = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const createFields = shapeFields(resource.fields, 'create')
  const updateFields = shapeFields(resource.fields, 'update')
  const clientKey = resource.key.generated === null
  const methods: string[] = []
  methods.push(
    lines(
      `    private async Task<${name.type}> FindAsync(${key} key) =>`,
      `        await repository.GetAsync(key) ?? throw ApiException.NotFound(${csString(resource.singular)});`,
    ),
  )
  if (writes) {
    usings.add(dto)
    if (checks.length > 0)
      methods.push(
        lines(
          '    /// <summary>Every reference must point to a stored item.</summary>',
          `    private async Task CheckReferencesAsync(${name.type} item)`,
          '    {',
          checks.map((line) => `        ${line}`),
          '    }',
        ),
      )
    methods.push(
      lines(
        '    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>',
        `    private static void Apply(${name.type} item, ${name.create} data)`,
        '    {',
        createFields
          .filter((field) => field.name !== resource.key.field || clientKey)
          .map((field) => {
            const prop = property(field, name.type)
            if (field.name === resource.key.field) return `        item.${prop} = ${bodyKey(resource, `data.${prop}`)};`
            const value =
              field.defaultValue !== undefined
                ? `data.Has(${csString(field.wire)}) ? data.${prop} : ${csDefault(context, field, usings)}`
                : `data.${prop}`
            return `        item.${prop} = ${value};`
          }),
        '    }',
        '',
        '    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>',
        `    private static void ApplyChanges(${name.type} item, ${name.update} data)`,
        '    {',
        updateFields
          .filter((field) => field.name !== resource.key.field)
          .map((field) => [
            `        if (data.Has(${csString(field.wire)}))`,
            '        {',
            `            item.${property(field, name.type)} = data.${property(field, name.type)};`,
            '        }',
          ]),
        '    }',
      ),
    )
  }
  const server = (operation: 'create' | 'replace' | 'update') =>
    resource.fields.flatMap((field) => {
      const value = serverValue(context, field, operation, usings)
      if (value !== null) return [`        item.${property(field, name.type)} = ${value};`]
      if (operation === 'create' && field.access === 'readOnly' && field.server === 'pending')
        return [`        // TODO: ${field.todo ?? `fill "${field.name}"`}`]
      return []
    })
  const check = checks.length > 0 && '        await CheckReferencesAsync(item);'
  const sameKey = [
    `        if (data.${keyProp} != key)`,
    '        {',
    `            throw ApiException.Invalid(${csString(keyWire)}, "The key cannot change");`,
    '        }',
  ]
  for (const endpoint of resource.endpoints) {
    const fn = serviceMethod(endpoint)
    const doc = `    /// <summary>${endpoint.summary}.</summary>`
    switch (endpoint.operation) {
      case 'list':
        methods.push(lines(doc, `    public Task<ListResult<${name.type}>> ${fn}(ListQuery query) => repository.ListAsync(query);`))
        break
      case 'get':
        methods.push(lines(doc, `    public Task<${name.type}> ${fn}(${key} key) => FindAsync(key);`))
        break
      case 'create':
        methods.push(
          lines(
            doc,
            `    public async Task<${name.type}> ${fn}(${name.create} data)`,
            '    {',
            `        var item = new ${name.type}();`,
            '        Apply(item, data);',
            clientKey && [
              `        if (await repository.GetAsync(item.${keyProp}) is not null)`,
              '        {',
              `            throw ApiException.Conflict(${csString(`A ${resource.singular} with this key already exists`)});`,
              '        }',
            ],
            check,
            server('create'),
            '        return await repository.AddAsync(item);',
            '    }',
          ),
        )
        break
      case 'replace':
        methods.push(
          lines(
            `    /// <summary>${endpoint.summary}: every field the client may send takes the value of the body.</summary>`,
            `    public async Task<${name.type}> ${fn}(${key} key, ${name.create} data)`,
            '    {',
            '        var item = await FindAsync(key);',
            clientKey && sameKey,
            '        Apply(item, data);',
            check,
            server('replace'),
            '        return await repository.UpdateAsync(item);',
            '    }',
          ),
        )
        break
      case 'update': {
        const changesKey = clientKey && keyField(resource).access !== 'readOnly'
        methods.push(
          lines(
            `    /// <summary>${endpoint.summary}: only the fields in the body change.</summary>`,
            `    public async Task<${name.type}> ${fn}(${key} key, ${name.update} data)`,
            '    {',
            '        var item = await FindAsync(key);',
            changesKey && [
              `        if (data.Has(${csString(keyWire)}) && data.${keyProp} != key)`,
              '        {',
              `            throw ApiException.Invalid(${csString(keyWire)}, "The key cannot change");`,
              '        }',
            ],
            '        ApplyChanges(item, data);',
            check,
            server('update'),
            '        return await repository.UpdateAsync(item);',
            '    }',
          ),
        )
        break
      }
      case 'delete':
        methods.push(
          lines(
            doc,
            `    public async Task ${fn}(${key} key)`,
            '    {',
            '        await FindAsync(key);',
            '        await repository.DeleteAsync(key);',
            '    }',
          ),
        )
        break
      case 'custom': {
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const params = [
          hasKey ? `${key} key` : null,
          endpoint.input === 'resource' ? `${name.create} data` : endpoint.input === 'partial' ? `${name.update} data` : null,
        ].filter(Boolean)
        if (endpoint.input !== 'none') usings.add(dto)
        const returns = endpoint.output === 'none' ? 'Task' : endpoint.output === 'list' ? `Task<List<${name.type}>>` : `Task<${name.type}>`
        methods.push(
          lines(
            doc,
            `    public ${hasKey ? 'async ' : ''}${returns} ${fn}(${params.join(', ')})`,
            '    {',
            hasKey && '        await FindAsync(key);',
            `        // TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            `        throw new NotImplementedException(${csString(`${endpoint.summary} is not written yet`)});`,
            '    }',
          ),
        )
        break
      }
    }
  }
  const parameters = [
    `${name.repository} repository`,
    ...needs.map((target) => `${names(target).repository} ${csName(target.name)}Repository`),
  ]
  const content = lines(
    ...csHeader(namespace, usings),
    csDoc(`Rules of ${resource.plural}: what each operation checks and changes.`),
    `public sealed class ${name.service}(${parameters.join(', ')})`,
    '{',
    methods.join('\n\n'),
    '}',
  )
  return { path: sourcePath(context, relative, name.service), content: fileText(content) }
}

function authorize(context: AspNetContext, endpoint: SpecEndpoint, usings: CsUsings): string | null {
  if (!context.security || endpoint.access === 'public') return null
  usings.add('Microsoft.AspNetCore.Authorization')
  if (endpoint.access === 'roles' && context.settings.auth === 'jwt') return `[Authorize(Roles = ${csString(endpoint.roles.join(','))})]`
  return '[Authorize]'
}

/** A query parameter of a filter, and how the controller turns it into the field's value. */
function filterParam(context: AspNetContext, resource: SpecResource, field: SpecField, usings: CsUsings) {
  const param = `${csName(field.wire)}Filter`
  const binding = `[FromQuery(Name = ${csString(field.wire)})]`
  if (field.type.kind === 'enum') {
    const enumName = field.type.name
    const integer = context.spec.enums.find((item) => item.name === enumName)?.valueType === 'integer'
    usings.add(sharedNames(context).namespace())
    const converter = `${integer ? 'NumberEnumConverter' : 'TextEnumConverter'}<${csClass(enumName)}>`
    return {
      param,
      declaration: `${binding} ${integer ? 'long?' : 'string?'} ${param} = null`,
      value: `${converter}.Parse(${param}${integer ? '.Value' : ''}) ?? throw ApiException.Invalid(${csString(field.wire)}, "Unknown value")`,
    }
  }
  const type = fieldType(context, field, usings, resource)
  return { param, declaration: `${binding} ${type} ${param} = null`, value: unwrapped(type, param) }
}

/** The value of a filter parameter, unwrapped from its nullable type. */
function unwrapped(type: string, param: string): string {
  return type.endsWith('?') && type !== 'string?' && !type.startsWith('List<') ? `${param}.Value` : param
}

export function controllerFile(context: AspNetContext, resource: SpecResource): GeneratedFile {
  const relative = context.layout.resource(resource, 'controller')
  const namespace = namespaceOf(context, relative)
  const name = names(resource)
  const dto = namespaceOf(context, context.layout.resource(resource, 'dto'))
  const usings = new CsUsings(namespace).add(
    'Microsoft.AspNetCore.Mvc',
    dto,
    namespaceOf(context, context.layout.resource(resource, 'service')),
  )
  const key = keyType(resource)
  const methods = resource.endpoints.map((endpoint) => {
    const fn = csPascal(endpoint.name)
    const call = serviceMethod(endpoint)
    const verb = `Http${endpoint.method.charAt(0)}${endpoint.method.slice(1).toLowerCase()}`
    const params: string[] = []
    const optional: string[] = []
    const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
    if (hasKey) params.push(`[FromRoute(Name = ${csString(resource.key.param)})] ${key} key`)
    for (const param of endpoint.pathParams.filter((item) => item.name !== resource.key.param))
      params.push(`[FromRoute(Name = ${csString(param.name)})] string ${csName(param.name)}`)
    if (endpoint.input !== 'none') params.push(`[FromBody] ${endpoint.input === 'partial' ? name.update : name.create} data`)
    const body: string[] = []
    const status = endpoint.status
    switch (endpoint.operation) {
      case 'list': {
        usings.add(commonNamespace(context))
        if (endpoint.pagination) {
          usings.add('System.ComponentModel.DataAnnotations')
          optional.push(
            '[FromQuery, Range(1, int.MaxValue)] int page = 1',
            `[FromQuery, Range(1, ${PAGE_SIZE.max})] int size = ${PAGE_SIZE.default}`,
          )
        }
        const filters = endpoint.filters.map((wire) =>
          filterParam(
            context,
            resource,
            resource.fields.find((field) => field.wire === wire)!,
            usings,
          ),
        )
        optional.push(...filters.map((filter) => filter.declaration))
        if (endpoint.sort.length > 0) {
          const allowed = endpoint.sort
            .flatMap((wire) => [wire, `-${wire}`])
            .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|')
          optional.push(`[FromQuery, Pattern(${csString(`^(${allowed})$`)})] string? sort = null`)
        }
        body.push('var filters = new Dictionary<string, object>();')
        endpoint.filters.forEach((wire, index) =>
          body.push(`if (${filters[index].param} is not null)`, '{', `    filters[${csString(wire)}] = ${filters[index].value};`, '}'),
        )
        const sort = endpoint.sort.length > 0 ? 'sort' : 'null'
        if (endpoint.pagination)
          body.push(
            `var result = await service.${call}(ListQuery.Of(filters, ${sort}, (page - 1) * size, size));`,
            `return StatusCode(${status}, new PageResponse<${name.response}>([.. result.Items.Select(${name.response}.From)], result.Total, page, size));`,
          )
        else
          body.push(
            `var result = await service.${call}(ListQuery.Of(filters, ${sort}));`,
            `return StatusCode(${status}, result.Items.Select(${name.response}.From).ToList());`,
          )
        break
      }
      case 'get':
        body.push(`return StatusCode(${status}, ${name.response}.From(await service.${call}(key)));`)
        break
      case 'create':
        body.push(`return StatusCode(${status}, ${name.response}.From(await service.${call}(data)));`)
        break
      case 'replace':
      case 'update':
        body.push(`return StatusCode(${status}, ${name.response}.From(await service.${call}(key, data)));`)
        break
      case 'delete':
        body.push(`await service.${call}(key);`, `return StatusCode(${status});`)
        break
      case 'custom': {
        const invocation = `await service.${call}(${[hasKey ? 'key' : null, endpoint.input !== 'none' ? 'data' : null].filter(Boolean).join(', ')})`
        if (endpoint.output === 'none' || status === 204) body.push(`${invocation};`, `return StatusCode(${status});`)
        else if (endpoint.output === 'list')
          body.push(`return StatusCode(${status}, (${invocation}).Select(${name.response}.From).ToList());`)
        else body.push(`return StatusCode(${status}, ${name.response}.From(${invocation}));`)
        break
      }
    }
    if (endpoint.filters.length > 0 || endpoint.sort.length > 0) usings.add(commonNamespace(context))
    const all = [...params, ...optional]
    const signature =
      all.length === 0
        ? [`    public async Task<IActionResult> ${fn}()`]
        : all.length === 1 && all[0].length < 70
          ? [`    public async Task<IActionResult> ${fn}(${all[0]})`]
          : [
              `    public async Task<IActionResult> ${fn}(`,
              all.map((param, index) => `        ${param}${index === all.length - 1 ? ')' : ','}`),
            ]
    return lines(
      `    /// <summary>${endpoint.summary}.</summary>`,
      `    [${verb}(${csString(endpoint.path)})]`,
      authorize(context, endpoint, usings) && `    ${authorize(context, endpoint, usings)}`,
      signature,
      '    {',
      body.map((line) => `        ${line}`),
      '    }',
    )
  })
  const content = lines(
    ...csHeader(namespace, usings),
    csDoc(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`),
    '[ApiController]',
    `public sealed class ${name.controller}(${name.service} service) : ControllerBase`,
    '{',
    methods.join('\n\n'),
    '}',
  )
  return { path: sourcePath(context, relative, name.controller), content: fileText(content) }
}
