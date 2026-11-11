/**
 * The files of one resource in the NestJS project: its repository (an interface bound to an injection
 * token, with the chosen implementation), its service with the rules, its controller and its Nest module.
 */
import type { SpecEndpoint, SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { PAGE_SIZE } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, indent, lines } from '../../common/text.ts'
import { TsImports, tsAccess, tsDoc, tsLiteral, tsName, tsProperty, tsString } from '../../languages/typescript/typescript.ts'
import { SHARED, importPath, keyField, keyType, names, resourcePath, type NestContext } from './context.ts'
import { enumConstant } from './dto.ts'
import { typeormRepositoryBlock } from './typeorm.ts'

export function repositoryFile(context: NestContext, resource: SpecResource): GeneratedFile {
  const path = resourcePath(resource, 'repository')
  const name = names(resource)
  const key = keyType(resource)
  const keyWire = keyField(resource).wire
  const imports = new TsImports()
  imports.addType(importPath(path, 'src/common/listing.ts'), 'ListQuery', 'ListResult')
  imports.addType(importPath(path, resourcePath(resource, 'dto')), name.record)
  const newType = resource.key.generated ? `Omit<${name.record}, ${tsString(keyWire)}>` : name.record
  const contract = lines(
    `/** Injection token of the storage of ${resource.plural}. */`,
    `export const ${name.token} = Symbol(${tsString(name.repository)})`,
    '',
    `/** Where ${resource.plural} are kept. The service depends only on this interface. */`,
    `export interface ${name.repository} {`,
    `  list(query: ListQuery): Promise<ListResult<${name.record}>>`,
    `  get(key: ${key}): Promise<${name.record} | undefined>`,
    `  add(values: ${newType}): Promise<${name.record}>`,
    `  update(key: ${key}, values: Partial<${name.record}>): Promise<${name.record}>`,
    `  delete(key: ${key}): Promise<void>`,
    '}',
  )
  let implementation: string
  if (context.pending) {
    imports.add(importPath(path, 'src/common/errors.ts'), 'NotImplementedError')
    const pending = (signature: string) => [
      `  async ${signature} {`,
      `    // TODO: store ${resource.plural} in your database`,
      `    throw new NotImplementedError(${tsString(`The storage of ${resource.plural} is not written yet`)})`,
      '  }',
    ]
    implementation = lines(
      `/** Storage of ${resource.plural} to write: every method answers 501 until it is implemented. */`,
      `export class ${name.pendingRepository} implements ${name.repository} {`,
      pending(`list(_query: ListQuery): Promise<ListResult<${name.record}>>`),
      '',
      pending(`get(_key: ${key}): Promise<${name.record} | undefined>`),
      '',
      pending(`add(_values: ${newType}): Promise<${name.record}>`),
      '',
      pending(`update(_key: ${key}, _values: Partial<${name.record}>): Promise<${name.record}>`),
      '',
      pending(`delete(_key: ${key}): Promise<void>`),
      '}',
    )
  } else if (context.typeorm) {
    implementation = typeormRepositoryBlock(resource, imports, path)
  } else {
    if (resource.key.generated === 'uuid') imports.add('node:crypto', 'randomUUID')
    const keyProp = tsProperty(keyWire)
    const assign =
      resource.key.generated === 'increment'
        ? `    const record = { ...structuredClone(values), ${keyProp}: this.nextKey++ } as ${name.record}`
        : resource.key.generated === 'uuid'
          ? `    const record = { ...structuredClone(values), ${keyProp}: randomUUID() } as ${name.record}`
          : '    const record = structuredClone(values)'
    implementation = lines(
      `/** Keeps ${resource.plural} in memory: they are lost when the application stops. Use it to try the API. */`,
      `export class ${name.memory} implements ${name.repository} {`,
      `  private readonly items = new Map<${key}, ${name.record}>()`,
      resource.key.generated === 'increment' && '  private nextKey = 1',
      '',
      `  async list(query: ListQuery): Promise<ListResult<${name.record}>> {`,
      '    const value = (item: unknown, field: string) => (item as Record<string, unknown>)[field]',
      '    let items = [...this.items.values()].filter((item) => Object.entries(query.filters).every(([field, expected]) => value(item, field) === expected))',
      '    if (query.sort) {',
      '      const { field, descending } = query.sort',
      '      // Items without a value go last, whatever the order',
      '      const present = items.filter((item) => value(item, field) != null)',
      '      present.sort((a, b) => {',
      '        const left = value(a, field) as string | number',
      '        const right = value(b, field) as string | number',
      '        const order = left < right ? -1 : left > right ? 1 : 0',
      '        return descending ? -order : order',
      '      })',
      '      items = [...present, ...items.filter((item) => value(item, field) == null)]',
      '    }',
      '    const end = query.limit === undefined ? undefined : query.offset + query.limit',
      '    return { items: items.slice(query.offset, end).map((item) => structuredClone(item)), total: items.length }',
      '  }',
      '',
      `  async get(key: ${key}): Promise<${name.record} | undefined> {`,
      '    const item = this.items.get(key)',
      '    return item === undefined ? undefined : structuredClone(item)',
      '  }',
      '',
      `  async add(values: ${newType}): Promise<${name.record}> {`,
      assign,
      `    this.items.set(${tsAccess('record', keyWire)}, record)`,
      '    return structuredClone(record)',
      '  }',
      '',
      `  async update(key: ${key}, values: Partial<${name.record}>): Promise<${name.record}> {`,
      '    const record = { ...this.items.get(key)!, ...structuredClone(values) }',
      '    this.items.set(key, record)',
      '    return structuredClone(record)',
      '  }',
      '',
      `  async delete(key: ${key}): Promise<void> {`,
      '    this.items.delete(key)',
      '  }',
      '}',
    )
  }
  const content = lines(tsDoc(`Storage of ${resource.plural}.`), '', imports.render(), '', contract, '', implementation)
  return { path, content: fileText(content) }
}

