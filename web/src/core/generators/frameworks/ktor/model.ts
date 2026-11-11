/**
 * Data classes of the Ktor project: the domain class of each resource, the enums and embedded objects, the
 * request bodies and the responses. Request bodies and embedded objects carry their rules, which the API checks
 * on the JSON before it reads it (common/Bodies.kt): a missing field is told from one sent as null, and every
 * problem is reported with its field.
 */
import type { SpecField, SpecObject, SpecResource, SpecType } from '../../../api/spec.ts'
import { alwaysInResponse, shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { KtImports, ktClass, ktConstant, ktDoc, ktHeader, ktString, ktType } from '../../languages/kotlin/kotlin.ts'
import { article, capitalize, commonPackage, keyType, names, property, sourcePath, typeNames, type KtorContext } from './context.ts'

/** Patterns of the text formats JSON has no type for, as in the other generators. */
export const PATTERNS: Record<string, string> = {
  uri: '^[a-zA-Z][a-zA-Z0-9+.-]*://\\S+$',
  uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  date: '^\\d{4}-\\d{2}-\\d{2}$',
  'date-time': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$',
  time: '^\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$',
  duration: '^P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+(\\.\\d+)?S)?)?$',
  binary: '^[A-Za-z0-9+/]*={0,2}$',
}

/** The Kotlin type of a field, not null: keys and references use the key's type. */
export function fieldType(context: KtorContext, field: SpecField, imports: KtImports, resource?: SpecResource): string {
  const key = (target: SpecResource) => {
    const type = keyType(target)
    if (type === 'JsonUuid') imports.add(`${commonPackage(context)}.JsonUuid`)
    return type
  }
  if (resource && field.name === resource.key.field) return key(resource)
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    return field.type.kind === 'array' ? `List<${key(target)}>` : key(target)
  }
  return ktType(field.type, imports, typeNames(context))
}

/** The kind of JSON value a field holds, as `Checks` names it, or null when any value goes. */
function jsonKind(context: KtorContext, field: SpecField): string | null {
  if (field.reference) {
    if (field.type.kind === 'array') return 'LIST'
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    return target.key.type.scalar === 'integer' ? 'WHOLE' : 'TEXT'
  }
  const type = field.type
  switch (type.kind) {
    case 'array':
      return 'LIST'
    case 'map':
    case 'object':
      return 'OBJECT'
    case 'enum':
      return context.spec.enums.find((item) => item.name === type.name)?.valueType === 'integer' ? 'WHOLE' : 'TEXT'
    case 'scalar':
      if (type.scalar === 'integer') return 'WHOLE'
      if (type.scalar === 'float' || type.scalar === 'decimal') return 'NUMBER'
      if (type.scalar === 'boolean') return 'BOOLEAN'
      if (type.scalar === 'any') return null
      return 'TEXT'
  }
}

