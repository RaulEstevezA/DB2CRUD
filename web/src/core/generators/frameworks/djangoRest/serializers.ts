/**
 * Serializers of the Django REST Framework project: one per resource (it reads requests and writes
 * responses, with the access of each field) and one per embedded object. Fields use their JSON names and
 * point to the model attribute with `source`. A base class rejects fields the client may not send, as the
 * OpenAPI contract does.
 */
import type { SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { pyClass, pyLiteral, pyString, type PyImports } from '../../languages/python/python.ts'
import { attr, isForeignKey, moduleOf, names, type DjangoContext, type Modules } from './context.ts'

type ModuleRef = { imports: PyImports; blocks: string[] }

/** The DRF field that reads and writes one value of a type, without the field's own options. */
function valueField(
  context: DjangoContext,
  type: SpecType,
  field: SpecField | null,
  here: string,
  module: ModuleRef,
): { name: string; args: string[] } {
  const c = field?.constraints ?? {}
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string': {
          if (c.format === 'email') return { name: 'EmailField', args: [] }
          if (c.format === 'uri') return { name: 'URLField', args: [] }
          if (c.format === 'uuid') return { name: 'UUIDField', args: [] }
          if (c.format === 'date') return { name: 'DateField', args: [] }
          if (c.format === 'date-time') return { name: 'DateTimeField', args: [] }
          if (c.format === 'time') return { name: 'TimeField', args: [] }
          // Text as sent: no trimming, and empty text is valid unless a minimum length says otherwise
          const args = ['trim_whitespace=False', ...(c.minLength ? [] : ['allow_blank=True'])]
          if (c.minLength !== undefined) args.push(`min_length=${c.minLength}`)
          if (c.maxLength !== undefined) args.push(`max_length=${c.maxLength}`)
          if (c.pattern !== undefined) {
            module.imports.add('django.core.validators', 'RegexValidator')
            args.push(`validators=[RegexValidator(${pyString(c.pattern)})]`)
          }
          return { name: 'CharField', args }
        }
        case 'integer':
        case 'float':
        case 'decimal': {
          const args: string[] = type.scalar === 'decimal' ? ['max_digits=18', 'decimal_places=4', 'coerce_to_string=False'] : []
          if (c.minimum !== undefined) args.push(`min_value=${c.minimum}`)
          if (c.maximum !== undefined) args.push(`max_value=${c.maximum}`)
          const exclusive: string[] = []
          if (c.exclusiveMinimum !== undefined) {
            module.imports.add('config.validation', 'greater_than')
            exclusive.push(`greater_than(${c.exclusiveMinimum})`)
          }
          if (c.exclusiveMaximum !== undefined) {
            module.imports.add('config.validation', 'less_than')
            exclusive.push(`less_than(${c.exclusiveMaximum})`)
          }
          if (exclusive.length > 0) args.push(`validators=[${exclusive.join(', ')}]`)
          return { name: type.scalar === 'integer' ? 'IntegerField' : type.scalar === 'float' ? 'FloatField' : 'DecimalField', args }
        }
        case 'boolean':
          return { name: 'BooleanField', args: [] }
        case 'date':
          return { name: 'DateField', args: [] }
        case 'datetime':
          return { name: 'DateTimeField', args: [] }
        case 'time':
          return { name: 'TimeField', args: [] }
        case 'uuid':
          return { name: 'UUIDField', args: [] }
        case 'any':
          return { name: 'JSONField', args: [] }
        default:
          return { name: 'CharField', args: ['trim_whitespace=False', 'allow_blank=True'] }
      }
    case 'enum': {
      const shared = context.layout.sharedEnums()
      if (shared !== here) module.imports.add(shared, pyClass(type.name))
      return { name: 'ChoiceField', args: [`choices=${pyClass(type.name)}.choices`] }
    }
    case 'array': {
      const child = valueField(context, type.items, null, here, module)
      const args = [`child=${render(child)}`]
      if (c.minItems !== undefined) args.push(`min_length=${c.minItems}`)
      if (c.maxItems !== undefined) args.push(`max_length=${c.maxItems}`)
      return { name: 'ListField', args }
    }
    case 'map':
      return { name: 'DictField', args: [`child=${render(valueField(context, type.value, null, here, module))}`] }
    case 'object': {
      const shared = context.layout.sharedSerializers()
      const className = `${pyClass(type.name)}Serializer`
      if (shared !== here) module.imports.add(shared, className)
      return { name: `__nested__${className}`, args: [] }
    }
  }
}

function render(field: { name: string; args: string[] }): string {
  if (field.name.startsWith('__nested__')) return `${field.name.slice(10)}(${field.args.join(', ')})`
  return `serializers.${field.name}(${field.args.join(', ')})`
}

/** The key type of a resource, as a DRF field: references to it are written with it. */
function keyValueField(context: DjangoContext, reference: string): string {
  const target = context.spec.resources.find((item) => item.name === reference)!
  const scalar = target.key.type.scalar
  return scalar === 'integer' ? 'serializers.IntegerField()' : scalar === 'uuid' ? 'serializers.UUIDField()' : 'serializers.CharField()'
}

