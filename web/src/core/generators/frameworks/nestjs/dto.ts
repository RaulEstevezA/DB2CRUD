/**
 * DTOs of the NestJS project, validated with class-validator: the enums and embedded objects shared by the
 * resources, and for each resource its creation and partial update bodies, the record the repositories
 * keep and the response the API returns. They follow the shapes of the OpenAPI contract field by field.
 */
import type { SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { toScreamingSnakeCase } from '../../../model/naming.ts'
import { shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { TsImports, tsDoc, tsLiteral, tsProperty, tsString, tsType } from '../../languages/typescript/typescript.ts'
import { SHARED, importPath, names, resourcePath, type NestContext } from './context.ts'

/** The TypeScript type of an API type. */
export function tsTypeOf(type: SpecType): string {
  switch (type.kind) {
    case 'scalar':
      if (['integer', 'float', 'decimal'].includes(type.scalar)) return 'number'
      if (type.scalar === 'boolean') return 'boolean'
      if (type.scalar === 'any') return 'unknown'
      return 'string'
    case 'array': {
      const items = tsTypeOf(type.items)
      return /[ |]/.test(items) ? `(${items})[]` : `${items}[]`
    }
    case 'map':
      return `Record<string, ${tsTypeOf(type.value)}>`
    case 'object':
      return `${tsType(type.name)}Dto`
    case 'enum':
      return tsType(type.name)
  }
}

/** Name of the constant that lists an enum's values: `ORDER_STATUS`. */
export function enumConstant(name: string): string {
  return toScreamingSnakeCase(name) || 'VALUES'
}

/** The type of a reference field: the key of the resource it points to. */
function referenceScalar(context: NestContext, field: SpecField): 'integer' | 'uuid' | 'string' {
  const target = context.spec.resources.find((item) => item.name === field.reference)!
  const scalar = target.key.type.scalar
  return scalar === 'integer' ? 'integer' : scalar === 'uuid' ? 'uuid' : 'string'
}

/** class-validator decorators of a value of a type; `each` checks every item of a list. */
function typeDecorators(context: NestContext, type: SpecType, field: SpecField, imports: TsImports, here: string, each: boolean): string[] {
  const cv = (...names: string[]) => imports.add('class-validator', ...names)
  /** A class-validator decorator, with its import recorded. */
  const withImport = (decorator: string, text: string) => {
    cv(decorator)
    return text
  }
  const opt = each ? '{ each: true }' : ''
  const c = field.constraints
  if (field.reference && type.kind !== 'array') {
    const scalar = referenceScalar(context, field)
    if (scalar === 'integer') {
      cv('IsInt')
      return [`@IsInt(${opt})`]
    }
    if (scalar === 'uuid') {
      cv('IsUUID')
      return [`@IsUUID(${each ? "'all', { each: true }" : ''})`]
    }
    cv('IsString')
    return [`@IsString(${opt})`]
  }
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string': {
          const result: string[] = []
          if (c.format === 'email') result.push(withImport('IsEmail', `@IsEmail(${each ? '{}, { each: true }' : ''})`))
          else if (c.format === 'uri') result.push(withImport('IsUrl', `@IsUrl({ require_tld: false }${each ? ', { each: true }' : ''})`))
          else if (c.format === 'uuid') result.push(withImport('IsUUID', `@IsUUID(${each ? "'all', { each: true }" : ''})`))
          else if (c.format === 'date' || c.format === 'date-time')
            result.push(withImport('IsISO8601', `@IsISO8601({ strict: true }${each ? ', { each: true }' : ''})`))
          else result.push(withImport('IsString', `@IsString(${opt})`))
          if (!each && c.minLength !== undefined) result.push(withImport('MinLength', `@MinLength(${c.minLength})`))
          if (!each && c.maxLength !== undefined) result.push(withImport('MaxLength', `@MaxLength(${c.maxLength})`))
          if (!each && c.pattern !== undefined) result.push(withImport('Matches', `@Matches(new RegExp(${tsString(c.pattern)}))`))
          return result
        }
        case 'integer':
        case 'float':
        case 'decimal': {
          const result = [
            type.scalar === 'integer'
              ? withImport('IsInt', `@IsInt(${opt})`)
              : withImport('IsNumber', `@IsNumber(${each ? '{}, { each: true }' : ''})`),
          ]
          if (!each) {
            if (c.minimum !== undefined) result.push(withImport('Min', `@Min(${c.minimum})`))
            if (c.maximum !== undefined) result.push(withImport('Max', `@Max(${c.maximum})`))
            if (c.exclusiveMinimum !== undefined) {
              imports.add(importPath(here, 'src/common/validation.ts'), 'GreaterThan')
              result.push(`@GreaterThan(${c.exclusiveMinimum})`)
            }
            if (c.exclusiveMaximum !== undefined) {
              imports.add(importPath(here, 'src/common/validation.ts'), 'LessThan')
              result.push(`@LessThan(${c.exclusiveMaximum})`)
            }
          }
          return result
        }
        case 'boolean':
          cv('IsBoolean')
          return [`@IsBoolean(${opt})`]
        case 'date':
          cv('Matches')
          return [`@Matches(/^\\d{4}-\\d{2}-\\d{2}$/${each ? ', { each: true }' : ''})`]
        case 'datetime':
          cv('IsISO8601')
          return [`@IsISO8601({ strict: true }${each ? ', { each: true }' : ''})`]
        case 'time':
          cv('Matches')
          return [`@Matches(/^\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$/${each ? ', { each: true }' : ''})`]
        case 'uuid':
          cv('IsUUID')
          return [`@IsUUID(${each ? "'all', { each: true }" : ''})`]
        case 'binary':
          cv('IsBase64')
          return [`@IsBase64(${each ? '{}, { each: true }' : ''})`]
        case 'any':
          cv('Allow')
          return ['@Allow()']
        default:
          cv('IsString')
          return [`@IsString(${opt})`]
      }
    case 'enum': {
      cv('IsIn')
      if (here !== SHARED) imports.add(importPath(here, SHARED), enumConstant(type.name))
      return [`@IsIn(${enumConstant(type.name)}${each ? ', { each: true }' : ''})`]
    }
    case 'object': {
      cv('ValidateNested', 'IsObject')
      imports.add('class-transformer', 'Type')
      const dto = `${tsType(type.name)}Dto`
      if (here !== SHARED) imports.add(importPath(here, SHARED), dto)
      return [...(each ? [] : ['@IsObject()']), `@ValidateNested(${opt})`, `@Type(() => ${dto})`]
    }
    case 'array': {
      cv('IsArray')
      const result = ['@IsArray()']
      if (c.minItems !== undefined) result.push(withImport('ArrayMinSize', `@ArrayMinSize(${c.minItems})`))
      if (c.maxItems !== undefined) result.push(withImport('ArrayMaxSize', `@ArrayMaxSize(${c.maxItems})`))
      const items = field.reference ? { ...field, type: type.items } : { ...field, type: type.items, constraints: {} }
      return [...result, ...typeDecorators(context, type.items, items, imports, here, true)]
    }
    case 'map':
      cv('IsObject')
      return ['@IsObject()']
  }
}