/** The Kotlin statements that check a field of a body or an embedded object on its JSON. */
function fieldRules(context: KtorContext, field: SpecField, required: boolean): string[] {
  const wire = ktString(field.wire)
  const c = field.constraints
  const rules: string[] = []
  if (required) rules.push(`checks.required(json, ${wire})`)
  if (!field.nullable) rules.push(`checks.notNull(json, ${wire})`)
  const kind = jsonKind(context, field)
  if (kind) rules.push(`checks.kind(json, ${wire}, JsonKind.${kind})`)
  if (field.reference) return rules
  const type = field.type
  const text = type.kind === 'scalar' && type.scalar === 'string'
  if (text && (c.minLength !== undefined || c.maxLength !== undefined))
    rules.push(`checks.length(json, ${wire}, ${c.minLength ?? 'null'}, ${c.maxLength ?? 'null'})`)
  if (type.kind === 'array' && (c.minItems !== undefined || c.maxItems !== undefined))
    rules.push(`checks.count(json, ${wire}, ${c.minItems ?? 'null'}, ${c.maxItems ?? 'null'})`)
  if (type.kind === 'scalar' && ['integer', 'float', 'decimal'].includes(type.scalar)) {
    const bound = (inclusive?: number, exclusive?: number, lower = true) => {
      if (exclusive !== undefined && (inclusive === undefined || (lower ? exclusive >= inclusive : exclusive <= inclusive)))
        return { value: ktString(String(exclusive)), exclusive: true }
      return inclusive !== undefined ? { value: ktString(String(inclusive)), exclusive: false } : null
    }
    const low = bound(c.minimum, c.exclusiveMinimum, true)
    const high = bound(c.maximum, c.exclusiveMaximum, false)
    if (low || high)
      rules.push(
        `checks.range(json, ${wire}, ${low?.value ?? 'null'}, ${high?.value ?? 'null'}, ${low?.exclusive ?? false}, ${high?.exclusive ?? false})`,
      )
  }
  const pattern = (regex: string) => rules.push(`checks.pattern(json, ${wire}, Regex(${ktString(regex)}))`)
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
    item.kind === 'object' && context.spec.objects.some((object) => object.name === item.name) ? ktClass(item.name) : null
  if (type.kind === 'object' && inner(type)) rules.push(`checks.nested(json, ${wire}, ${inner(type)}::rules)`)
  if (type.kind === 'array' && inner(type.items)) rules.push(`checks.each(json, ${wire}, ${inner(type.items)}::rules)`)
  return rules
}

/** The `rules` function of a body or an embedded object, in its companion object. */
function rulesFunction(context: KtorContext, fields: SpecField[], required: (field: SpecField) => boolean): string[] {
  const rules = fields.flatMap((field) => fieldRules(context, field, required(field)))
  return [
    '    companion object {',
    '        /** What the body must meet, checked on its JSON before it is read. */',
    `        fun rules(checks: Checks, json: JsonObject) {`,
    ...rules.map((rule) => `            ${rule}`),
    '        }',
    '    }',
  ]
}

/** `@SerialName("postal_code")` when the JSON name is not the Kotlin property. */
function serialName(field: SpecField, imports: KtImports): string | null {
  if (property(field) === field.wire) return null
  imports.add('kotlinx.serialization.SerialName')
  return `@SerialName(${ktString(field.wire)})`
}

/** A property of a serializable class: `@SerialName("x") val x: T? = null`. */
function serializableProperty(field: SpecField, type: string, imports: KtImports, defaultNull: boolean): string {
  const name = serialName(field, imports)
  return `    ${name ? `${name} ` : ''}val ${property(field)}: ${type}?${defaultNull ? ' = null' : ''},`
}

function enumFile(context: KtorContext, enumName: string): GeneratedFile {
  const item = context.spec.enums.find((entry) => entry.name === enumName)!
  const pkg = context.layout.shared()
  const name = ktClass(item.name)
  const integer = item.valueType === 'integer'
  const imports = new KtImports(pkg).add('kotlinx.serialization.Serializable')
  const used = new Set<string>()
  const entries = item.values.map((value) => {
    let constant = ktConstant(value)
    for (let n = 2; used.has(constant); n++) constant = `${ktConstant(value)}_${n}`
    used.add(constant)
    return { constant, value }
  })
  if (integer) imports.add(`${commonPackage(context)}.NumberEnumSerializer`)
  else imports.add('kotlinx.serialization.SerialName')
  const body = integer
    ? entries.map((entry, index) => `    ${entry.constant}(${entry.value}L)${index === entries.length - 1 ? ';' : ','}`)
    : entries.map(
        (entry, index) =>
          `    @SerialName(${ktString(String(entry.value))})\n    ${entry.constant}(${ktString(String(entry.value))})${index === entries.length - 1 ? ';' : ','}`,
      )
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc(`Values of ${item.name}, with the value each one has in JSON.`),
    integer ? `@Serializable(with = ${name}.Serializer::class)` : '@Serializable',
    `enum class ${name}(val value: ${integer ? 'Long' : 'String'}) {`,
    integer ? body : body.join('\n\n'),
    '',
    integer && [`    object Serializer : NumberEnumSerializer<${name}>(${ktString(name)}, entries, ${name}::value)`, ''],
    '    companion object {',
    '        /** The entry with this value in JSON, or null when none has it. */',
    `        fun fromValue(value: ${integer ? 'Long' : 'String'}): ${name}? = entries.firstOrNull { it.value == value }`,
    '    }',
    '}',
  )
  return { path: sourcePath(pkg, name), content: fileText(content) }
}

