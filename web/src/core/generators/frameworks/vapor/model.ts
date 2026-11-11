/**
 * Data types of the Vapor project: the domain struct of each resource, the enums and embedded objects, the request
 * bodies and the responses. Request bodies and embedded objects carry their rules, which the API checks on the
 * JSON before it decodes it (Common/Body.swift): a missing field is told from one sent as null, unknown fields are
 * rejected and every problem is reported with its field.
 */
import type { SpecField, SpecObject, SpecResource, SpecType } from '../../../api/spec.ts'
import { alwaysInResponse, shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { swDoc, swHeader, swName, swString, swType, swTypeOf } from '../../languages/swift/swift.ts'
import { PATTERNS } from '../axum/model.ts'
import { article, capitalize, keyType, names, property, sourcePath, typeNames, type VaporContext } from './context.ts'

function target(context: VaporContext, name: string): SpecResource {
  return context.spec.resources.find((item) => item.name === name)!
}

/** The Swift type of a field, without `?`: keys and references use the key's type. */
export function fieldType(context: VaporContext, field: SpecField, resource?: SpecResource): string {
  if (resource && field.name === resource.key.field) return keyType(resource)
  if (field.reference) {
    const key = keyType(target(context, field.reference))
    return field.type.kind === 'array' ? `[${key}]` : key
  }
  return swTypeOf(field.type, typeNames)
}

/** The value of a field as JSON writes it: UUIDs in lower case. */
export function encodedValue(context: VaporContext, field: SpecField, value: string, resource?: SpecResource): string {
  const type = fieldType(context, field, resource)
  if (resource && field.name === resource.key.field) return type === 'UUID' ? `${value}.uuidString.lowercased()` : value
  if (type === 'UUID') return `jsonUUID(${value})`
  if (type === '[UUID]') return `jsonUUIDs(${value})`
  return value
}

/** The kind of JSON value a field holds, as `Checks` names it, or null when any value goes. */
function jsonKind(context: VaporContext, field: SpecField): string | null {
  if (field.reference) {
    if (field.type.kind === 'array') return 'list'
    return target(context, field.reference).key.type.scalar === 'integer' ? 'whole' : 'text'
  }
  const type = field.type
  switch (type.kind) {
    case 'array':
      return 'list'
    case 'map':
    case 'object':
      return 'object'
    case 'enum':
      return context.spec.enums.find((item) => item.name === type.name)?.valueType === 'integer' ? 'whole' : 'text'
    case 'scalar':
      if (type.scalar === 'integer') return 'whole'
      if (type.scalar === 'float' || type.scalar === 'decimal') return 'number'
      if (type.scalar === 'boolean') return 'boolean'
      if (type.scalar === 'any') return null
      return 'text'
  }
}

const option = (value: number | undefined) => (value === undefined ? 'nil' : String(value))

/** The Swift statements that check a field of a body or an embedded object on its JSON. */
function fieldRules(context: VaporContext, field: SpecField, required: boolean): string[] {
  const wire = swString(field.wire)
  const c = field.constraints
  const rules: string[] = []
  if (required) rules.push(`checks.required(json, ${wire})`)
  if (!field.nullable) rules.push(`checks.notNull(json, ${wire})`)
  const kind = jsonKind(context, field)
  if (kind) rules.push(`checks.kind(json, ${wire}, .${kind})`)
  if (field.reference) return rules
  const type = field.type
  const text = type.kind === 'scalar' && type.scalar === 'string'
  if (text && (c.minLength !== undefined || c.maxLength !== undefined))
    rules.push(`checks.length(json, ${wire}, min: ${option(c.minLength)}, max: ${option(c.maxLength)})`)
  if (type.kind === 'array' && (c.minItems !== undefined || c.maxItems !== undefined))
    rules.push(`checks.count(json, ${wire}, min: ${option(c.minItems)}, max: ${option(c.maxItems)})`)
  if (type.kind === 'scalar' && ['integer', 'float', 'decimal'].includes(type.scalar)) {
    const bound = (inclusive?: number, exclusive?: number, lower = true) => {
      if (exclusive !== undefined && (inclusive === undefined || (lower ? exclusive >= inclusive : exclusive <= inclusive)))
        return { value: String(exclusive), exclusive: true }
      return inclusive !== undefined ? { value: String(inclusive), exclusive: false } : null
    }
    const low = bound(c.minimum, c.exclusiveMinimum, true)
    const high = bound(c.maximum, c.exclusiveMaximum, false)
    if (low || high)
      rules.push(
        `checks.range(json, ${wire}, min: ${low?.value ?? 'nil'}, max: ${high?.value ?? 'nil'}, minExclusive: ${low?.exclusive ?? false}, maxExclusive: ${high?.exclusive ?? false})`,
      )
  }
  const pattern = (regex: string) => rules.push(`checks.pattern(json, ${wire}, ${swString(regex)})`)
  if (text && c.pattern) pattern(c.pattern)
  if (text && c.format === 'email') rules.push(`checks.email(json, ${wire})`)
  else if (text && c.format && PATTERNS[c.format]) pattern(PATTERNS[c.format])
  if (type.kind === 'scalar') {
    const formats: Record<string, string> = {
      time: 'time',
      duration: 'duration',
      binary: 'binary',
      uuid: 'uuid',
      date: 'date',
      datetime: 'date-time',
    }
    if (formats[type.scalar]) pattern(PATTERNS[formats[type.scalar]])
  }
  const inner = (item: SpecType) =>
    item.kind === 'object' && context.spec.objects.some((object) => object.name === item.name) ? swType(item.name) : null
  if (type.kind === 'object' && inner(type)) rules.push(`checks.nested(json, ${wire}, ${inner(type)}.rules)`)
  if (type.kind === 'array' && inner(type.items)) rules.push(`checks.each(json, ${wire}, ${inner(type.items)}.rules)`)
  return rules
}

/** The `rules` function of a body or an embedded object: its fields, and nothing else. */
function rulesFunction(context: VaporContext, fields: SpecField[], required: (field: SpecField) => boolean): string[] {
  return [
    '    /// What the body must meet, checked on its JSON before it is decoded.',
    '    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {',
    `        checks.only(json, [${fields.map((field) => swString(field.wire)).join(', ')}])`,
    ...fields.flatMap((field) => fieldRules(context, field, required(field))).map((rule) => `        ${rule}`),
    '    }',
  ]
}

/** The coding keys of a type: each property with its JSON name. */
function codingKeys(fields: SpecField[]): string[] {
  return [
    '    enum CodingKeys: String, CodingKey {',
    ...fields.map((field) => {
      const name = property(field)
      return name.replace(/`/g, '') === field.wire ? `        case ${name}` : `        case ${name} = ${swString(field.wire)}`
    }),
    '    }',
  ]
}

/** The `encode(to:)` of a type: optional fields without a value are left out, unless the contract always has them. */
function encodeFunction(context: VaporContext, fields: SpecField[], source: string, resource?: SpecResource): string[] {
  return [
    '    func encode(to encoder: any Encoder) throws {',
    fields.length > 0
      ? '        var container = encoder.container(keyedBy: CodingKeys.self)'
      : '        _ = encoder.container(keyedBy: CodingKeys.self)',
    ...fields.map((field) => {
      const value = encodedValue(context, field, `${source}${property(field)}`, resource)
      const always = (resource && field.name === resource.key.field) || alwaysInResponse(field)
      return `        try container.${always ? 'encode' : 'encodeIfPresent'}(${value}, forKey: .${property(field)})`
    }),
    '    }',
  ]
}

/** The case of each value of an enum, unique within it. */
export function enumCases(values: (string | number)[]): string[] {
  const used = new Set<string>()
  return values.map((value) => {
    const base = swName(String(value))
    let name = base
    for (let n = 2; used.has(name); n++) name = base.startsWith('`') ? `\`${base.slice(1, -1)}${n}\`` : `${base}${n}`
    used.add(name)
    return name
  })
}

function enumFile(context: VaporContext, enumName: string): GeneratedFile {
  const item = context.spec.enums.find((entry) => entry.name === enumName)!
  const name = swType(item.name)
  const integer = item.valueType === 'integer'
  const cases = enumCases(item.values)
  const content = lines(
    ...swHeader(`Values of ${item.name}.`, []),
    swDoc(`Values of ${item.name}, with the value each one has in JSON.`),
    `enum ${name}: ${integer ? 'Int64' : 'String'}, Codable, Sendable, CaseIterable, Comparable {`,
    item.values.map((value, index) => `    case ${cases[index]} = ${integer ? String(value) : swString(String(value))}`),
    '',
    `    static func < (lhs: ${name}, rhs: ${name}) -> Bool {`,
    '        lhs.rawValue < rhs.rawValue',
    '    }',
    '}',
  )
  return { path: sourcePath(context.layout.shared, name), content: fileText(content) }
}

function objectFile(context: VaporContext, object: SpecObject): GeneratedFile {
  const name = swType(object.name)
  const content = lines(
    ...swHeader(`${object.name}, embedded in the resources that hold it.`, ['Foundation']),
    swDoc(object.description ?? `${object.name}, embedded in the resources that hold it.`),
    `struct ${name}: Codable, Sendable, Equatable {`,
    object.fields.map((field) =>
      lines(field.todo && `    // TODO: ${field.todo}`, `    var ${property(field)}: ${fieldType(context, field)}?`),
    ),
    '',
    codingKeys(object.fields),
    '',
    encodeFunction(context, object.fields, ''),
    '',
    rulesFunction(context, object.fields, (field) => field.required),
    '}',
  )
  return { path: sourcePath(context.layout.shared, name), content: fileText(content) }
}

/** Enums and embedded objects shared by the resources. */
export function sharedFiles(context: VaporContext): GeneratedFile[] {
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

/** The value a new item has in its key before it is stored. */
export function emptyKey(resource: SpecResource): string {
  const type = keyType(resource)
  return type === 'Int64' ? '0' : type === 'UUID' ? 'UUID()' : '""'
}

/** The domain struct of a resource: every field, the ones clients never read included. */
export function domainFile(context: VaporContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const fields = resource.fields.map((field) => {
    const type = fieldType(context, field, resource)
    const key = field.name === resource.key.field
    return lines(
      field.todo && `    // TODO: ${field.todo}`,
      `    var ${property(field)}: ${key ? `${type} = ${emptyKey(resource)}` : `${type}?`}`,
    )
  })
  const description = `${capitalize(article(resource.singular))} as the service and its storage handle it.`
  const content = lines(
    ...swHeader(description, ['Foundation']),
    resource.todo && `// TODO: ${resource.todo}`,
    swDoc(description),
    `struct ${name.type}: Sendable, Equatable {`,
    fields,
    '}',
  )
  return { path: sourcePath(context.layout.resource(resource, 'model'), name.type), content: fileText(content) }
}

/** Request bodies and response of a resource, in one file. */
export function dtoFile(context: VaporContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const writes = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const body = (shape: 'create' | 'update') => {
    const fields = shapeFields(resource.fields, shape)
    return [
      swDoc(
        shape === 'create'
          ? `Body of a request that creates or replaces ${article(resource.singular)}.`
          : `Body of a request that changes part of ${article(resource.singular)}: only the fields sent change.`,
      ),
      `struct ${shape === 'create' ? name.create : name.update}: Decodable, Sendable {`,
      fields.map((field) => `    var ${property(field)}: ${fieldType(context, field, resource)}?`),
      '',
      codingKeys(fields),
      '',
      rulesFunction(context, fields, (field) => shape === 'create' && field.required),
      '}',
      '',
    ]
  }
  const read = shapeFields(resource.fields, 'read')
  const content = lines(
    ...swHeader(`Request bodies and responses of ${resource.plural}.`, ['Foundation']),
    writes && [body('create'), body('update')],
    swDoc(`${capitalize(article(resource.singular))} as the API returns it: everything but what clients only send.`),
    `struct ${name.response}: Encodable, Sendable {`,
    `    let item: ${name.type}`,
    '',
    `    init(_ item: ${name.type}) {`,
    '        self.item = item',
    '    }',
    '',
    codingKeys(read),
    '',
    encodeFunction(context, read, 'item.', resource),
    '}',
  )
  return { path: sourcePath(context.layout.resource(resource, 'dto'), `${name.type}DTOs`), content: fileText(content) }
}