type Shape = 'create' | 'update' | 'object'

/** One DTO property with its decorators: required, optional or nullable, and its validations. */
function property(context: NestContext, field: SpecField, shape: Shape, imports: TsImports, here: string): string {
  const decorators = typeDecorators(context, field.type, field, imports, here, false)
  const optional = shape === 'update' || !field.required
  if (field.nullable && optional) {
    imports.add('class-validator', 'IsOptional')
    decorators.unshift('@IsOptional()')
  } else if (field.nullable) {
    imports.add('class-validator', 'ValidateIf')
    decorators.unshift('@ValidateIf((_object, value) => value !== null)')
  } else if (optional) {
    // It may be left out, but null is not a value it accepts
    imports.add('class-validator', 'ValidateIf')
    decorators.unshift('@ValidateIf((_object, value) => value !== undefined)')
  }
  const type = field.reference
    ? field.type.kind === 'array'
      ? `${referenceScalar(context, field) === 'integer' ? 'number' : 'string'}[]`
      : referenceScalar(context, field) === 'integer'
        ? 'number'
        : 'string'
    : tsTypeOf(field.type)
  // The names a property's type uses (enums, embedded objects), at any depth
  const named = (inner: SpecType): string[] =>
    inner.kind === 'enum' || inner.kind === 'object'
      ? [tsTypeOf(inner)]
      : inner.kind === 'array'
        ? named(inner.items)
        : inner.kind === 'map'
          ? named(inner.value)
          : []
  if (here !== SHARED && !field.reference) for (const typeName of named(field.type)) imports.addType(importPath(here, SHARED), typeName)
  const nullable = field.nullable ? ' | null' : ''
  const declaration =
    shape === 'create' && !field.required && field.defaultValue !== undefined
      ? `${tsProperty(field.wire)}: ${type}${nullable} = ${tsLiteral(field.defaultValue)}`
      : `${tsProperty(field.wire)}${optional ? '?' : '!'}: ${type}${nullable}`
  const todo = field.todo ? `  // TODO: ${field.todo}\n` : ''
  return `${todo}${decorators.map((decorator) => `  ${decorator}`).join('\n')}\n  ${declaration}`
}