function objectFile(context: KtorContext, object: SpecObject): GeneratedFile {
  const pkg = context.layout.shared()
  const name = ktClass(object.name)
  const imports = new KtImports(pkg).add(
    'kotlinx.serialization.Serializable',
    'kotlinx.serialization.json.JsonObject',
    `${commonPackage(context)}.Checks`,
    `${commonPackage(context)}.JsonKind`,
  )
  const properties = object.fields.map((field) => serializableProperty(field, fieldType(context, field, imports), imports, true))
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc(object.description ?? `${object.name}, embedded in the resources that hold it.`),
    '@Serializable',
    `data class ${name}(`,
    properties,
    ') {',
    rulesFunction(context, object.fields, (field) => field.required),
    '}',
  )
  return { path: sourcePath(pkg, name), content: fileText(content) }
}

/** Enums and embedded objects shared by the resources. */
export function sharedFiles(context: KtorContext): GeneratedFile[] {
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
export function domainFile(context: KtorContext, resource: SpecResource): GeneratedFile {
  const pkg = context.layout.resource(resource, 'model')
  const imports = new KtImports(pkg)
  const name = names(resource)
  const properties = resource.fields.map((field) => {
    const type = fieldType(context, field, imports, resource)
    const todo = field.todo ? `    // TODO: ${field.todo}\n` : ''
    if (field.name !== resource.key.field) return `${todo}    var ${property(field)}: ${type}? = null,`
    // The key always has a value: the storage assigns it, or the client sends it
    const initial = type === 'Long' ? '0L' : type === 'String' ? '""' : 'JsonUuid(0L, 0L)'
    return `${todo}    var ${property(field)}: ${type} = ${initial},`
  })
  const content = lines(
    ...ktHeader(pkg, imports),
    resource.todo && `// TODO: ${resource.todo}`,
    ktDoc(`${capitalize(article(resource.singular))} as the service and its storage handle it.`),
    `data class ${name.type}(`,
    properties,
    ')',
  )
  return { path: sourcePath(pkg, name.type), content: fileText(content) }
}

function bodyFile(context: KtorContext, resource: SpecResource, shape: 'create' | 'update'): GeneratedFile {
  const pkg = context.layout.resource(resource, 'dto')
  const imports = new KtImports(pkg).add(
    'kotlinx.serialization.Serializable',
    'kotlinx.serialization.json.JsonObject',
    `${commonPackage(context)}.Checks`,
    `${commonPackage(context)}.JsonKind`,
  )
  const name = names(resource)
  const className = shape === 'create' ? name.create : name.update
  const fields = shapeFields(resource.fields, shape)
  const properties = fields.map((field) => serializableProperty(field, fieldType(context, field, imports, resource), imports, true))
  const description =
    shape === 'create'
      ? `Body of a request that creates or replaces ${article(resource.singular)}.`
      : `Body of a request that changes part of ${article(resource.singular)}: only the fields sent change.`
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc(description),
    '@Serializable',
    `data class ${className}(`,
    properties,
    ') {',
    rulesFunction(context, fields, (field) => shape === 'create' && field.required),
    '}',
  )
  return { path: sourcePath(pkg, className), content: fileText(content) }
}

