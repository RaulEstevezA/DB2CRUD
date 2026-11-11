/**
 * Data classes of the ASP.NET Core project: the domain class of each resource (an Entity Framework Core
 * entity when EF Core is chosen), the enums and embedded objects, the request bodies (which remember which
 * fields were sent, to tell a missing field from an explicit null) and the response records.
 */
import type { SpecField, SpecObject, SpecResource } from '../../../api/spec.ts'
import { alwaysInResponse, shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { CsUsings, csClass, csDoc, csHeader, csNumber, csPascal, csString, csType } from '../../languages/csharp/csharp.ts'
import {
  article,
  capitalize,
  commonNamespace,
  keyType,
  names,
  namespaceOf,
  property,
  sharedNames,
  sourcePath,
  type AspNetContext,
} from './context.ts'

/** Patterns of the text formats .NET has no attribute for, as in the other generators. */
export const PATTERNS: Record<string, string> = {
  uri: '^[a-zA-Z][a-zA-Z0-9+.-]*://\\S+$',
  uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  date: '^\\d{4}-\\d{2}-\\d{2}$',
  'date-time': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$',
  time: '^\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$',
  duration: '^P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+(\\.\\d+)?S)?)?$',
}

/**
 * The C# type of a field: keys and references to keys use the key's type, whole numbers as `long`.
 *
 * @param nullable Whether the key itself may be null (in a request body it may be missing).
 */
export function fieldType(context: AspNetContext, field: SpecField, usings: CsUsings, resource?: SpecResource, nullable = true): string {
  if (resource && field.name === resource.key.field) return `${keyType(resource)}${nullable ? '?' : ''}`
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    return field.type.kind === 'array' ? `List<${keyType(target)}>?` : `${keyType(target)}?`
  }
  return csType(field.type, usings, sharedNames(context))
}

/** A bound of a range: its value and whether the value itself is out. */
interface Bound {
  value: number
  exclusive: boolean
}

function lowerBound(minimum?: number, exclusive?: number): Bound | null {
  if (exclusive !== undefined && (minimum === undefined || exclusive >= minimum)) return { value: exclusive, exclusive: true }
  return minimum !== undefined ? { value: minimum, exclusive: false } : null
}

function upperBound(maximum?: number, exclusive?: number): Bound | null {
  if (exclusive !== undefined && (maximum === undefined || exclusive <= maximum)) return { value: exclusive, exclusive: true }
  return maximum !== undefined ? { value: maximum, exclusive: false } : null
}

/** Validation attributes of a field's declared validations (DataAnnotations, and Pattern from Common). */
export function validations(context: AspNetContext, field: SpecField, usings: CsUsings): string[] {
  const c = field.constraints
  const result: string[] = []
  const annotations = () => usings.add('System.ComponentModel.DataAnnotations')
  const pattern = (regex: string) => {
    usings.add(commonNamespace(context))
    result.push(`[Pattern(${csString(regex)})]`)
  }
  const type = field.reference ? null : field.type
  const text = type?.kind === 'scalar' && type.scalar === 'string'
  const list = field.type.kind === 'array'
  const min = list ? c.minItems : text ? c.minLength : undefined
  const max = list ? c.maxItems : text ? c.maxLength : undefined
  if (min !== undefined) {
    annotations()
    result.push(`[MinLength(${min})]`)
  }
  if (max !== undefined) {
    annotations()
    result.push(`[MaxLength(${max})]`)
  }
  if (type?.kind === 'scalar' && ['integer', 'float', 'decimal'].includes(type.scalar)) {
    const low = lowerBound(c.minimum, c.exclusiveMinimum)
    const high = upperBound(c.maximum, c.exclusiveMaximum)
    if (low || high) {
      annotations()
      const options = [low?.exclusive && 'MinimumIsExclusive = true', high?.exclusive && 'MaximumIsExclusive = true'].filter(Boolean)
      const bounds = [low ? csNumber(low.value, 'double') : 'double.MinValue', high ? csNumber(high.value, 'double') : 'double.MaxValue']
      result.push(`[Range(${[...bounds, ...options].join(', ')})]`)
    }
  }
  if (text && c.pattern) pattern(c.pattern)
  if (text && c.format === 'email') {
    annotations()
    result.push('[EmailAddress]')
  } else if (text && c.format && PATTERNS[c.format]) pattern(PATTERNS[c.format])
  if (type?.kind === 'scalar' && (type.scalar === 'time' || type.scalar === 'duration')) pattern(PATTERNS[type.scalar])
  return result
}