/** Enums and embedded objects shared by the resources. */
export function sharedFile(context: NestContext): GeneratedFile | null {
  const { spec } = context
  if (spec.enums.length === 0 && spec.objects.length === 0) return null
  const imports = new TsImports()
  const blocks: string[] = []
  for (const item of spec.enums) {
    const constant = enumConstant(item.name)
    blocks.push(
      lines(
        `/** Values of ${item.name}. */`,
        `export const ${constant} = [${item.values.map((value) => tsLiteral(value)).join(', ')}] as const`,
        `export type ${tsType(item.name)} = (typeof ${constant})[number]`,
      ),
    )
  }
  // Classes must exist before a decorator refers to them: holders after what they hold
  const ordered: typeof spec.objects = []
  const visit = (object: (typeof spec.objects)[number], seen: Set<string>) => {
    if (ordered.includes(object) || seen.has(object.name)) return
    for (const field of object.fields) {
      const inner =
        field.type.kind === 'object'
          ? field.type.name
          : field.type.kind === 'array' && field.type.items.kind === 'object'
            ? field.type.items.name
            : null
      const target = inner ? spec.objects.find((item) => item.name === inner) : undefined
      if (target) visit(target, new Set([...seen, object.name]))
    }
    ordered.push(object)
  }
  for (const object of spec.objects) visit(object, new Set())
  for (const object of ordered) {
    const properties = object.fields.map((field) => property(context, field, 'object', imports, SHARED))
    blocks.push(
      lines(
        `/** ${object.description ?? `${object.name}, embedded in the resources that hold it.`} */`,
        `export class ${tsType(object.name)}Dto {`,
        properties.join('\n\n'),
        '}',
      ),
    )
  }
  const content = lines(tsDoc('Enums and embedded objects shared by the resources.'), '', imports.render(), '', blocks.join('\n\n'))
  return { path: SHARED, content: fileText(content) }
}

/** Creation and update bodies, record and response of a resource. */
export function dtoFile(context: NestContext, resource: SpecResource): GeneratedFile {
  const path = resourcePath(resource, 'dto')
  const name = names(resource)
  const imports = new TsImports()
  const create = shapeFields(resource.fields, 'create').map((field) => property(context, field, 'create', imports, path))
  const update = shapeFields(resource.fields, 'update').map((field) => property(context, field, 'update', imports, path))
  const server = resource.fields.filter((field) => field.access === 'readOnly')
  const hidden = resource.fields.filter((field) => field.access === 'writeOnly')
  for (const field of server)
    if (field.type.kind === 'enum' || field.type.kind === 'object') imports.addType(importPath(path, SHARED), tsTypeOf(field.type))
  const serverType = server.map(
    (field) => `  ${tsProperty(field.wire)}: ${tsTypeOf(field.type)}${field.nullable || field.server === 'pending' ? ' | null' : ''}`,
  )
  const content = lines(
    tsDoc(`Request and response shapes of ${resource.plural}.`),
    '',
    imports.render(),
    '',
    resource.todo && [`// TODO: ${resource.todo}`, ''],
    `/** Body of a request that creates or replaces ${article(resource.singular)}. */`,
    `export class ${name.create} {`,
    create.join('\n\n'),
    '}',
    '',
    `/** Body of a request that changes part of ${article(resource.singular)}: only the fields sent change. */`,
    `export class ${name.update} {`,
    update.join('\n\n'),
    '}',
    '',
    `/** ${capitalize(article(resource.singular))} as the repositories keep it: what clients send and what the server fills. */`,
    server.length > 0
      ? [`export type ${name.record} = ${name.create} & {`, serverType, '}']
      : `export type ${name.record} = ${name.create}`,
    '',
    `/** ${capitalize(article(resource.singular))} as the API returns it. */`,
    hidden.length > 0
      ? `export type ${name.type} = Omit<${name.record}, ${hidden.map((field) => tsString(field.wire)).join(' | ')}>`
      : `export type ${name.type} = ${name.record}`,
    '',
    `/** The response of a stored ${resource.singular}. */`,
    hidden.length === 0
      ? [`export function ${name.toResponse}(record: ${name.record}): ${name.type} {`, '  return { ...record }', '}']
      : [
          `export function ${name.toResponse}(record: ${name.record}): ${name.type} {`,
          `  const { ${hidden.map((field, index) => `${tsProperty(field.wire)}: _hidden${index}`).join(', ')}, ...response } = record`,
          '  return response',
          '}',
        ],
  )
  return { path, content: fileText(content) }
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
