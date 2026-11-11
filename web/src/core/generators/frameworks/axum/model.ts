/**
 * Data types of the Axum project: the domain struct of each resource, the enums and embedded objects, the request
 * bodies and the responses. Request bodies and embedded objects carry their rules, which the API checks on the
 * JSON before it reads it (common/body.rs): a missing field is told from one sent as null, and every problem is
 * reported with its field.
 */
import type { SpecField, SpecObject, SpecResource, SpecType } from '../../../api/spec.ts'
import { alwaysInResponse, shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { RsUses, rsDoc, rsHeader, rsPascal, rsString, rsType, rsTypeOf } from '../../languages/rust/rust.ts'
import { article, capitalize, field as fieldName, keyType, modulePath, names, typeNames, type AxumContext } from './context.ts'

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

/** The Rust type of a field, without `Option`: keys and references use the key's type. */
export function fieldType(context: AxumContext, field: SpecField, uses: RsUses, resource?: SpecResource): string {
  const key = (target: SpecResource) => {
    const type = keyType(target)
    if (type === 'Uuid') uses.add('uuid::Uuid')
    return type
  }
  if (resource && field.name === resource.key.field) return key(resource)
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    return field.type.kind === 'array' ? `Vec<${key(target)}>` : key(target)
  }
  return rsTypeOf(field.type, uses, typeNames(context))
}

/** The kind of JSON value a field holds, as `Checks` names it, or null when any value goes. */
function jsonKind(context: AxumContext, field: SpecField): string | null {
  if (field.reference) {
    if (field.type.kind === 'array') return 'List'
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    return target.key.type.scalar === 'integer' ? 'Whole' : 'Text'
  }
  const type = field.type
  switch (type.kind) {
    case 'array':
      return 'List'
    case 'map':
    case 'object':
      return 'Object'
    case 'enum':
      return context.spec.enums.find((item) => item.name === type.name)?.valueType === 'integer' ? 'Whole' : 'Text'
    case 'scalar':
      if (type.scalar === 'integer') return 'Whole'
      if (type.scalar === 'float' || type.scalar === 'decimal') return 'Number'
      if (type.scalar === 'boolean') return 'Boolean'
      if (type.scalar === 'any') return null
      return 'Text'
  }
}

const option = (value: number | undefined) => (value === undefined ? 'None' : `Some(${value})`)

/** The Rust statements that check a field of a body or an embedded object on its JSON. */
function fieldRules(context: AxumContext, field: SpecField, required: boolean): string[] {
  const wire = rsString(field.wire)
  const c = field.constraints
  const rules: string[] = []
  if (required) rules.push(`checks.required(json, ${wire});`)
  if (!field.nullable) rules.push(`checks.not_null(json, ${wire});`)
  const kind = jsonKind(context, field)
  if (kind) rules.push(`checks.kind(json, ${wire}, JsonKind::${kind});`)
  if (field.reference) return rules
  const type = field.type
  const text = type.kind === 'scalar' && type.scalar === 'string'
  if (text && (c.minLength !== undefined || c.maxLength !== undefined))
    rules.push(`checks.length(json, ${wire}, ${option(c.minLength)}, ${option(c.maxLength)});`)
  if (type.kind === 'array' && (c.minItems !== undefined || c.maxItems !== undefined))
    rules.push(`checks.count(json, ${wire}, ${option(c.minItems)}, ${option(c.maxItems)});`)
  if (type.kind === 'scalar' && ['integer', 'float', 'decimal'].includes(type.scalar)) {
    const bound = (inclusive?: number, exclusive?: number, lower = true) => {
      if (exclusive !== undefined && (inclusive === undefined || (lower ? exclusive >= inclusive : exclusive <= inclusive)))
        return { value: `Some(${rsString(String(exclusive))})`, exclusive: true }
      return inclusive !== undefined ? { value: `Some(${rsString(String(inclusive))})`, exclusive: false } : null
    }
    const low = bound(c.minimum, c.exclusiveMinimum, true)
    const high = bound(c.maximum, c.exclusiveMaximum, false)
    if (low || high)
      rules.push(
        `checks.range(json, ${wire}, ${low?.value ?? 'None'}, ${high?.value ?? 'None'}, ${low?.exclusive ?? false}, ${high?.exclusive ?? false});`,
      )
  }
  const pattern = (regex: string) => rules.push(`checks.pattern(json, ${wire}, ${rsString(regex)});`)
  if (text && c.pattern) pattern(c.pattern)
  if (text && c.format === 'email') rules.push(`checks.email(json, ${wire});`)
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
    item.kind === 'object' && context.spec.objects.some((object) => object.name === item.name) ? rsType(item.name) : null
  if (type.kind === 'object' && inner(type)) rules.push(`checks.nested(json, ${wire}, ${inner(type)}::rules);`)
  if (type.kind === 'array' && inner(type.items)) rules.push(`checks.each(json, ${wire}, ${inner(type.items)}::rules);`)
  return rules
}

