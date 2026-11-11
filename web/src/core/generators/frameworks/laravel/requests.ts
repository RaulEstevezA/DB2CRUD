/**
 * Request bodies of the Laravel project: a Form Request per shape (create or replace, and partial update)
 * with Laravel's validation rules for every field the contract describes, and the enums they check.
 *
 * Presence follows openapi.yaml: a required field must be present (it may be "" or [] if its rules allow
 * them), an optional one may be left out, and null is accepted only where the field is nullable.
 */
import type { SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpClass, phpDoc, phpHeader, phpRegex, phpString } from '../../languages/php/php.ts'
import { fieldDefaults } from '../../languages/php/model.ts'
import { article, classPath, names, qualified, type LaravelContext } from './context.ts'

/** Patterns of the text formats Laravel has no rule for, as in the other generators. */
const DATE_TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$'
const TIME = '^\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$'
const DURATION = '^P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+(\\.\\d+)?S)?)?$'
const BASE64 = '^[A-Za-z0-9+\\/]*={0,2}$'

type Shape = 'create' | 'update'

/** Where a field is: at the top of the body, inside an object (with its path), or inside a list item. */
type Place = { kind: 'top' } | { kind: 'object'; parent: string } | { kind: 'item' }

interface RuleSet {
  /** Rules by attribute path, in order */
  rules: [string, string[]][]
  /** Paths whose content is free */
  open: string[]
  imports: PhpImports
}

/** The rules of a value of a type, without presence and nullability. */
function typeRules(context: LaravelContext, type: SpecType, field: SpecField | null, set: RuleSet, path: string): string[] {
  const blank = (text: boolean, extra = '') => {
    set.imports.add('App\\Rules\\BlankString')
    return `new BlankString(${text ? 'text: true' : 'text: false'}${extra})`
  }
  const c = field?.constraints ?? {}
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string': {
          const rules = ["'string'"]
          const format = c.format
          if (format === 'email') rules.push("'email'")
          if (format === 'uri') rules.push("'url'")
          if (format === 'uuid') rules.push("'uuid'")
          if (format === 'date') rules.push("'date_format:Y-m-d'")
          if (format === 'date-time') rules.push(phpString(`regex:${phpRegex(DATE_TIME)}`))
          if (format === 'time') rules.push(phpString(`regex:${phpRegex(TIME)}`))
          if (c.minLength !== undefined) rules.push(`'min:${c.minLength}'`)
          if (c.maxLength !== undefined) rules.push(`'max:${c.maxLength}'`)
          if (c.pattern !== undefined) rules.push(phpString(`regex:${phpRegex(c.pattern)}`))
          const extra = [
            c.minLength !== undefined ? `, min: ${c.minLength}` : '',
            c.maxLength !== undefined ? `, max: ${c.maxLength}` : '',
            c.pattern !== undefined ? `, pattern: ${phpString(phpRegex(c.pattern))}` : '',
            format ? ', format: true' : '',
          ].join('')
          rules.push(blank(true, extra))
          return rules
        }
        case 'integer':
        case 'float':
        case 'decimal': {
          const rules = [type.scalar === 'integer' ? "'integer:strict'" : "'numeric:strict'"]
          if (c.minimum !== undefined) rules.push(`'min:${c.minimum}'`)
          if (c.maximum !== undefined) rules.push(`'max:${c.maximum}'`)
          if (c.exclusiveMinimum !== undefined) rules.push(`'gt:${c.exclusiveMinimum}'`)
          if (c.exclusiveMaximum !== undefined) rules.push(`'lt:${c.exclusiveMaximum}'`)
          rules.push(blank(false))
          return rules
        }
        case 'boolean':
          return ["'boolean:strict'", blank(false)]
        case 'date':
          return ["'string'", "'date_format:Y-m-d'", blank(true, ', format: true')]
        case 'datetime':
          return ["'string'", phpString(`regex:${phpRegex(DATE_TIME)}`), blank(true, ', format: true')]
        case 'time':
          return ["'string'", phpString(`regex:${phpRegex(TIME)}`), blank(true, ', format: true')]
        case 'duration':
          return ["'string'", phpString(`regex:${phpRegex(DURATION)}`), blank(true, ', format: true')]
        case 'uuid':
          return ["'string'", "'uuid'", blank(true, ', format: true')]
        case 'binary':
          return ["'string'", phpString(`regex:${phpRegex(BASE64)}`), blank(true)]
        case 'any':
          set.open.push(path)
          return []
      }
      return []
    case 'enum': {
      set.imports.add('Illuminate\\Validation\\Rule', `${context.layout.enums()}\\${phpClass(type.name)}`)
      return [`Rule::enum(${phpClass(type.name)}::class)`, blank(false)]
    }
    case 'array': {
      const rules = ["'list'"]
      if (c.minItems !== undefined) rules.push(`'min:${c.minItems}'`)
      if (c.maxItems !== undefined) rules.push(`'max:${c.maxItems}'`)
      rules.push(blank(false))
      return rules
    }
    case 'map':
      set.open.push(path)
      return ["'array'", blank(false)]
    case 'object':
      return ["'array'", blank(false)]
  }
}

