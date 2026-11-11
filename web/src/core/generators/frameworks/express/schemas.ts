/**
 * Zod schemas and TypeScript types of the Express project: enums and embedded objects shared by the
 * resources, and for each resource its creation and partial update schemas, the record the repositories
 * keep and the response the API returns. They follow the shapes of the OpenAPI contract field by field.
 */
import type { SpecField, SpecObject, SpecResource, SpecType } from '../../../api/spec.ts'
import { shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { TsImports, tsDoc, tsLiteral, tsProperty, tsString, tsType } from '../../languages/typescript/typescript.ts'
import { importPath, names, type ExpressContext } from './context.ts'

/** The Zod schema of a type, before its validations and nullability. */
function zodType(type: SpecType, field: SpecField | null, used: Set<string>, lazy: Set<string>): string {
  switch (type.kind) {
    case 'scalar': {
      const format = field?.constraints.format
      switch (type.scalar) {
        case 'string':
          if (format === 'email') return 'z.email()'
          if (format === 'uri') return 'z.url()'
          if (format === 'uuid') return 'z.uuid()'
          if (format === 'date') return 'z.iso.date()'
          if (format === 'date-time') return 'z.iso.datetime({ offset: true })'
          if (format === 'time') return 'z.iso.time()'
          return 'z.string()'
        case 'integer':
          return 'z.number().int()'
        case 'float':
        case 'decimal':
          return 'z.number()'
        case 'boolean':
          return 'z.boolean()'
        case 'date':
          return 'z.iso.date()'
        case 'datetime':
          return 'z.iso.datetime({ offset: true })'
        case 'time':
          return 'z.iso.time()'
        case 'duration':
          return 'z.iso.duration()'
        case 'uuid':
          return 'z.uuid()'
        case 'binary':
          return 'z.base64()'
        case 'any':
          return 'z.unknown()'
      }
      return 'z.unknown()'
    }
    case 'array':
      return `z.array(${zodType(type.items, null, used, lazy)})`
    case 'map':
      return `z.record(z.string(), ${zodType(type.value, null, used, lazy)})`
    case 'object':
    case 'enum': {
      const name = tsType(type.name)
      used.add(name)
      return lazy.has(type.name) ? `z.lazy(() => ${name})` : name
    }
  }
}

/** The validations a field declares, as chained Zod checks. */
function checks(field: SpecField): string {
  const c = field.constraints
  const parts: string[] = []
  const text = field.type.kind === 'scalar' && field.type.scalar === 'string'
  const list = field.type.kind === 'array'
  const number = field.type.kind === 'scalar' && ['integer', 'float', 'decimal'].includes(field.type.scalar)
  if (text || list) {
    const min = list ? c.minItems : c.minLength
    const max = list ? c.maxItems : c.maxLength
    if (min !== undefined) parts.push(`.min(${min})`)
    if (max !== undefined) parts.push(`.max(${max})`)
  }
  if (text && c.pattern !== undefined) parts.push(`.regex(new RegExp(${tsString(c.pattern)}))`)
  if (number) {
    if (c.minimum !== undefined) parts.push(`.min(${c.minimum})`)
    if (c.maximum !== undefined) parts.push(`.max(${c.maximum})`)
    if (c.exclusiveMinimum !== undefined) parts.push(`.gt(${c.exclusiveMinimum})`)
    if (c.exclusiveMaximum !== undefined) parts.push(`.lt(${c.exclusiveMaximum})`)
  }
  return parts.join('')
}

type Shape = 'create' | 'update' | 'object'

/** The Zod schema of a field in one shape: required, defaulted or optional, nullable or not. */
function fieldSchema(field: SpecField, shape: Shape, used: Set<string>, lazy: Set<string>): string {
  let schema = zodType(field.type, field, used, lazy) + checks(field)
  if (field.nullable) schema += '.nullable()'
  if (shape === 'update') return `${schema}.optional()`
  if (field.required) return schema
  if (field.defaultValue !== undefined) return `${schema}.default(${tsLiteral(field.defaultValue)})`
  return `${schema}.optional()`
}

/** The TypeScript type of an API type, for records and responses. */
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
    case 'enum':
      return tsType(type.name)
  }
}

function objectBlock(fields: SpecField[], shape: Shape, used: Set<string>, lazy: Set<string>): string {
  const entries = fields.map((field) => {
    const todo = field.todo ? `  // TODO: ${field.todo}\n` : ''
    return `${todo}  ${tsProperty(field.wire)}: ${fieldSchema(field, shape, used, lazy)},`
  })
  return entries.length > 0 ? `z.strictObject({\n${entries.join('\n')}\n})` : 'z.strictObject({})'
}

