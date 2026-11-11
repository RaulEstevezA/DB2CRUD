/**
 * Django models of the Django REST Framework project: enums as choices, and one model per resource.
 * A reference to one item is a foreign key that protects the item from deletion; embedded objects, lists
 * and maps are JSON fields; timestamps the server keeps use auto_now_add and auto_now.
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import { toScreamingSnakeCase } from '../../../model/naming.ts'
import { pyClass, pyLiteral, pyString, type PyImports } from '../../languages/python/python.ts'
import { attr, isForeignKey, moduleOf, names, type DjangoContext, type Modules } from './context.ts'

/** The imports and blocks of one module being written. */
type ModuleRef = { imports: PyImports; blocks: string[] }

/** Enum member names: `in progress` → `IN_PROGRESS`, `2` → `VALUE_2`. */
export function memberName(value: string | number, used: Set<string>): string {
  let name = toScreamingSnakeCase(String(value)) || 'VALUE'
  if (/^[0-9]/.test(name)) name = `VALUE_${name}`
  let unique = name
  for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`
  used.add(unique)
  return unique
}

export function enumBlocks(context: DjangoContext, modules: Modules) {
  if (context.spec.enums.length === 0) return
  const module = modules.get(
    context.layout.sharedEnums(),
    context.settings.architecture === 'modular' ? 'Enums shared by the resources.' : 'Models of the API and their enums.',
  )
  module.imports.add('django.db', 'models')
  for (const item of context.spec.enums) {
    const integer = item.valueType === 'integer'
    const used = new Set<string>()
    module.blocks.push(
      [
        `class ${pyClass(item.name)}(models.${integer ? 'IntegerChoices' : 'TextChoices'}):`,
        `    """Values of ${item.name}."""`,
        '',
        ...item.values.map((value) => `    ${memberName(value, used)} = ${pyLiteral(value)}, ${pyString(String(value))}`),
      ].join('\n'),
    )
  }
}

function enumClass(context: DjangoContext, name: string, here: string, module: ModuleRef): string {
  const shared = context.layout.sharedEnums()
  if (shared !== here) module.imports.add(shared, pyClass(name))
  return pyClass(name)
}

/** The model field of an API field. */
function modelField(context: DjangoContext, resource: SpecResource, field: SpecField, here: string, module: ModuleRef): string {
  const isKey = field.name === resource.key.field
  const args: string[] = []
  const optional = !isKey && (field.nullable || !field.required || field.server === 'pending')
  if (isKey) {
    if (resource.key.generated === 'increment') return 'models.BigAutoField(primary_key=True)'
    if (resource.key.generated === 'uuid') {
      module.imports.add('uuid')
      return resource.key.type.scalar === 'uuid'
        ? 'models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)'
        : 'models.CharField(primary_key=True, max_length=36, default=new_key, editable=False)'
    }
    args.push('primary_key=True')
  }
  if (isForeignKey(field)) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    const to = target.name === resource.name ? '"self"' : pyString(`${context.layout.app(target)}.${names(target).model}`)
    // PROTECT: an item other items refer to cannot be deleted (the API answers 409)
    return `models.ForeignKey(${[to, 'on_delete=models.PROTECT', 'related_name="+"', optional ? 'null=True' : null, optional ? 'blank=True' : null].filter(Boolean).join(', ')})`
  }
  if (field.server === 'created') return 'models.DateTimeField(auto_now_add=True)'
  if (field.server === 'updated') return 'models.DateTimeField(auto_now=True)'
  if (optional) args.push('null=True', 'blank=True')
  if (field.defaultValue !== undefined && field.defaultValue !== null) args.push(`default=${pyLiteral(field.defaultValue)}`)
  const type = field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((candidate) => candidate.name === type.name)!
    const className = enumClass(context, type.name, here, module)
    if (item.valueType === 'integer') return `models.IntegerField(${[`choices=${className}.choices`, ...args].join(', ')})`
    return `models.CharField(${[`max_length=${Math.max(1, ...item.values.map((value) => String(value).length))}`, `choices=${className}.choices`, ...args].join(', ')})`
  }
  if (type.kind !== 'scalar' || type.scalar === 'any') {
    module.imports.add('django.core.serializers.json', 'DjangoJSONEncoder')
    return `models.JSONField(${['encoder=DjangoJSONEncoder', ...args].join(', ')})`
  }
  const call = (name: string, extra: string[] = []) => `models.${name}(${[...extra, ...args].join(', ')})`
  switch (type.scalar) {
    case 'string':
      return field.constraints.maxLength !== undefined || isKey
        ? call('CharField', [`max_length=${field.constraints.maxLength ?? 255}`])
        : call('TextField')
    case 'integer':
      return call(type.bits === 64 ? 'BigIntegerField' : 'IntegerField')
    case 'float':
      return call('FloatField')
    case 'decimal':
      // A fixed size: MySQL and MariaDB need one
      return call('DecimalField', ['max_digits=18', 'decimal_places=4'])
    case 'boolean':
      return call('BooleanField')
    case 'date':
      return call('DateField')
    case 'datetime':
      return call('DateTimeField')
    case 'time':
      return call('TimeField')
    case 'duration':
      return call('CharField', ['max_length=64'])
    case 'uuid':
      return call('UUIDField')
    case 'binary':
      // Base64 text, as the API sends it
      return call('TextField')
  }
  return call('TextField')
}

export function modelBlocks(context: DjangoContext, modules: Modules) {
  for (const resource of context.spec.resources) {
    const here = moduleOf(context, resource, 'models')
    const module = modules.get(
      here,
      context.settings.architecture === 'modular' ? `Model of ${resource.plural}.` : 'Models of the API and their enums.',
    )
    module.imports.add('django.db', 'models')
    const name = names(resource)
    if (resource.key.generated === 'uuid' && resource.key.type.scalar !== 'uuid') {
      module.imports.add('uuid')
      if (!module.blocks.some((block) => block.startsWith('def new_key'))) {
        module.blocks.unshift(
          'def new_key() -> str:\n    """A new key for an item: a random UUID as text."""\n    return str(uuid.uuid4())',
        )
      }
    }
    const fields = resource.fields.map((field) => {
      const todo = field.todo ? `    # TODO: ${field.todo}\n` : ''
      return `${todo}    ${attr(field)} = ${modelField(context, resource, field, here, module)}`
    })
    module.blocks.push(
      [
        resource.todo ? `# TODO: ${resource.todo}` : null,
        `class ${name.model}(models.Model):`,
        `    """A stored ${resource.singular}."""`,
        '',
        ...fields,
        '',
        '    class Meta:',
        `        db_table = ${pyString(resource.plural.replace(/ /g, '_'))}`,
        `        ordering = [${pyString(`${attr(resource.fields.find((field) => field.name === resource.key.field)!)}`)}]`,
      ]
        .filter((line) => line !== null)
        .join('\n'),
    )
  }
}
