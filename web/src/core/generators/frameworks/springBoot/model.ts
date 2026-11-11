/**
 * Data classes of the Spring Boot project: the domain class of each resource (a JPA entity when JPA is
 * chosen), the enums and embedded objects, the request bodies (which remember which fields were sent, to
 * tell a missing field from an explicit null) and the response records.
 */
import type { SpecField, SpecObject, SpecResource } from '../../../api/spec.ts'
import { shapeFields, alwaysInResponse } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { JavaImports, getter, javaClass, javaConstant, javaDoc, javaString, javaType, setter } from '../../languages/java/java.ts'
import { commonPackage, keyType, names, property, sharedNames, sourcePath, type SpringContext } from './context.ts'

/** The Java type of a field: keys and references to keys use the key's type, whole numbers as `Long`. */
export function fieldType(context: SpringContext, field: SpecField, imports: JavaImports, resource?: SpecResource): string {
  if (resource && field.name === resource.key.field) {
    if (resource.key.type.scalar === 'uuid') imports.add('java.util.UUID')
    return keyType(resource)
  }
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    if (target.key.type.scalar === 'uuid') imports.add('java.util.UUID')
    if (field.type.kind === 'array') {
      imports.add('java.util.List')
      return `List<${keyType(target)}>`
    }
    return keyType(target)
  }
  return javaType(field.type, imports, sharedNames(context))
}

/** Bean Validation annotations of a field's declared validations. */
export function validations(field: SpecField, imports: JavaImports, shape: 'create' | 'update' | 'object'): string[] {
  const c = field.constraints
  const result: string[] = []
  const v = (name: string) => imports.add(`jakarta.validation.constraints.${name}`)
  if (shape !== 'update' && field.required) {
    v('NotNull')
    result.push('@NotNull')
  }
  const text = field.type.kind === 'scalar' && field.type.scalar === 'string'
  const list = field.type.kind === 'array'
  const min = list ? c.minItems : text ? c.minLength : undefined
  const max = list ? c.maxItems : text ? c.maxLength : undefined
  if (min !== undefined || max !== undefined) {
    v('Size')
    result.push(
      `@Size(${[min !== undefined ? `min = ${min}` : null, max !== undefined ? `max = ${max}` : null].filter(Boolean).join(', ')})`,
    )
  }
  const number = field.type.kind === 'scalar' && ['integer', 'float', 'decimal'].includes(field.type.scalar)
  if (number) {
    const decimal = (value: number, inclusive: boolean, name: 'DecimalMin' | 'DecimalMax') => {
      v(name)
      result.push(
        inclusive ? `@${name}(${javaString(String(value))})` : `@${name}(value = ${javaString(String(value))}, inclusive = false)`,
      )
    }
    if (c.minimum !== undefined) decimal(c.minimum, true, 'DecimalMin')
    if (c.exclusiveMinimum !== undefined) decimal(c.exclusiveMinimum, false, 'DecimalMin')
    if (c.maximum !== undefined) decimal(c.maximum, true, 'DecimalMax')
    if (c.exclusiveMaximum !== undefined) decimal(c.exclusiveMaximum, false, 'DecimalMax')
  }
  if (text && c.pattern) {
    v('Pattern')
    result.push(`@Pattern(regexp = ${javaString(c.pattern)})`)
  }
  if (text && c.format === 'email') {
    v('Email')
    result.push('@Email')
  }
  if (text && c.format && c.format !== 'email') {
    // URLs, UUIDs and dates written as text: checked with a pattern, as Bean Validation has no annotation for them
    const patterns: Record<string, string> = {
      uri: '^[a-zA-Z][a-zA-Z0-9+.-]*://\\S+$',
      uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      date: '^\\d{4}-\\d{2}-\\d{2}$',
      'date-time': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$',
      time: '^\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$',
    }
    v('Pattern')
    result.push(`@Pattern(regexp = ${javaString(patterns[c.format])})`)
  }
  if (field.type.kind === 'object' || (field.type.kind === 'array' && field.type.items.kind === 'object')) {
    imports.add('jakarta.validation.Valid')
    result.push('@Valid')
  }
  return result
}