/** The JSON name of a property; optional ones are left out of answers when they have no value. */
function jsonAttributes(field: SpecField, usings: CsUsings, optional: boolean): string[] {
  usings.add('System.Text.Json.Serialization')
  return [
    `[JsonPropertyName(${csString(field.wire)})]`,
    optional ? '[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]' : null,
  ].filter((item): item is string => item !== null)
}

/** The C# members of an enum: PascalCase names, unique, never the name of the enum. */
function enumMembers(name: string, values: (string | number)[]): string[] {
  const used = new Set<string>()
  return values.map((value) => {
    let base = csPascal(String(value))
    if (base.startsWith('_')) base = `Value${base.slice(1)}`
    if (base === name) base = `${base}Value`
    let member = base
    for (let n = 2; used.has(member); n++) member = `${base}${n}`
    used.add(member)
    return member
  })
}

/** The member of an enum value, as `enumMembers` names it. */
export function enumMember(context: AspNetContext, enumName: string, value: string | number): string {
  const item = context.spec.enums.find((entry) => entry.name === enumName)!
  return enumMembers(csClass(item.name), item.values)[item.values.indexOf(value)]
}

function enumFile(context: AspNetContext, enumName: string): GeneratedFile {
  const item = context.spec.enums.find((entry) => entry.name === enumName)!
  const relative = context.layout.shared()
  const namespace = namespaceOf(context, relative)
  const name = csClass(item.name)
  const integer = item.valueType === 'integer'
  const usings = new CsUsings(namespace).add('System.Text.Json.Serialization', commonNamespace(context))
  const members = enumMembers(name, item.values).map((member, index) => {
    const value = item.values[index]
    return integer ? `    ${member} = ${value},` : `    [JsonStringEnumMemberName(${csString(String(value))})]\n    ${member},`
  })
  const content = lines(
    ...csHeader(namespace, usings),
    csDoc(`Values of ${item.name}, with the value each one has in JSON.`),
    `[JsonConverter(typeof(${integer ? 'NumberEnumConverter' : 'TextEnumConverter'}<${name}>))]`,
    `public enum ${name}`,
    '{',
    integer ? members : members.join('\n\n'),
    '}',
  )
  return { path: sourcePath(context, relative, name), content: fileText(content) }
}

/** Presence checks of a request body: the fields it must carry, and the ones that cannot be null. */
function presenceChecks(fields: SpecField[], owner: string, required: (field: SpecField) => boolean): string[] {
  const mustHave = fields.filter(required).map((field) => csString(field.wire))
  const notNull = fields.filter((field) => !field.nullable).map((field) => `(${csString(field.wire)}, ${property(field, owner)})`)
  return [
    mustHave.length > 0 && ['', `    protected override string[] RequiredFields => [${mustHave.join(', ')}];`],
    notNull.length > 0 && [
      '',
      `    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [${notNull.join(', ')}];`,
    ],
  ].flatMap((item) => (item ? item : [])) as string[]
}

/** A property of a request body that records that it was sent. */
function trackedProperty(context: AspNetContext, field: SpecField, owner: string, type: string, usings: CsUsings, optional: boolean) {
  const attributes = [...jsonAttributes(field, usings, optional), ...validations(context, field, usings)]
  return lines(
    field.todo && `    // TODO: ${field.todo}`,
    attributes.map((attribute) => `    ${attribute}`),
    `    public ${type} ${property(field, owner)} { get; set { field = value; Mark(${csString(field.wire)}); } }`,
  )
}

function objectFile(context: AspNetContext, object: SpecObject): GeneratedFile {
  const relative = context.layout.shared()
  const namespace = namespaceOf(context, relative)
  const name = csClass(object.name)
  const usings = new CsUsings(namespace).add(commonNamespace(context))
  const properties = object.fields.map((field) =>
    trackedProperty(context, field, name, fieldType(context, field, usings), usings, !alwaysInResponse(field)),
  )
  const content = lines(
    ...csHeader(namespace, usings),
    csDoc(object.description ?? `${object.name}, embedded in the resources that hold it.`),
    `public sealed class ${name} : Payload`,
    '{',
    properties.join('\n\n'),
    presenceChecks(object.fields, name, (field) => field.required),
    '}',
  )
  return { path: sourcePath(context, relative, name), content: fileText(content) }
}