/** The rules of the key a reference holds: the type of the target's key. */
function referenceRules(context: LaravelContext, field: SpecField, set: RuleSet): string[] {
  const target = context.spec.resources.find((item) => item.name === field.reference)!
  set.imports.add('App\\Rules\\BlankString')
  if (target.key.type.scalar === 'integer') return ["'integer:strict'", 'new BlankString(text: false)']
  if (target.key.type.scalar === 'uuid') return ["'string'", "'uuid'", 'new BlankString(text: true, format: true)']
  return ["'string'", 'new BlankString(text: true)']
}

/** Adds the rules of a field, and of what it holds, to the set. */
function addField(
  context: LaravelContext,
  field: SpecField,
  shape: Shape | 'object',
  place: Place,
  path: string,
  set: RuleSet,
  depth: number,
) {
  const presence: string[] = []
  if (place.kind === 'top') presence.push(shape === 'create' && field.required ? "'present'" : "'sometimes'")
  else if (place.kind === 'object')
    presence.push(...(field.required ? [`'exclude_if:${place.parent},null'`, `'present_with:${place.parent}'`] : ["'sometimes'"]))
  else if (field.required) presence.push("'present'")
  else presence.push("'sometimes'")
  if (field.nullable) presence.push("'nullable'")
  if (field.reference) {
    if (field.type.kind === 'array') {
      set.rules.push([path, [...presence, "'list'"]])
      set.rules.push([`${path}.*`, referenceRules(context, field, set)])
    } else set.rules.push([path, [...presence, ...referenceRules(context, field, set)]])
    return
  }
  set.rules.push([path, [...presence, ...typeRules(context, field.type, field, set, path)]])
  addInner(context, field.type, path, set, depth)
}

/** Rules of what a type holds: the fields of an object, the items of a list, the values of a map. */
function addInner(context: LaravelContext, type: SpecType, path: string, set: RuleSet, depth: number) {
  if (depth > 4) return
  if (type.kind === 'object') {
    const object = context.spec.objects.find((item) => item.name === type.name)
    for (const inner of object?.fields ?? [])
      addField(context, inner, 'object', { kind: 'object', parent: path }, `${path}.${inner.wire}`, set, depth + 1)
    return
  }
  if (type.kind === 'array' || type.kind === 'map') {
    const item = type.kind === 'array' ? type.items : type.value
    const rules = typeRules(context, item, null, set, `${path}.*`)
    if (rules.length > 0) set.rules.push([`${path}.*`, rules])
    addInner(context, item, `${path}.*`, set, depth + 1)
  }
}

function requestFile(context: LaravelContext, resource: SpecResource, shape: Shape): GeneratedFile {
  const namespace = context.layout.resource(resource, 'request')
  const name = names(resource)
  const className = shape === 'create' ? name.store : name.update
  const set: RuleSet = { rules: [], open: [], imports: new PhpImports(namespace).add('App\\Http\\Requests\\ApiRequest') }
  const fields = shapeFields(resource.fields, shape)
  for (const field of fields) addField(context, field, shape, { kind: 'top' }, field.wire, set, 0)
  const todos = fields.filter((field) => field.todo).map((field) => `        // TODO: ${field.wire}: ${field.todo}`)
  const fill = fieldDefaults(context, fields, '$values', 0, shape === 'create')
  const description =
    shape === 'create'
      ? `Body of a request that creates or replaces ${article(resource.singular)}.`
      : `Body of a request that changes part of ${article(resource.singular)}: only the fields sent change.`
  const content = lines(
    ...phpHeader(namespace, set.imports),
    phpDoc(description),
    `final class ${className} extends ApiRequest`,
    '{',
    set.open.length > 0 && [`    protected array $open = [${set.open.map(phpString).join(', ')}];`, ''],
    '    /** @return array<string, list<mixed>> */',
    '    public function rules(): array',
    '    {',
    todos,
    set.rules.length > 0
      ? ['        return [', set.rules.map(([path, rules]) => `            ${phpString(path)} => [${rules.join(', ')}],`), '        ];']
      : '        return [];',
    '    }',
    '',
    shape === 'create'
      ? '    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */'
      : '    /** @return array<string, mixed> The values sent. */',
    '    public function values(): array',
    '    {',
    '        $values = $this->validated();',
    fill.map((line) => `        ${line}`),
    '',
    '        return $values;',
    '    }',
    '}',
  )
  return { path: classPath(namespace, className), content: fileText(content) }
}

/** The Form Requests of a resource, when an endpoint receives a body. */
export function requestFiles(context: LaravelContext, resource: SpecResource): GeneratedFile[] {
  if (!resource.endpoints.some((endpoint) => endpoint.input !== 'none')) return []
  return [requestFile(context, resource, 'create'), requestFile(context, resource, 'update')]
}

/** The class of a resource's request of a shape, fully qualified. */
export function requestClass(context: LaravelContext, resource: SpecResource, shape: Shape): string {
  const name = names(resource)
  return qualified(context, resource, 'request', shape === 'create' ? name.store : name.update)
}