/** `@JsonProperty("postal_code")` when the JSON name is not the Java property. */
function jsonName(field: SpecField, imports: JavaImports): string | null {
  if (property(field) === field.wire) return null
  imports.add('com.fasterxml.jackson.annotation.JsonProperty')
  return `@JsonProperty(${javaString(field.wire)})`
}

function enumFile(context: SpringContext, values: (string | number)[], name: string): GeneratedFile {
  const pkg = context.layout.shared()
  const imports = new JavaImports(pkg).add('com.fasterxml.jackson.annotation.JsonValue', `${commonPackage(context)}.ApiException`)
  const integer = values.every((value) => typeof value === 'number')
  const used = new Set<string>()
  const constants = values.map((value) => {
    let constant = javaConstant(value)
    for (let n = 2; used.has(constant); n++) constant = `${javaConstant(value)}_${n}`
    used.add(constant)
    return `    ${constant}(${integer ? value : javaString(String(value))})`
  })
  const type = integer ? 'int' : 'String'
  const content = lines(
    `package ${pkg};`,
    '',
    imports.render(),
    '',
    javaDoc(`Values of ${name}, with the value each one has in JSON.`),
    `public enum ${javaClass(name)} {`,
    `${constants.join(',\n')};`,
    '',
    `    private final ${type} value;`,
    '',
    `    ${javaClass(name)}(${type} value) {`,
    '        this.value = value;',
    '    }',
    '',
    '    @JsonValue',
    `    public ${type} getValue() {`,
    '        return value;',
    '    }',
    '',
    '    /** The constant with this JSON value; an unknown value is a 400. */',
    `    public static ${javaClass(name)} fromValue(${integer ? 'Integer' : 'String'} value) {`,
    `        for (${javaClass(name)} item : values()) {`,
    integer ? '            if (item.value == value) {' : '            if (item.value.equals(value)) {',
    '                return item;',
    '            }',
    '        }',
    `        throw ApiException.invalid(${javaString(name)}, "Unknown value: " + value);`,
    '    }',
    '}',
  )
  return { path: sourcePath(pkg, javaClass(name)), content: fileText(content) }
}

function objectFile(context: SpringContext, object: SpecObject): GeneratedFile {
  const pkg = context.layout.shared()
  const imports = new JavaImports(pkg)
  const components = object.fields.map((field) => {
    const annotations = [...validations(field, imports, 'object'), jsonName(field, imports)].filter(Boolean)
    return `        ${[...annotations, `${fieldType(context, field, imports)} ${property(field)}`].join(' ')}`
  })
  const content = lines(
    `package ${pkg};`,
    '',
    imports.render(),
    '',
    javaDoc(object.description ?? `${object.name}, embedded in the resources that hold it.`),
    `public record ${javaClass(object.name)}(`,
    components.join(',\n'),
    ') {',
    '}',
  )
  return { path: sourcePath(pkg, javaClass(object.name)), content: fileText(content) }
}

/** Enums and embedded objects shared by the resources. */
export function sharedFiles(context: SpringContext): GeneratedFile[] {
  return [
    ...context.spec.enums.map((item) => enumFile(context, item.values, item.name)),
    ...context.spec.objects.map((object) => objectFile(context, object)),
  ]
}

/** Whether a field is stored as JSON in a table: embedded objects, lists and maps. */
export function storedAsJson(field: SpecField): boolean {
  return (
    field.type.kind === 'object' ||
    field.type.kind === 'array' ||
    field.type.kind === 'map' ||
    (field.type.kind === 'scalar' && field.type.scalar === 'any')
  )
}