function innerObject(type: SpecType): string | null {
  if (type.kind === 'object') return type.name
  if (type.kind === 'array') return innerObject(type.items)
  if (type.kind === 'map') return innerObject(type.value)
  return null
}

/** Resources a resource refers to, directly or inside its embedded objects, other than itself. */
export function referencedResources(context: NestContext, resource: SpecResource): SpecResource[] {
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

function referenceChecks(
  context: NestContext,
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
    else checks.push(`if (${value}) {`, `  const item${depth} = ${value}`, ...nested.map((line) => `  ${line}`), '}')
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

export function serviceFile(context: NestContext, resource: SpecResource): GeneratedFile {
  const path = resourcePath(resource, 'service')
  const name = names(resource)
  const key = keyType(resource)
  const keyWire = keyField(resource).wire
  const imports = new TsImports().add('@nestjs/common', 'Inject', 'Injectable')
  const dto = importPath(path, resourcePath(resource, 'dto'))
  const errors = importPath(path, 'src/common/errors.ts')
  imports.add(importPath(path, resourcePath(resource, 'repository')), name.token)
  imports.addType(importPath(path, resourcePath(resource, 'repository')), name.repository)
  imports.addType(dto, name.record)
  imports.add(errors, 'notFound')
  const needs = referencedResources(context, resource)
  for (const target of needs) {
    imports.add(importPath(path, resourcePath(target, 'repository')), names(target).token)
    imports.addType(importPath(path, resourcePath(target, 'repository')), names(target).repository)
  }
  const checks = referenceChecks(context, resource, resource.fields, 'values', '', 0)
  const hasChecks = checks.length > 0 && resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const methods: string[] = [
    lines(
      `  private async find(key: ${key}): Promise<${name.record}> {`,
      '    const item = await this.repository.get(key)',
      `    if (item === undefined) throw notFound(${tsString(resource.singular)})`,
      '    return item',
      '  }',
    ),
  ]
  if (hasChecks) {
    imports.add(errors, 'invalid')
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
  const usesNow = (operation: 'create' | 'replace' | 'update') =>
    resource.fields.some(
      (field) => field.access === 'readOnly' && (field.server === 'updated' || (field.server === 'created' && operation === 'create')),
    ) && '    const now = new Date().toISOString()'
  const clientKey = resource.key.generated === null
  /** The final call of a write: `add(` or `update(key, `, with the values the server fills. */
  const write = (operation: 'create' | 'replace' | 'update', call: string) =>
    serverValues(resource, operation).length > 0
      ? [
          `    return this.repository.${call}{`,
          '      ...values,',
          serverValues(resource, operation).map((line) => `      ${line}`),
          '    })',
        ]
      : `    return this.repository.${call}values)`
  for (const endpoint of resource.endpoints) {
    const fn = tsName(endpoint.name)
    switch (endpoint.operation) {
      case 'list':
        imports.addType(importPath(path, 'src/common/listing.ts'), 'ListQuery', 'ListResult')
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
        imports.addType(dto, name.create)
        if (clientKey) imports.add(errors, 'conflict')
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
            usesNow('create'),
            write('create', 'add('),
            '  }',
          ),
        )
        break
      case 'replace':
        imports.addType(dto, name.create)
        if (clientKey) imports.add(errors, 'invalid')
        methods.push(
          lines(
            `  /** ${endpoint.summary}: every field the client may send takes the value of the body. */`,
            `  async ${fn}(key: ${key}, values: ${name.create}): Promise<${name.record}> {`,
            '    await this.find(key)',
            clientKey && `    if (${tsAccess('values', keyWire)} !== key) throw invalid(${tsString(keyWire)}, 'The key cannot change')`,
            check,
            usesNow('replace'),
            write('replace', 'update(key, '),
            '  }',
          ),
        )
        break
      case 'update': {
        imports.addType(dto, name.update)
        const changesKey = clientKey && keyField(resource).access !== 'readOnly'
        if (changesKey) imports.add(errors, 'invalid')
        methods.push(
          lines(
            `  /** ${endpoint.summary}: only the fields in the body change. */`,
            `  async ${fn}(key: ${key}, values: ${name.update}): Promise<${name.record}> {`,
            '    await this.find(key)',
            changesKey &&
              `    if (${tsAccess('values', keyWire)} !== undefined && ${tsAccess('values', keyWire)} !== key) throw invalid(${tsString(keyWire)}, 'The key cannot change')`,
            check,
            usesNow('update'),
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
        imports.add(errors, 'NotImplementedError')
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const params = [
          hasKey ? `key: ${key}` : null,
          endpoint.input === 'resource' ? `_values: ${name.create}` : endpoint.input === 'partial' ? `_values: ${name.update}` : null,
        ].filter(Boolean)
        if (endpoint.input === 'resource') imports.addType(dto, name.create)
        if (endpoint.input === 'partial') imports.addType(dto, name.update)
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
  const params = [
    `@Inject(${name.token}) private readonly repository: ${name.repository}`,
    ...needs.map((target) => `@Inject(${names(target).token}) private readonly ${names(target).many}: ${names(target).repository}`),
  ]
  const content = lines(
    tsDoc(`Rules of ${resource.plural}: what each operation checks and changes.`),
    '',
    imports.render(),
    '',
    '@Injectable()',
    `export class ${name.service} {`,
    `  constructor(${params.join(', ')}) {}`,
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path, content: fileText(content) }
}

function guard(context: NestContext, endpoint: SpecEndpoint, imports: TsImports, path: string): string | null {
  if (endpoint.access === 'public' || context.settings.auth === 'none') return null
  imports.add('@nestjs/common', 'UseGuards')
  const security = importPath(path, 'src/common/security.ts')
  if (context.settings.auth === 'apiKey') {
    imports.add(security, 'ApiKeyGuard')
    return '@UseGuards(new ApiKeyGuard())'
  }
  imports.add(security, 'JwtGuard')
  return endpoint.access === 'roles'
    ? `@UseGuards(new JwtGuard([${endpoint.roles.map(tsString).join(', ')}]))`
    : '@UseGuards(new JwtGuard())'
}

/** class-validator decorators of a query parameter: query values are text, converted with class-transformer. */
function queryDecorators(context: NestContext, field: SpecField, imports: TsImports, path: string): { decorators: string[]; type: string } {
  imports.add('class-validator', 'IsOptional')
  const scalar = field.reference
    ? context.spec.resources.find((item) => item.name === field.reference)!.key.type.scalar
    : field.type.kind === 'scalar'
      ? field.type.scalar
      : null
  if (field.type.kind === 'enum') {
    imports.add('class-validator', 'IsIn')
    imports.add(importPath(path, SHARED), enumConstant(field.type.name))
    return { decorators: ['@IsOptional()', `@IsIn(${enumConstant(field.type.name)})`], type: 'string | number' }
  }
  if (scalar === 'integer' || scalar === 'float' || scalar === 'decimal') {
    imports.add('class-validator', scalar === 'integer' ? 'IsInt' : 'IsNumber')
    imports.add('class-transformer', 'Type')
    return { decorators: ['@IsOptional()', '@Type(() => Number)', scalar === 'integer' ? '@IsInt()' : '@IsNumber()'], type: 'number' }
  }
  if (scalar === 'boolean') {
    imports.add('class-validator', 'IsBoolean')
    imports.add('class-transformer', 'Transform')
    return {
      decorators: [
        '@IsOptional()',
        "@Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))",
        '@IsBoolean()',
      ],
      type: 'boolean',
    }
  }
  imports.add('class-validator', 'IsString')
  return { decorators: ['@IsOptional()', '@IsString()'], type: 'string' }
}

export function controllerFile(context: NestContext, resource: SpecResource): GeneratedFile {
  const path = resourcePath(resource, 'controller')
  const name = names(resource)
  const dto = importPath(path, resourcePath(resource, 'dto'))
  const imports = new TsImports().add('@nestjs/common', 'Controller', 'HttpCode', 'Inject')
  imports.add(importPath(path, resourcePath(resource, 'service')), name.service)
  imports.add(dto, name.toResponse)
  imports.addType(dto, name.type)
  const keyPipe = resource.key.type.scalar === 'integer' ? 'ParseIntPipe' : resource.key.type.scalar === 'uuid' ? 'ParseUUIDPipe' : null
  const queryClasses: string[] = []
  const methods = resource.endpoints.map((endpoint) => {
    const fn = tsName(endpoint.name)
    const decorator = endpoint.method.charAt(0) + endpoint.method.slice(1).toLowerCase()
    imports.add('@nestjs/common', decorator)
    const params: string[] = []
    const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
    if (hasKey) {
      imports.add('@nestjs/common', 'Param')
      if (keyPipe) imports.add('@nestjs/common', keyPipe)
      params.push(`@Param(${tsString(resource.key.param)}${keyPipe ? `, ${keyPipe}` : ''}) key: ${keyType(resource)}`)
    }
    if (endpoint.input !== 'none') {
      imports.add('@nestjs/common', 'Body')
      const bodyType = endpoint.input === 'partial' ? name.update : name.create
      imports.add(dto, bodyType)
      params.push(`@Body() values: ${bodyType}`)
    }
    const body: string[] = []
    let returns = `Promise<${name.type}>`
    switch (endpoint.operation) {
      case 'list': {
        imports.add('@nestjs/common', 'Query')
        imports.add(importPath(path, 'src/common/listing.ts'), 'parseSort')
        const queryName = `${name.query}${resource.endpoints.filter((item) => item.operation === 'list').indexOf(endpoint) || ''}`
        const fields: string[] = []
        if (endpoint.pagination) {
          imports.add('class-validator', 'IsInt', 'IsOptional', 'Min', 'Max')
          imports.add('class-transformer', 'Type')
          fields.push(
            '  @IsOptional()\n  @Type(() => Number)\n  @IsInt()\n  @Min(1)\n  page: number = 1',
            `  @IsOptional()\n  @Type(() => Number)\n  @IsInt()\n  @Min(1)\n  @Max(${PAGE_SIZE.max})\n  size: number = ${PAGE_SIZE.default}`,
          )
        }
        for (const wire of endpoint.filters) {
          const field = resource.fields.find((item) => item.wire === wire)!
          const { decorators, type } = queryDecorators(context, field, imports, path)
          fields.push(`${decorators.map((item) => `  ${item}`).join('\n')}\n  ${tsProperty(wire)}?: ${type}`)
        }
        if (endpoint.sort.length > 0) {
          imports.add('class-validator', 'IsIn', 'IsOptional')
          fields.push(
            `  @IsOptional()\n  @IsIn([${endpoint.sort.flatMap((wire) => [tsString(wire), tsString(`-${wire}`)]).join(', ')}])\n  sort?: string`,
          )
        }
        queryClasses.push(
          lines(`/** Query parameters of ${endpoint.summary.toLowerCase()}. */`, `class ${queryName} {`, fields.join('\n\n'), '}'),
        )
        params.push(`@Query() query: ${queryName}`)
        const filters = endpoint.filters.map((wire) => `${tsProperty(wire)}: ${tsAccess('query', wire)}`)
        body.push(
          filters.length > 0
            ? `const filters = Object.fromEntries(Object.entries({ ${filters.join(', ')} }).filter(([, value]) => value !== undefined))`
            : 'const filters = {}',
        )
        const sort = endpoint.sort.length > 0 ? 'parseSort(query.sort)' : 'undefined'
        if (endpoint.pagination) {
          body.push(
            `const { items, total } = await this.service.${fn}({ filters, sort: ${sort}, offset: (query.page - 1) * query.size, limit: query.size })`,
            `return { items: items.map(${name.toResponse}), total, page: query.page, size: query.size }`,
          )
          returns = `Promise<{ items: ${name.type}[]; total: number; page: number; size: number }>`
        } else {
          body.push(
            `const { items } = await this.service.${fn}({ filters, sort: ${sort}, offset: 0 })`,
            `return items.map(${name.toResponse})`,
          )
          returns = `Promise<${name.type}[]>`
        }
        break
      }
      case 'get':
        body.push(`return ${name.toResponse}(await this.service.${fn}(key))`)
        break
      case 'create':
        body.push(`return ${name.toResponse}(await this.service.${fn}(values))`)
        break
      case 'replace':
      case 'update':
        body.push(`return ${name.toResponse}(await this.service.${fn}(key, values))`)
        break
      case 'delete':
        body.push(`await this.service.${fn}(key)`)
        returns = 'Promise<void>'
        break
      case 'custom': {
        const call = `await this.service.${fn}(${[hasKey ? 'key' : null, endpoint.input !== 'none' ? 'values' : null].filter(Boolean).join(', ')})`
        if (endpoint.output === 'none' || endpoint.status === 204) {
          body.push(call)
          returns = 'Promise<void>'
        } else if (endpoint.output === 'list') {
          body.push(`return (${call}).map(${name.toResponse})`)
          returns = `Promise<${name.type}[]>`
        } else body.push(`return ${name.toResponse}(${call})`)
        break
      }
    }
    return lines(
      `  /** ${endpoint.summary}. */`,
      `  @${decorator}(${tsString(endpoint.path.replace(/\{([^}]+)\}/g, ':$1'))})`,
      `  @HttpCode(${endpoint.status})`,
      guard(context, endpoint, imports, path) ? `  ${guard(context, endpoint, imports, path)}` : false,
      `  async ${fn}(${params.join(', ')}): ${returns} {`,
      indent(body.join('\n'), 4),
      '  }',
    )
  })
  const content = lines(
    tsDoc(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`),
    '',
    imports.render(),
    '',
    queryClasses.length > 0 && [queryClasses.join('\n\n'), ''],
    '@Controller()',
    `export class ${name.controller} {`,
    `  constructor(@Inject(${name.service}) private readonly service: ${name.service}) {}`,
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path, content: fileText(content) }
}

export function moduleFile(context: NestContext, resource: SpecResource): GeneratedFile {
  const path = resourcePath(resource, 'module')
  const name = names(resource)
  const imports = new TsImports().add('@nestjs/common', 'Module')
  const repository = importPath(path, resourcePath(resource, 'repository'))
  const implementation = context.pending ? name.pendingRepository : context.typeorm ? name.typeormRepository : name.memory
  imports.add(repository, name.token, implementation)
  imports.add(importPath(path, resourcePath(resource, 'controller')), name.controller)
  imports.add(importPath(path, resourcePath(resource, 'service')), name.service)
  const needs = referencedResources(context, resource)
  for (const target of needs) imports.add(importPath(path, resourcePath(target, 'module')), names(target).module)
  if (context.typeorm) {
    imports.add('@nestjs/typeorm', 'TypeOrmModule')
    imports.add(importPath(path, resourcePath(resource, 'entity')), name.entity)
  }
  const moduleImports = [
    ...(context.typeorm ? [`TypeOrmModule.forFeature([${name.entity}])`] : []),
    ...needs.map((target) => names(target).module),
  ]
  const content = lines(
    tsDoc(`Module of ${resource.plural}: its routes, its rules and the storage they use.`),
    '',
    imports.render(),
    '',
    '@Module({',
    moduleImports.length > 0 && `  imports: [${moduleImports.join(', ')}],`,
    `  controllers: [${name.controller}],`,
    `  providers: [${name.service}, { provide: ${name.token}, useClass: ${implementation} }],`,
    `  exports: [${name.token}],`,
    '})',
    `export class ${name.module} {}`,
  )
  return { path, content: fileText(content) }
}