/** The `rules` function of a body or an embedded object. */
function rulesFunction(context: AxumContext, typeName: string, fields: SpecField[], required: (field: SpecField) => boolean) {
  const rules = fields.flatMap((field) => fieldRules(context, field, required(field)))
  const used = rules.length > 0
  return [
    `impl ${typeName} {`,
    '    /// What the body must meet, checked on its JSON before it is read.',
    `    pub fn rules(${used ? '' : '_'}checks: &mut Checks, ${used ? '' : '_'}json: &Map<String, Value>) {`,
    ...rules.map((rule) => `        ${rule}`),
    '    }',
    '}',
  ]
}

/** The serde attributes of a field: its JSON name, and whether it may be missing or left out. */
function serdeAttributes(field: SpecField, options: string[]): string | null {
  const name = fieldName(field).replace(/^r#/, '')
  const all = [name === field.wire ? null : `rename = ${rsString(field.wire)}`, ...options].filter(Boolean)
  return all.length > 0 ? `    #[serde(${all.join(', ')})]` : null
}

function enumFile(context: AxumContext, enumName: string): GeneratedFile {
  const item = context.spec.enums.find((entry) => entry.name === enumName)!
  const name = rsType(item.name)
  const integer = item.valueType === 'integer'
  const uses = new RsUses()
  if (integer) uses.add('serde_repr::{Deserialize_repr, Serialize_repr}')
  else uses.add('serde::{Deserialize, Serialize}')
  const used = new Set<string>()
  const variants = item.values.map((value) => {
    let base = rsPascal(String(value))
    if (base.startsWith('_')) base = `Value${base.slice(1)}`
    let variant = base
    for (let n = 2; used.has(variant); n++) variant = `${base}${n}`
    used.add(variant)
    return { variant, value }
  })
  const literal = (value: string | number) => (integer ? String(value) : rsString(String(value)))
  const content = lines(
    ...rsHeader(`Values of ${item.name}.`, uses),
    rsDoc(`Values of ${item.name}, with the value each one has in JSON.`),
    integer
      ? ['#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize_repr, Deserialize_repr)]', '#[repr(i64)]']
      : '#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]',
    `pub enum ${name} {`,
    integer
      ? variants.map(({ variant, value }) => `    ${variant} = ${value},`)
      : variants.map(({ variant, value }) => `    #[serde(rename = ${rsString(String(value))})]\n    ${variant},`).join('\n\n'),
    '}',
    '',
    `impl ${name} {`,
    '    /// The value in JSON.',
    `    pub fn value(self) -> ${integer ? 'i64' : "&'static str"} {`,
    integer
      ? '        self as i64'
      : ['        match self {', variants.map(({ variant, value }) => `            Self::${variant} => ${literal(value)},`), '        }'],
    '    }',
    '',
    '    /// The variant with this value in JSON, or None when none has it.',
    `    pub fn from_value(value: ${integer ? 'i64' : '&str'}) -> Option<Self> {`,
    '        match value {',
    variants.map(({ variant, value }) => `            ${literal(value)} => Some(Self::${variant}),`),
    '            _ => None,',
    '        }',
    '    }',
    '}',
  )
  return { path: modulePath(context.layout.shared(item.name)), content: fileText(content) }
}

/** A field of a type read from JSON: `Option`, possibly missing. */
function bodyField(context: AxumContext, field: SpecField, uses: RsUses, resource: SpecResource | undefined, omitEmpty: boolean) {
  const type = fieldType(context, field, uses, resource)
  return lines(
    field.todo && `    // TODO: ${field.todo}`,
    serdeAttributes(field, ['default', ...(omitEmpty ? ['skip_serializing_if = "Option::is_none"'] : [])]),
    `    pub ${fieldName(field)}: Option<${type}>,`,
  )
}

function bodyUses(): RsUses {
  return new RsUses().add('serde::{Deserialize, Serialize}', 'serde_json::{Map, Value}', 'crate::common::body::{Checks, JsonKind}')
}

function objectFile(context: AxumContext, object: SpecObject): GeneratedFile {
  const name = rsType(object.name)
  const uses = bodyUses()
  const fields = object.fields.map((field) => bodyField(context, field, uses, undefined, !alwaysInResponse(field)))
  const content = lines(
    ...rsHeader(`${object.name}, embedded in the resources that hold it.`, uses),
    rsDoc(object.description ?? `${object.name}, embedded in the resources that hold it.`),
    '#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]',
    '#[serde(deny_unknown_fields)]',
    `pub struct ${name} {`,
    fields.join('\n'),
    '}',
    '',
    rulesFunction(context, name, object.fields, (field) => field.required),
  )
  return { path: modulePath(context.layout.shared(object.name)), content: fileText(content) }
}

/** Enums and embedded objects shared by the resources. */
export function sharedFiles(context: AxumContext): GeneratedFile[] {
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

/** The domain struct of a resource: every field, the ones clients never read included. */
export function domainFile(context: AxumContext, resource: SpecResource): GeneratedFile {
  const uses = new RsUses()
  const name = names(resource)
  const fields = resource.fields.map((field) => {
    const type = fieldType(context, field, uses, resource)
    return lines(
      field.todo && `    // TODO: ${field.todo}`,
      `    pub ${fieldName(field)}: ${field.name === resource.key.field ? type : `Option<${type}>`},`,
    )
  })
  const content = lines(
    ...rsHeader(`${capitalize(article(resource.singular))} as the service and its storage handle it.`, uses),
    resource.todo && `// TODO: ${resource.todo}`,
    rsDoc(`${capitalize(article(resource.singular))} as the service and its storage handle it.`),
    '#[derive(Clone, Debug, Default, PartialEq)]',
    `pub struct ${name.type} {`,
    fields,
    '}',
  )
  return { path: modulePath(context.layout.resource(resource, 'model')), content: fileText(content) }
}

/** Request bodies and response of a resource, in one module. */
export function dtoFile(context: AxumContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const writes = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  const uses = writes ? bodyUses() : new RsUses().add('serde::Serialize')
  uses.add(`crate::${context.layout.resource(resource, 'model')}::${name.type}`)
  const body = (shape: 'create' | 'update') => {
    const fields = shapeFields(resource.fields, shape)
    const className = shape === 'create' ? name.create : name.update
    return [
      rsDoc(
        shape === 'create'
          ? `Body of a request that creates or replaces ${article(resource.singular)}.`
          : `Body of a request that changes part of ${article(resource.singular)}: only the fields sent change.`,
      ),
      '#[derive(Clone, Debug, Deserialize)]',
      '#[serde(deny_unknown_fields)]',
      `pub struct ${className} {`,
      fields.map((field) => bodyField(context, field, uses, resource, false)).join('\n'),
      '}',
      '',
      rulesFunction(context, className, fields, (field) => shape === 'create' && field.required),
      '',
    ]
  }
  const read = shapeFields(resource.fields, 'read')
  const responseFields = read.map((field) => {
    const type = fieldType(context, field, uses, resource)
    if (field.name === resource.key.field) return lines(serdeAttributes(field, []), `    pub ${fieldName(field)}: ${type},`)
    // An optional field without a value is left out of the JSON, as the contract allows
    return lines(
      serdeAttributes(field, alwaysInResponse(field) ? [] : ['skip_serializing_if = "Option::is_none"']),
      `    pub ${fieldName(field)}: Option<${type}>,`,
    )
  })
  // The bodies are written before the header: their fields add to the use declarations
  const bodies = writes && [body('create'), body('update')]
  const content = lines(
    ...rsHeader(`Request bodies and responses of ${resource.plural}.`, uses),
    bodies,
    rsDoc(`${capitalize(article(resource.singular))} as the API returns it: everything but what clients only send.`),
    '#[derive(Clone, Debug, Serialize)]',
    `pub struct ${name.response} {`,
    responseFields,
    '}',
    '',
    `impl From<${name.type}> for ${name.response} {`,
    `    fn from(item: ${name.type}) -> Self {`,
    '        Self {',
    read.map((field) => `            ${fieldName(field)}: item.${fieldName(field)},`),
    '        }',
    '    }',
    '}',
  )
  return { path: modulePath(context.layout.resource(resource, 'dto')), content: fileText(content) }
}