/** The domain class of a resource: every field, the ones clients never read included. */
export function domainFile(context: SpringContext, resource: SpecResource): GeneratedFile {
  const pkg = context.layout.resource(resource, 'model')
  const imports = new JavaImports(pkg)
  const name = names(resource)
  const fields = resource.fields.map((field) => {
    const type = fieldType(context, field, imports, resource)
    const annotations: string[] = []
    if (context.jpa) {
      if (field.name === resource.key.field) {
        imports.add('jakarta.persistence.Id')
        annotations.push('@Id')
        if (resource.key.generated === 'increment') {
          imports.add('jakarta.persistence.GeneratedValue', 'jakarta.persistence.GenerationType')
          annotations.push('@GeneratedValue(strategy = GenerationType.IDENTITY)')
        }
        if (resource.key.generated === 'uuid') {
          imports.add('jakarta.persistence.GeneratedValue', 'jakarta.persistence.GenerationType')
          annotations.push('@GeneratedValue(strategy = GenerationType.UUID)')
        }
      }
      if (storedAsJson(field)) {
        imports.add('org.hibernate.annotations.JdbcTypeCode', 'org.hibernate.type.SqlTypes')
        annotations.push('@JdbcTypeCode(SqlTypes.JSON)')
      }
      if (field.type.kind === 'enum') {
        imports.add('jakarta.persistence.Enumerated', 'jakarta.persistence.EnumType')
        annotations.push('@Enumerated(EnumType.STRING)')
      }
      if (field.type.kind === 'scalar' && field.type.scalar === 'string' && field.constraints.maxLength !== undefined) {
        imports.add('jakarta.persistence.Column')
        annotations.push(`@Column(length = ${field.constraints.maxLength})`)
      }
      if (field.type.kind === 'scalar' && field.type.scalar === 'decimal') {
        imports.add('jakarta.persistence.Column')
        annotations.push('@Column(precision = 18, scale = 4)')
      }
    }
    const todo = field.todo ? `    // TODO: ${field.todo}\n` : ''
    return {
      declaration: `${todo}${annotations.map((annotation) => `    ${annotation}\n`).join('')}    private ${type} ${property(field)};`,
      type,
      property: property(field),
    }
  })
  if (context.jpa) {
    imports.add('jakarta.persistence.Entity', 'jakarta.persistence.Table')
  }
  const accessors = fields.flatMap(({ type, property: prop }) => [
    `    public ${type} ${getter(prop)}() {`,
    `        return ${prop};`,
    '    }',
    '',
    `    public void ${setter(prop)}(${type} ${prop}) {`,
    `        this.${prop} = ${prop};`,
    '    }',
    '',
  ])
  const content = lines(
    `package ${pkg};`,
    '',
    imports.render(),
    '',
    resource.todo && `// TODO: ${resource.todo}`,
    javaDoc(`${capitalize(article(resource.singular))} as the service and its storage handle it.`),
    context.jpa && ['@Entity', `@Table(name = ${javaString(resource.plural.replace(/ /g, '_'))})`],
    `public class ${name.type} {`,
    '',
    fields.map((field) => field.declaration).join('\n\n'),
    '',
    accessors.slice(0, -1),
    '}',
  )
  return { path: sourcePath(pkg, name.type), content: fileText(content) }
}

/** The base of request bodies: remembers which properties were sent, so null and missing differ. */
export function payloadFile(context: SpringContext): GeneratedFile {
  const pkg = commonPackage(context)
  const content = lines(
    `package ${pkg};`,
    '',
    'import com.fasterxml.jackson.annotation.JsonIgnore;',
    'import java.util.HashSet;',
    'import java.util.Set;',
    '',
    javaDoc(
      'Base of request bodies. Jackson calls a setter only for properties present in the JSON, so the\nsetters record them: a property sent as null is present, a missing one is not.',
    ),
    'public abstract class Payload {',
    '',
    '    @JsonIgnore',
    '    private final Set<String> present = new HashSet<>();',
    '',
    '    /** Records that the property with this JSON name was sent. */',
    '    protected void mark(String property) {',
    '        present.add(property);',
    '    }',
    '',
    '    /** Whether the property with this JSON name was sent, even as null. */',
    '    public boolean has(String property) {',
    '        return present.contains(property);',
    '    }',
    '}',
  )
  return { path: sourcePath(pkg, 'Payload'), content: fileText(content) }
}