/** Enums and embedded objects shared by the resources. */
export function sharedFiles(context: AspNetContext): GeneratedFile[] {
  return [
    ...context.spec.enums.map((item) => enumFile(context, item.name)),
    ...context.spec.objects.map((object) => objectFile(context, object)),
  ]
}

/** Whether a field is stored as JSON in a table: embedded objects, lists, maps and values of any shape. */
export function storedAsJson(field: SpecField): boolean {
  return (
    field.type.kind === 'object' ||
    field.type.kind === 'array' ||
    field.type.kind === 'map' ||
    (field.type.kind === 'scalar' && field.type.scalar === 'any')
  )
}

/** The domain class of a resource: every field, the ones clients never read included. */
export function domainFile(context: AspNetContext, resource: SpecResource): GeneratedFile {
  const relative = context.layout.resource(resource, 'model')
  const namespace = namespaceOf(context, relative)
  const usings = new CsUsings(namespace)
  const name = names(resource)
  const properties = resource.fields.map((field) => {
    const isKey = field.name === resource.key.field
    const type = fieldType(context, field, usings, resource, false)
    const initial = isKey && type === 'string' ? ' = "";' : ''
    return lines(field.todo && `    // TODO: ${field.todo}`, `    public ${type} ${property(field, name.type)} { get; set; }${initial}`)
  })
  const content = lines(
    ...csHeader(namespace, usings),
    resource.todo && `// TODO: ${resource.todo}`,
    csDoc(`${capitalize(article(resource.singular))} as the service and its storage handle it.`),
    `public class ${name.type}`,
    '{',
    properties.join('\n\n'),
    '}',
  )
  return { path: sourcePath(context, relative, name.type), content: fileText(content) }
}

function payloadClass(context: AspNetContext, resource: SpecResource, shape: 'create' | 'update'): GeneratedFile {
  const relative = context.layout.resource(resource, 'dto')
  const namespace = namespaceOf(context, relative)
  const usings = new CsUsings(namespace).add(commonNamespace(context))
  const name = names(resource)
  const className = shape === 'create' ? name.create : name.update
  const fields = shapeFields(resource.fields, shape)
  const properties = fields.map((field) =>
    trackedProperty(context, field, name.type, fieldType(context, field, usings, resource), usings, false),
  )
  const description =
    shape === 'create'
      ? `Body of a request that creates or replaces ${article(resource.singular)}.`
      : `Body of a request that changes part of ${article(resource.singular)}: only the fields sent change.`
  const content = lines(
    ...csHeader(namespace, usings),
    csDoc(description),
    `public sealed class ${className} : Payload`,
    '{',
    properties.join('\n\n'),
    presenceChecks(fields, name.type, (field) => shape === 'create' && field.required),
    '}',
  )
  return { path: sourcePath(context, relative, className), content: fileText(content) }
}

/** The response record of a resource and how it is built from the domain class. */
function responseFile(context: AspNetContext, resource: SpecResource): GeneratedFile {
  const relative = context.layout.resource(resource, 'dto')
  const namespace = namespaceOf(context, relative)
  const name = names(resource)
  const usings = new CsUsings(namespace).add(namespaceOf(context, context.layout.resource(resource, 'model')))
  const fields = shapeFields(resource.fields, 'read')
  const parameters = fields.map((field) => {
    // An optional field without a value is left out of the JSON, as the contract allows
    const attributes = jsonAttributes(field, usings, !alwaysInResponse(field)).map((attribute) => attribute.slice(1, -1))
    return `    [property: ${attributes.join(', ')}] ${fieldType(context, field, usings, resource, false)} ${property(field, name.type)}`
  })
  const content = lines(
    ...csHeader(namespace, usings),
    csDoc(`${capitalize(article(resource.singular))} as the API returns it.`),
    `public sealed record ${name.response}(`,
    parameters.join(',\n'),
    ')',
    '{',
    `    /// <summary>The response of a stored ${resource.singular}: everything but what clients only send.</summary>`,
    `    public static ${name.response} From(${name.type} item) =>`,
    `        new(${fields.map((field) => `item.${property(field, name.type)}`).join(', ')});`,
    '}',
  )
  return { path: sourcePath(context, relative, name.response), content: fileText(content) }
}

/** Request bodies and response of a resource. */
export function dtoFiles(context: AspNetContext, resource: SpecResource): GeneratedFile[] {
  const files = [responseFile(context, resource)]
  if (resource.endpoints.some((endpoint) => endpoint.input !== 'none'))
    files.push(payloadClass(context, resource, 'create'), payloadClass(context, resource, 'update'))
  return files
}