/** The response of a resource: a required field is always written, an optional one only when it has a value. */
function responseFile(context: KtorContext, resource: SpecResource): GeneratedFile {
  const pkg = context.layout.resource(resource, 'dto')
  const imports = new KtImports(pkg).add('kotlinx.serialization.Serializable')
  const name = names(resource)
  imports.add(`${context.layout.resource(resource, 'model')}.${name.type}`)
  const fields = shapeFields(resource.fields, 'read')
  const properties = fields.map((field) => {
    const type = fieldType(context, field, imports, resource)
    if (field.name === resource.key.field) {
      const serial = serialName(field, imports)
      return `    ${serial ? `${serial} ` : ''}val ${property(field)}: ${type},`
    }
    return serializableProperty(field, type, imports, !alwaysInResponse(field))
  })
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc(`${capitalize(article(resource.singular))} as the API returns it.`),
    '@Serializable',
    `data class ${name.response}(`,
    properties,
    ') {',
    '    companion object {',
    `        /** The response of a stored ${resource.singular}: everything but what clients only send. */`,
    `        fun from(item: ${name.type}) = ${name.response}(`,
    fields.map((field) => `            ${property(field)} = item.${property(field)},`),
    '        )',
    '    }',
    '}',
  )
  return { path: sourcePath(pkg, name.response), content: fileText(content) }
}

/** Request bodies and response of a resource. */
export function dtoFiles(context: KtorContext, resource: SpecResource): GeneratedFile[] {
  const files = [responseFile(context, resource)]
  if (resource.endpoints.some((endpoint) => endpoint.input !== 'none'))
    files.push(bodyFile(context, resource, 'create'), bodyFile(context, resource, 'update'))
  return files
}

/** A serializer expression for a field's type, for JSON columns: `ListSerializer(OrderLine.serializer())`. */
export function serializerOf(context: KtorContext, field: SpecField, imports: KtImports): string {
  const of = (type: SpecType): string => {
    switch (type.kind) {
      case 'array':
        imports.add('kotlinx.serialization.builtins.ListSerializer')
        return `ListSerializer(${of(type.items)})`
      case 'map':
        imports.add('kotlinx.serialization.builtins.MapSerializer', 'kotlinx.serialization.builtins.serializer')
        return `MapSerializer(String.serializer(), ${of(type.value)})`
      case 'object':
      case 'enum': {
        imports.add(typeNames(context).shared(type.name))
        return `${ktClass(type.name)}.serializer()`
      }
      case 'scalar': {
        const helper = (name: string) => {
          imports.add(`${commonPackage(context)}.${name}`)
          return name
        }
        switch (type.scalar) {
          case 'integer':
            imports.add('kotlinx.serialization.builtins.serializer')
            return type.bits === 64 ? 'Long.serializer()' : 'Int.serializer()'
          case 'float':
            imports.add('kotlinx.serialization.builtins.serializer')
            return 'Double.serializer()'
          case 'boolean':
            imports.add('kotlinx.serialization.builtins.serializer')
            return 'Boolean.serializer()'
          case 'decimal':
            return helper('DecimalSerializer')
          case 'date':
            return helper('DateSerializer')
          case 'datetime':
            return helper('DateTimeSerializer')
          case 'uuid':
            return helper('UuidSerializer')
          case 'any':
            imports.add('kotlinx.serialization.json.JsonElement')
            return 'JsonElement.serializer()'
          default:
            imports.add('kotlinx.serialization.builtins.serializer')
            return 'String.serializer()'
        }
      }
    }
  }
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    imports.add('kotlinx.serialization.builtins.ListSerializer')
    const key = keyType(target)
    if (key === 'JsonUuid') {
      imports.add(`${commonPackage(context)}.UuidSerializer`)
      return 'ListSerializer(UuidSerializer)'
    }
    imports.add('kotlinx.serialization.builtins.serializer')
    return `ListSerializer(${key}.serializer())`
  }
  return of(field.type)
}
