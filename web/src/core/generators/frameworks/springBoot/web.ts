/**
 * Services and controllers of the Spring Boot project.
 *
 * The service of a resource holds its rules: items that must exist, keys that must not repeat, null sent
 * where the contract forbids it, references that must point to stored items, and the values the server
 * fills. Business endpoints get a method that answers 501 with a TODO where their logic goes.
 *
 * The controller only translates HTTP to service calls: parameters, bodies, status codes and protection.
 */
import type { SpecEndpoint, SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { PAGE_SIZE, shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { JavaImports, getter, javaClass, javaConstant, javaDoc, javaName, javaString, setter } from '../../languages/java/java.ts'
import { commonPackage, keyField, keyType, names, property, sharedNames, sourcePath, type SpringContext } from './context.ts'
import { fieldType } from './model.ts'

/** Resources a resource refers to, directly or inside its embedded objects, other than itself. */
function referencedResources(context: SpringContext, resource: SpecResource): SpecResource[] {
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

/** A default value written in Java for the field's type. */
function javaDefault(context: SpringContext, field: SpecField, imports: JavaImports): string {
  const value = field.defaultValue
  if (value === null || value === undefined) return 'null'
  if (field.type.kind === 'enum') {
    imports.add(sharedNames(context).enum(field.type.name))
    return `${javaClass(field.type.name)}.${javaConstant(value as string | number)}`
  }
  if (field.type.kind === 'scalar') {
    switch (field.type.scalar) {
      case 'integer':
        return field.type.bits === 64 ? `${value}L` : String(value)
      case 'float':
        return Number.isInteger(value) ? `${value}.0` : String(value)
      case 'decimal':
        imports.add('java.math.BigDecimal')
        return `new BigDecimal(${javaString(String(value))})`
      case 'boolean':
        return String(value)
      case 'date':
        imports.add('java.time.LocalDate')
        return `LocalDate.parse(${javaString(String(value))})`
      default:
        return javaString(String(value))
    }
  }
  return 'null'
}

/** Java statements that check every reference of an item, nested objects included. */
function referenceChecks(
  context: SpringContext,
  resource: SpecResource,
  fields: SpecField[],
  source: (field: SpecField) => string,
  label: string,
  depth: number,
): string[] {
  const checks: string[] = []
  for (const field of fields) {
    const value = source(field)
    const where = label ? `${label}.${field.wire}` : field.wire
    if (field.reference) {
      const lookup = field.reference === resource.name ? 'repository::get' : `${javaName(field.reference)}Repository::get`
      if (field.type.kind === 'array')
        checks.push(
          `if (${value} != null) {`,
          `    for (var key : ${value}) {`,
          `        require(${lookup}, key, ${javaString(where)}, ${javaString(field.reference)});`,
          '    }',
          '}',
        )
      else checks.push(`require(${lookup}, ${value}, ${javaString(where)}, ${javaString(field.reference)});`)
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3) continue
    const variable = `item${depth}`
    const nested = referenceChecks(context, resource, object.fields, (child) => `${variable}.${property(child)}()`, where, depth + 1)
    if (nested.length === 0) continue
    if (field.type.kind === 'array')
      checks.push(
        `if (${value} != null) {`,
        `    for (var ${variable} : ${value}) {`,
        ...nested.map((line) => `        ${line}`),
        '    }',
        '}',
      )
    else if (field.type.kind === 'object')
      checks.push(`if (${value} != null) {`, `    var ${variable} = ${value};`, ...nested.map((line) => `    ${line}`), '}')
  }
  return checks
}

/** The value the server gives a read-only field, or null when it gives none in this operation. */
function serverValue(
  context: SpringContext,
  field: SpecField,
  operation: 'create' | 'replace' | 'update',
  imports: JavaImports,
): string | null {
  if (field.access !== 'readOnly' || field.server === 'key') return null
  const now = () => {
    imports.add('java.time.ZoneOffset')
    if (field.type.kind === 'scalar' && field.type.scalar === 'date') {
      imports.add('java.time.LocalDate')
      return 'LocalDate.now(ZoneOffset.UTC)'
    }
    imports.add('java.time.OffsetDateTime', 'java.time.temporal.ChronoUnit')
    // Microseconds: the precision databases keep, so a later read gives the same value
    return 'OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MICROS)'
  }
  if (field.server === 'updated') return now()
  if (operation !== 'create') return null
  if (field.server === 'created') return now()
  if (field.server === 'default') return javaDefault(context, field, imports)
  return null
}

export function serviceFile(context: SpringContext, resource: SpecResource): GeneratedFile {
  const pkg = context.layout.resource(resource, 'service')
  const name = names(resource)
  const common = commonPackage(context)
  const dto = context.layout.resource(resource, 'dto')
  const imports = new JavaImports(pkg).add(
    `${context.layout.resource(resource, 'model')}.${name.type}`,
    `${context.layout.resource(resource, 'repository')}.${name.repository}`,
    `${common}.ApiException`,
    'org.springframework.stereotype.Service',
  )
  const key = keyType(resource)
  if (key === 'UUID') imports.add('java.util.UUID')
  const keyProp = property(keyField(resource))
  const needs = referencedResources(context, resource)
  for (const target of needs) imports.add(`${context.layout.resource(target, 'repository')}.${names(target).repository}`)
  const checks = referenceChecks(context, resource, resource.fields, (field) => `item.${getter(property(field))}()`, '', 0)
  const writes = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const createFields = shapeFields(resource.fields, 'create')
  const updateFields = shapeFields(resource.fields, 'update')
  const methods: string[] = []
  methods.push(
    lines(
      `    private ${name.type} find(${key} key) {`,
      `        return repository.get(key).orElseThrow(() -> ApiException.notFound(${javaString(resource.singular)}));`,
      '    }',
    ),
  )
  if (writes) {
    imports.add(`${dto}.${name.create}`, `${dto}.${name.update}`)
    if (checks.length > 0) {
      imports.add('java.util.Optional', 'java.util.function.Function')
      methods.push(
        lines(
          '    /** A reference must point to a stored item. */',
          '    private static <K> void require(Function<K, Optional<?>> lookup, K key, String field, String model) {',
          '        if (key != null && lookup.apply(key).isEmpty()) {',
          '            throw ApiException.invalid(field, "No " + model + " has this key");',
          '        }',
          '    }',
          '',
          `    private void checkReferences(${name.type} item) {`,
          checks.map((line) => `        ${line}`),
          '    }',
        ),
      )
    }
    // Fields the contract says cannot be null: a body may leave them out, but not send null
    const nullable = (fields: SpecField[], shape: 'create' | 'update') =>
      fields
        .filter((field) => !field.nullable && (shape === 'update' || !field.required))
        .map(
          (field) =>
            `        rejectNull(data.has(${javaString(field.wire)}), data.${getter(property(field))}(), ${javaString(field.wire)});`,
        )
    methods.push(
      lines(
        '    private static void rejectNull(boolean sent, Object value, String field) {',
        '        if (sent && value == null) {',
        '            throw ApiException.invalid(field, "must not be null");',
        '        }',
        '    }',
        '',
        '    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */',
        `    private void apply(${name.type} item, ${name.create} data) {`,
        nullable(createFields, 'create'),
        createFields
          .filter((field) => field.name !== resource.key.field || resource.key.generated === null)
          .map((field) => {
            const value = `data.${getter(property(field))}()`
            const fallback =
              field.defaultValue !== undefined
                ? `data.has(${javaString(field.wire)}) ? ${value} : ${javaDefault(context, field, imports)}`
                : value
            return `        item.${setter(property(field))}(${fallback});`
          }),
        '    }',
      ),
    )
    methods.push(
      lines(
        `    private void applyChanges(${name.type} item, ${name.update} data) {`,
        nullable(updateFields, 'update'),
        updateFields.map((field) => [
          `        if (data.has(${javaString(field.wire)})) {`,
          `            item.${setter(property(field))}(data.${getter(property(field))}());`,
          '        }',
        ]),
        '    }',
      ),
    )
  }
  const server = (operation: 'create' | 'replace' | 'update') =>
    resource.fields.flatMap((field) => {
      const value = serverValue(context, field, operation, imports)
      if (value !== null) return [`        item.${setter(property(field))}(${value});`]
      if (operation === 'create' && field.access === 'readOnly' && field.server === 'pending')
        return [`        // TODO: ${field.todo ?? `fill "${field.name}"`}`]
      return []
    })
  const clientKey = resource.key.generated === null
  for (const endpoint of resource.endpoints) {
    const fn = javaName(endpoint.name)
    switch (endpoint.operation) {
      case 'list':
        imports.add(`${common}.ListQuery`, `${common}.ListResult`)
        methods.push(
          lines(
            `    /** ${endpoint.summary}. */`,
            `    public ListResult<${name.type}> ${fn}(ListQuery query) {`,
            '        return repository.list(query);',
            '    }',
          ),
        )
        break
      case 'get':
        methods.push(
          lines(`    /** ${endpoint.summary}. */`, `    public ${name.type} ${fn}(${key} key) {`, '        return find(key);', '    }'),
        )
        break
      case 'create':
        methods.push(
          lines(
            `    /** ${endpoint.summary}. */`,
            `    public ${name.type} ${fn}(${name.create} data) {`,
            `        ${name.type} item = new ${name.type}();`,
            '        apply(item, data);',
            clientKey && [
              `        if (repository.get(item.${getter(keyProp)}()).isPresent()) {`,
              `            throw ApiException.conflict(${javaString(`A ${resource.singular} with this key already exists`)});`,
              '        }',
            ],
            checks.length > 0 && '        checkReferences(item);',
            server('create'),
            '        return repository.add(item);',
            '    }',
          ),
        )
        break
      case 'replace':
        methods.push(
          lines(
            `    /** ${endpoint.summary}: every field the client may send takes the value of the body. */`,
            `    public ${name.type} ${fn}(${key} key, ${name.create} data) {`,
            `        ${name.type} item = find(key);`,
            clientKey && [
              `        if (!key.equals(data.${getter(keyProp)}())) {`,
              `            throw ApiException.invalid(${javaString(keyField(resource).wire)}, "The key cannot change");`,
              '        }',
            ],
            '        apply(item, data);',
            checks.length > 0 && '        checkReferences(item);',
            server('replace'),
            '        return repository.update(item);',
            '    }',
          ),
        )
        break
      case 'update': {
        const changesKey = clientKey && keyField(resource).access !== 'readOnly'
        methods.push(
          lines(
            `    /** ${endpoint.summary}: only the fields in the body change. */`,
            `    public ${name.type} ${fn}(${key} key, ${name.update} data) {`,
            `        ${name.type} item = find(key);`,
            changesKey && [
              `        if (data.has(${javaString(keyField(resource).wire)}) && !key.equals(data.${getter(keyProp)}())) {`,
              `            throw ApiException.invalid(${javaString(keyField(resource).wire)}, "The key cannot change");`,
              '        }',
            ],
            '        applyChanges(item, data);',
            checks.length > 0 && '        checkReferences(item);',
            server('update'),
            '        return repository.update(item);',
            '    }',
          ),
        )
        break
      }
      case 'delete':
        methods.push(
          lines(
            `    /** ${endpoint.summary}. */`,
            `    public void ${fn}(${key} key) {`,
            '        find(key);',
            '        repository.delete(key);',
            '    }',
          ),
        )
        break
      case 'custom': {
        imports.add(`${common}.NotImplementedException`)
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const params = [
          hasKey ? `${key} key` : null,
          endpoint.input === 'resource' ? `${name.create} data` : endpoint.input === 'partial' ? `${name.update} data` : null,
        ].filter(Boolean)
        if (endpoint.input !== 'none') imports.add(`${dto}.${name.create}`, `${dto}.${name.update}`)
        if (endpoint.output === 'list') imports.add('java.util.List')
        const returns = endpoint.output === 'none' ? 'void' : endpoint.output === 'list' ? `List<${name.type}>` : name.type
        methods.push(
          lines(
            `    /** ${endpoint.summary}. */`,
            `    public ${returns} ${fn}(${params.join(', ')}) {`,
            hasKey && '        find(key);',
            `        // TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            `        throw new NotImplementedException(${javaString(`${endpoint.summary} is not written yet`)});`,
            '    }',
          ),
        )
        break
      }
    }
  }
  const fieldsDecl = [
    `    private final ${name.repository} repository;`,
    ...needs.map((target) => `    private final ${names(target).repository} ${javaName(target.name)}Repository;`),
  ]
  const ctorParams = [
    `${name.repository} repository`,
    ...needs.map((target) => `${names(target).repository} ${javaName(target.name)}Repository`),
  ]
  const content = lines(
    `package ${pkg};`,
    '',
    imports.render(),
    '',
    javaDoc(`Rules of ${resource.plural}: what each operation checks and changes.`),
    '@Service',
    `public class ${name.service} {`,
    '',
    fieldsDecl,
    '',
    `    public ${name.service}(${ctorParams.join(', ')}) {`,
    '        this.repository = repository;',
    needs.map((target) => `        this.${javaName(target.name)}Repository = ${javaName(target.name)}Repository;`),
    '    }',
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path: sourcePath(pkg, name.service), content: fileText(content) }
}

function preAuthorize(context: SpringContext, endpoint: SpecEndpoint, imports: JavaImports): string | null {
  if (!context.security || endpoint.access === 'public') return null
  imports.add('org.springframework.security.access.prepost.PreAuthorize')
  if (endpoint.access === 'roles' && context.settings.auth === 'jwt')
    return `@PreAuthorize("hasAnyRole(${endpoint.roles.map((role) => `'${role.replace(/'/g, "\\'")}'`).join(', ')})")`
  return '@PreAuthorize("isAuthenticated()")'
}

/** A query parameter of a filter: text, converted by the controller to the field's type. */
function filterParam(
  context: SpringContext,
  resource: SpecResource,
  field: SpecField,
  imports: JavaImports,
): { declaration: string; value: string } {
  const param = `${javaName(field.wire)}Filter`
  imports.add('org.springframework.web.bind.annotation.RequestParam')
  if (field.type.kind === 'enum') {
    imports.add(sharedNames(context).enum(field.type.name))
    const integer = context.spec.enums.find((item) => item.name === (field.type as { name: string }).name)?.valueType === 'integer'
    return {
      declaration: `@RequestParam(name = ${javaString(field.wire)}, required = false) ${integer ? 'Integer' : 'String'} ${param}`,
      value: `${param} == null ? null : ${javaClass(field.type.name)}.fromValue(${param})`,
    }
  }
  const type = fieldType(context, field, imports, resource)
  return { declaration: `@RequestParam(name = ${javaString(field.wire)}, required = false) ${type} ${param}`, value: param }
}

export function controllerFile(context: SpringContext, resource: SpecResource): GeneratedFile {
  const pkg = context.layout.resource(resource, 'controller')
  const name = names(resource)
  const dto = context.layout.resource(resource, 'dto')
  const common = commonPackage(context)
  const imports = new JavaImports(pkg).add(
    `${context.layout.resource(resource, 'service')}.${name.service}`,
    `${dto}.${name.response}`,
    'org.springframework.http.ResponseEntity',
    'org.springframework.web.bind.annotation.RestController',
  )
  const key = keyType(resource)
  if (key === 'UUID') imports.add('java.util.UUID')
  const methods = resource.endpoints.map((endpoint) => {
    const fn = javaName(endpoint.name)
    const mapping = `${endpoint.method.charAt(0)}${endpoint.method.slice(1).toLowerCase()}Mapping`
    imports.add(`org.springframework.web.bind.annotation.${mapping}`)
    const params: string[] = []
    const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
    if (hasKey) {
      imports.add('org.springframework.web.bind.annotation.PathVariable')
      params.push(`@PathVariable(${javaString(resource.key.param)}) ${key} key`)
    }
    for (const param of endpoint.pathParams.filter((item) => item.name !== resource.key.param)) {
      imports.add('org.springframework.web.bind.annotation.PathVariable')
      params.push(`@PathVariable(${javaString(param.name)}) String ${javaName(param.name)}`)
    }
    if (endpoint.input !== 'none') {
      imports.add(
        'jakarta.validation.Valid',
        'org.springframework.web.bind.annotation.RequestBody',
        `${dto}.${endpoint.input === 'partial' ? name.update : name.create}`,
      )
      params.push(`@Valid @RequestBody ${endpoint.input === 'partial' ? name.update : name.create} data`)
    }
    const body: string[] = []
    const status = endpoint.status
    switch (endpoint.operation) {
      case 'list': {
        imports.add(`${common}.ListQuery`, 'java.util.HashMap', 'java.util.Map', 'org.springframework.web.bind.annotation.RequestParam')
        if (endpoint.pagination) {
          imports.add('jakarta.validation.constraints.Min', 'jakarta.validation.constraints.Max', `${common}.PageResponse`)
          params.push(
            `@RequestParam(defaultValue = "1") @Min(1) int page`,
            `@RequestParam(defaultValue = "${PAGE_SIZE.default}") @Min(1) @Max(${PAGE_SIZE.max}) int size`,
          )
        }
        const filters = endpoint.filters.map((wire) =>
          filterParam(
            context,
            resource,
            resource.fields.find((field) => field.wire === wire)!,
            imports,
          ),
        )
        params.push(...filters.map((filter) => filter.declaration))
        if (endpoint.sort.length > 0) {
          imports.add('jakarta.validation.constraints.Pattern')
          const allowed = endpoint.sort
            .flatMap((wire) => [wire, `-${wire}`])
            .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&'))
            .join('|')
          params.push(`@RequestParam(required = false) @Pattern(regexp = ${javaString(allowed)}) String sort`)
        }
        body.push('Map<String, Object> filters = new HashMap<>();')
        endpoint.filters.forEach((wire, index) =>
          body.push(
            `if (${filters[index].value.split(' ')[0]} != null) {`,
            `    filters.put(${javaString(wire)}, ${filters[index].value});`,
            '}',
          ),
        )
        const sort = endpoint.sort.length > 0 ? 'sort' : 'null'
        if (endpoint.pagination) {
          body.push(
            `var result = service.${fn}(ListQuery.of(filters, ${sort}, (page - 1) * size, size));`,
            `return ResponseEntity.status(${status}).body(new PageResponse<>(result.items().stream().map(${name.response}::from).toList(), result.total(), page, size));`,
          )
        } else {
          body.push(
            `var result = service.${fn}(ListQuery.of(filters, ${sort}, 0, null));`,
            `return ResponseEntity.status(${status}).body(result.items().stream().map(${name.response}::from).toList());`,
          )
        }
        break
      }
      case 'get':
        body.push(`return ResponseEntity.status(${status}).body(${name.response}.from(service.${fn}(key)));`)
        break
      case 'create':
        body.push(`return ResponseEntity.status(${status}).body(${name.response}.from(service.${fn}(data)));`)
        break
      case 'replace':
      case 'update':
        body.push(`return ResponseEntity.status(${status}).body(${name.response}.from(service.${fn}(key, data)));`)
        break
      case 'delete':
        body.push(`service.${fn}(key);`, `return ResponseEntity.status(${status}).build();`)
        break
      case 'custom': {
        const call = `service.${fn}(${[hasKey ? 'key' : null, endpoint.input !== 'none' ? 'data' : null].filter(Boolean).join(', ')})`
        if (endpoint.output === 'none' || status === 204) body.push(`${call};`, `return ResponseEntity.status(${status}).build();`)
        else if (endpoint.output === 'list')
          body.push(`return ResponseEntity.status(${status}).body(${call}.stream().map(${name.response}::from).toList());`)
        else body.push(`return ResponseEntity.status(${status}).body(${name.response}.from(${call}));`)
        break
      }
    }
    const returns =
      endpoint.operation === 'delete' || ((endpoint.output === 'none' || status === 204) && endpoint.operation === 'custom')
        ? 'ResponseEntity<Void>'
        : endpoint.output === 'list'
          ? endpoint.pagination
            ? `ResponseEntity<PageResponse<${name.response}>>`
            : `ResponseEntity<java.util.List<${name.response}>>`
          : `ResponseEntity<${name.response}>`
    return lines(
      `    /** ${endpoint.summary}. */`,
      `    @${mapping}(${javaString(endpoint.path)})`,
      preAuthorize(context, endpoint, imports) ? `    ${preAuthorize(context, endpoint, imports)}` : false,
      `    public ${returns} ${fn}(${params.join(', ')}) {`,
      body.map((line) => `        ${line}`),
      '    }',
    )
  })
  const content = lines(
    `package ${pkg};`,
    '',
    imports.render(),
    '',
    javaDoc(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`),
    '@RestController',
    `public class ${name.controller} {`,
    '',
    `    private final ${name.service} service;`,
    '',
    `    public ${name.controller}(${name.service} service) {`,
    '        this.service = service;',
    '    }',
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path: sourcePath(pkg, name.controller), content: fileText(content) }
}