function payloadClass(context: SpringContext, resource: SpecResource, shape: 'create' | 'update'): GeneratedFile {
  const pkg = context.layout.resource(resource, 'dto')
  const imports = new JavaImports(pkg).add(`${commonPackage(context)}.Payload`)
  const name = names(resource)
  const className = shape === 'create' ? name.create : name.update
  const fields = shapeFields(resource.fields, shape).map((field) => ({
    field,
    type: fieldType(context, field, imports, resource),
    prop: property(field),
  }))
  const declarations = fields.map(({ field, type, prop }) => {
    const annotations = [...validations(field, imports, shape), jsonName(field, imports)].filter(Boolean)
    return `${annotations.map((annotation) => `    ${annotation}\n`).join('')}    private ${type} ${prop};`
  })
  const accessors = fields.flatMap(({ field, type, prop }) => [
    `    public ${type} ${getter(prop)}() {`,
    `        return ${prop};`,
    '    }',
    '',
    `    public void ${setter(prop)}(${type} ${prop}) {`,
    `        mark(${javaString(field.wire)});`,
    `        this.${prop} = ${prop};`,
    '    }',
    '',
  ])
  const description =
    shape === 'create'
      ? `Body of a request that creates or replaces ${article(resource.singular)}.`
      : `Body of a request that changes part of ${article(resource.singular)}: only the fields sent change.`
  const content = lines(
    `package ${pkg};`,
    '',
    imports.render(),
    '',
    javaDoc(description),
    `public class ${className} extends Payload {`,
    '',
    declarations.join('\n\n'),
    fields.length > 0 && '',
    accessors.slice(0, -1),
    '}',
  )
  return { path: sourcePath(pkg, className), content: fileText(content) }
}

/** The response record of a resource and how it is built from the domain class. */
function responseFile(context: SpringContext, resource: SpecResource): GeneratedFile {
  const pkg = context.layout.resource(resource, 'dto')
  const imports = new JavaImports(pkg)
  const name = names(resource)
  imports.add(`${context.layout.resource(resource, 'model')}.${name.type}`)
  const fields = shapeFields(resource.fields, 'read')
  const components = fields.map((field) => {
    // An optional field without a value is left out of the JSON, as the contract allows
    const optional = !alwaysInResponse(field)
    if (optional) imports.add('com.fasterxml.jackson.annotation.JsonInclude')
    const annotations = [optional ? '@JsonInclude(JsonInclude.Include.NON_NULL)' : null, jsonName(field, imports)].filter(Boolean)
    return `        ${[...annotations, `${fieldType(context, field, imports, resource)} ${property(field)}`].join(' ')}`
  })
  const content = lines(
    `package ${pkg};`,
    '',
    imports.render(),
    '',
    javaDoc(`${capitalize(article(resource.singular))} as the API returns it.`),
    `public record ${name.response}(`,
    components.join(',\n'),
    ') {',
    '',
    `    /** The response of a stored ${resource.singular}: everything but what clients only send. */`,
    `    public static ${name.response} from(${name.type} item) {`,
    `        return new ${name.response}(${fields.map((field) => `item.${getter(property(field))}()`).join(', ')});`,
    '    }',
    '}',
  )
  return { path: sourcePath(pkg, name.response), content: fileText(content) }
}

/** Request bodies and response of a resource. */
export function dtoFiles(context: SpringContext, resource: SpecResource): GeneratedFile[] {
  const files = [responseFile(context, resource)]
  if (resource.endpoints.some((endpoint) => endpoint.input !== 'none'))
    files.push(payloadClass(context, resource, 'create'), payloadClass(context, resource, 'update'))
  return files
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