/** One serializer field: its value, its access, whether it is required, its default and its source. */
function declaration(context: DjangoContext, resource: SpecResource | null, field: SpecField, here: string, module: ModuleRef): string {
  const options: string[] = []
  const isKey = resource !== null && field.name === resource.key.field
  const source = resource ? attr(field) : null
  if (source && source !== field.wire) options.push(`source=${pyString(source)}`)
  if (field.access === 'readOnly') options.push('read_only=True')
  else {
    if (field.access === 'writeOnly') options.push('write_only=True')
    options.push(`required=${field.required ? 'True' : 'False'}`)
    if (field.nullable) options.push('allow_null=True')
    if (!field.required && field.defaultValue !== undefined) options.push(`default=${pyLiteral(field.defaultValue)}`)
  }
  if (isKey && field.access === 'readOnly')
    return `    ${field.wire} = serializers.ReadOnlyField(${source && source !== field.wire ? `source=${pyString(source)}` : ''})`
  let value: { name: string; args: string[] }
  if (resource && isForeignKey(field)) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    const model = names(target).model
    const targetModule = moduleOf(context, target, 'models')
    module.imports.add(targetModule, model)
    value = { name: 'PrimaryKeyRelatedField', args: field.access === 'readOnly' ? [] : [`queryset=${model}.objects.all()`] }
  } else if (field.reference) {
    // A key, or a list of keys, of another resource, kept as plain values
    const keyField = keyValueField(context, field.reference)
    value =
      field.type.kind === 'array'
        ? { name: 'ListField', args: [`child=${keyField}`] }
        : { name: keyField.slice(12, keyField.indexOf('(')), args: [] }
  } else value = valueField(context, field.type, field, here, module)
  if (value.name.startsWith('__nested__')) {
    const many = field.type.kind === 'array'
    return `    ${field.wire} = ${value.name.slice(10)}(${[many ? 'many=True' : null, ...options].filter(Boolean).join(', ')})`
  }
  if (value.name === 'ListField' && field.type.kind === 'array' && field.type.items.kind === 'object') {
    const nested = valueField(context, field.type.items, null, here, module)
    return `    ${field.wire} = ${nested.name.slice(10)}(${['many=True', ...options].join(', ')})`
  }
  return `    ${field.wire} = serializers.${value.name}(${[...value.args, ...options].join(', ')})`
}

export function serializerBlocks(context: DjangoContext, modules: Modules) {
  const shared = context.layout.sharedSerializers()
  if (context.spec.objects.length > 0) {
    const module = modules.get(
      shared,
      context.settings.architecture === 'modular'
        ? 'Serializers of the embedded objects shared by the resources.'
        : 'Serializers of the API: requests in, responses out.',
    )
    module.imports.add('rest_framework', 'serializers')
    module.imports.add('config.validation', 'StrictSerializer')
    for (const object of declarationOrder(context.spec.objects)) {
      const fields = object.fields.map((field) => declaration(context, null, field, shared, module))
      module.blocks.push(
        [
          `class ${pyClass(object.name)}Serializer(StrictSerializer):`,
          `    """${object.description ?? `${object.name}, embedded in the resources that hold it.`}"""`,
          '',
          ...fields,
        ].join('\n'),
      )
    }
  }
  for (const resource of context.spec.resources) {
    const here = moduleOf(context, resource, 'serializers')
    const module = modules.get(
      here,
      context.settings.architecture === 'modular'
        ? `Serializer of ${resource.plural}: requests in, responses out.`
        : 'Serializers of the API: requests in, responses out.',
    )
    module.imports.add('rest_framework', 'serializers')
    module.imports.add('config.validation', 'StrictSerializer')
    const fields = resource.fields.map(
      (field) => `${field.todo ? `    # TODO: ${field.todo}\n` : ''}${declaration(context, resource, field, here, module)}`,
    )
    module.blocks.push(
      [
        `class ${names(resource).serializer}(StrictSerializer):`,
        `    """${capitalize(article(resource.singular))}: what a request may send and what a response shows."""`,
        '',
        ...fields,
      ].join('\n'),
    )
  }
}

/** Objects ordered so each is declared after the objects it holds (a Python class must exist before it is used). */
function declarationOrder<T extends { name: string; fields: SpecField[] }>(objects: T[]): T[] {
  const ordered: T[] = []
  const visiting = new Set<string>()
  const inner = (type: SpecType): string[] =>
    type.kind === 'object' ? [type.name] : type.kind === 'array' ? inner(type.items) : type.kind === 'map' ? inner(type.value) : []
  const visit = (object: T) => {
    if (ordered.includes(object) || visiting.has(object.name)) return
    visiting.add(object.name)
    for (const field of object.fields)
      for (const name of inner(field.type)) {
        const target = objects.find((item) => item.name === name)
        if (target) visit(target)
      }
    ordered.push(object)
  }
  objects.forEach(visit)
  return ordered
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