/** Objects ordered so each is declared after the objects it holds; the ones in a cycle are read lazily. */
function orderObjects(objects: SpecObject[]): { ordered: SpecObject[]; lazy: Set<string> } {
  const ordered: SpecObject[] = []
  const lazy = new Set<string>()
  const state = new Map<string, 'visiting' | 'done'>()
  const inner = (type: SpecType): string[] =>
    type.kind === 'object' ? [type.name] : type.kind === 'array' ? inner(type.items) : type.kind === 'map' ? inner(type.value) : []
  function visit(object: SpecObject) {
    if (state.get(object.name) === 'done') return
    state.set(object.name, 'visiting')
    for (const field of object.fields) {
      for (const name of inner(field.type)) {
        const target = objects.find((item) => item.name === name)
        if (!target) continue
        if (state.get(name) === 'visiting') lazy.add(name)
        else visit(target)
      }
    }
    state.set(object.name, 'done')
    ordered.push(object)
  }
  for (const object of objects) visit(object)
  return { ordered, lazy }
}

/** The shared module: enums and embedded objects. */
export function sharedFile(context: ExpressContext): GeneratedFile | null {
  const { spec } = context
  if (spec.enums.length === 0 && spec.objects.length === 0) return null
  const blocks: string[] = []
  for (const item of spec.enums) {
    const name = tsType(item.name)
    const schema =
      item.valueType === 'string'
        ? `z.enum([${item.values.map((value) => tsString(String(value))).join(', ')}])`
        : `z.union([${item.values.map((value) => `z.literal(${value})`).join(', ')}])`
    blocks.push(
      lines(`/** Values of ${item.name}. */`, `export const ${name} = ${schema}`, `export type ${name} = z.infer<typeof ${name}>`),
    )
  }
  const { ordered, lazy } = orderObjects(spec.objects)
  for (const object of ordered) {
    const name = tsType(object.name)
    const used = new Set<string>()
    const annotation = lazy.has(object.name) ? `: z.ZodType<${name}>` : ''
    blocks.push(
      lines(
        `/** ${object.description ?? `${object.name}, embedded in the resources that hold it.`} */`,
        `export const ${name}${annotation} = ${objectBlock(object.fields, 'object', used, lazy)}`,
        lazy.has(object.name)
          ? `export interface ${name} {\n${object.fields.map((field) => `  ${tsProperty(field.wire)}${field.required ? '' : '?'}: ${tsTypeOf(field.type)}${field.nullable ? ' | null' : ''}`).join('\n')}\n}`
          : `export type ${name} = z.infer<typeof ${name}>`,
      ),
    )
  }
  const content = lines(
    tsDoc('Enums and embedded objects shared by the resources.'),
    '',
    "import { z } from 'zod'",
    '',
    blocks.join('\n\n'),
  )
  return { path: context.layout.shared(), content: fileText(content) }
}

/** Creation and update schemas, record and response of a resource. */
export function resourceSchemasFile(context: ExpressContext, resource: SpecResource): GeneratedFile {
  const path = context.layout.resource(resource, 'schemas')
  const name = names(resource)
  const used = new Set<string>()
  const lazy = new Set<string>()
  const create = objectBlock(shapeFields(resource.fields, 'create'), 'create', used, lazy)
  const update = objectBlock(shapeFields(resource.fields, 'update'), 'update', used, lazy)
  const server = resource.fields.filter((field) => field.access === 'readOnly')
  const serverType = server.map(
    (field) => `  ${tsProperty(field.wire)}: ${tsTypeOf(field.type)}${field.nullable || field.server === 'pending' ? ' | null' : ''}`,
  )
  const hidden = resource.fields.filter((field) => field.access === 'writeOnly')
  const imports = new TsImports().add('zod', 'z')
  for (const shared of used) imports.add(importPath(path, context.layout.shared()), shared)
  // The response leaves out what clients only send
  const toResponse =
    hidden.length === 0
      ? [`export function ${name.toResponse}(record: ${name.record}): ${name.type} {`, '  return record', '}']
      : [
          `export function ${name.toResponse}(record: ${name.record}): ${name.type} {`,
          `  const { ${hidden.map((field, index) => `${tsProperty(field.wire)}: _hidden${index}`).join(', ')}, ...response } = record`,
          '  return response',
          '}',
        ]
  const content = lines(
    tsDoc(`Request and response shapes of ${resource.plural}.`),
    '',
    imports.render(),
    '',
    resource.todo && [`// TODO: ${resource.todo}`, ''],
    `/** Body of a request that creates or replaces ${article(resource.singular)}. */`,
    `export const ${name.create} = ${create}`,
    `export type ${name.create} = z.infer<typeof ${name.create}>`,
    '',
    `/** Body of a request that changes part of ${article(resource.singular)}: only the fields sent change. */`,
    `export const ${name.update} = ${update}`,
    `export type ${name.update} = z.infer<typeof ${name.update}>`,
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
    toResponse,
  )
  return { path, content: fileText(content) }
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
