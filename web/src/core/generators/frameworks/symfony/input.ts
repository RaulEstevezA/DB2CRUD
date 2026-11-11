/**
 * Request bodies of the Symfony project: for each resource, the constraints of each shape (create or replace,
 * and partial update) as a Symfony Validator `Collection`, which rejects fields the contract does not describe
 * and tells a missing field from one sent as null, and the defaults of the fields a body leaves out.
 *
 * Symfony's format and pattern constraints let an empty text through; where the contract does not accept one,
 * `NotBlank(allowNull: true)` rejects it.
 */
import type { SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import { shapeFields } from '../../../openapi/build.ts'
import { patternAccepts } from '../../common/samples.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpClass, phpDoc, phpHeader, phpRegex, phpString } from '../../languages/php/php.ts'
import { fieldDefaults } from '../../languages/php/model.ts'
import { article } from '../../languages/php/project.ts'
import { classPath, names, type SymfonyContext } from './context.ts'

const DATE_TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$'
const TIME = '^\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$'
const DURATION = '^P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+(\\.\\d+)?S)?)?$'
const BASE64 = '^[A-Za-z0-9+\\/]*={0,2}$'

/** A constraint: one line, or several already indented relative to its first one. */
type Node = string | string[]

/** A list of constraints: on one line when they fit, one per line otherwise. */
function list(open: string, nodes: Node[], close: string): Node {
  const inline = `${open}${nodes.join(', ')}${close}`
  if (nodes.every((node) => typeof node === 'string') && inline.length <= 100) return inline
  const inner = nodes.flatMap((node) => {
    const nodeLines = typeof node === 'string' ? [node] : node
    return nodeLines.map((line, index) => `    ${line}${index === nodeLines.length - 1 ? ',' : ''}`)
  })
  return [open.trimEnd(), ...inner, close.trimStart()]
}

function regex(pattern: string): string {
  return `new Assert\\Regex(pattern: ${phpString(phpRegex(pattern))})`
}

const BLANK = 'new Assert\\NotBlank(allowNull: true)'

/** The constraints of a value of a type, without presence and nullability. */
function typeConstraints(context: SymfonyContext, type: SpecType, field: SpecField | null, imports: PhpImports, depth: number): Node[] {
  const c = field?.constraints ?? {}
  switch (type.kind) {
    case 'scalar':
      switch (type.scalar) {
        case 'string': {
          const nodes: Node[] = ["new Assert\\Type('string')"]
          if (c.format === 'email') nodes.push('new Assert\\Email()')
          if (c.format === 'uri') nodes.push('new Assert\\Url(requireTld: false)')
          if (c.format === 'uuid') nodes.push('new Assert\\Uuid()')
          if (c.format === 'date') nodes.push('new Assert\\Date()')
          if (c.format === 'date-time') nodes.push(regex(DATE_TIME))
          if (c.format === 'time') nodes.push(regex(TIME))
          if (c.minLength !== undefined || c.maxLength !== undefined) {
            const args = [
              c.minLength !== undefined ? `min: ${c.minLength}` : null,
              c.maxLength !== undefined ? `max: ${c.maxLength}` : null,
            ]
            nodes.push(`new Assert\\Length(${args.filter(Boolean).join(', ')})`)
          }
          if (c.pattern !== undefined) nodes.push(regex(c.pattern))
          if (c.format || (c.pattern !== undefined && !patternAccepts(c.pattern, ''))) nodes.push(BLANK)
          return nodes
        }
        case 'integer':
        case 'float':
        case 'decimal': {
          const nodes: Node[] = [type.scalar === 'integer' ? "new Assert\\Type('integer')" : "new Assert\\Type(['integer', 'float'])"]
          if (c.minimum !== undefined) nodes.push(`new Assert\\GreaterThanOrEqual(${c.minimum})`)
          if (c.maximum !== undefined) nodes.push(`new Assert\\LessThanOrEqual(${c.maximum})`)
          if (c.exclusiveMinimum !== undefined) nodes.push(`new Assert\\GreaterThan(${c.exclusiveMinimum})`)
          if (c.exclusiveMaximum !== undefined) nodes.push(`new Assert\\LessThan(${c.exclusiveMaximum})`)
          return nodes
        }
        case 'boolean':
          return ["new Assert\\Type('bool')"]
        case 'date':
          return ["new Assert\\Type('string')", 'new Assert\\Date()', BLANK]
        case 'datetime':
          return ["new Assert\\Type('string')", regex(DATE_TIME), BLANK]
        case 'time':
          return ["new Assert\\Type('string')", regex(TIME), BLANK]
        case 'duration':
          return ["new Assert\\Type('string')", regex(DURATION), BLANK]
        case 'uuid':
          return ["new Assert\\Type('string')", 'new Assert\\Uuid()', BLANK]
        case 'binary':
          return ["new Assert\\Type('string')", regex(BASE64)]
        case 'any':
          return []
      }
      return []
    case 'enum': {
      const enumClass = phpClass(type.name)
      imports.add(`${context.layout.enums()}\\${enumClass}`)
      return [`new Assert\\Choice(choices: array_column(${enumClass}::cases(), 'value'))`]
    }
    case 'array': {
      const nodes: Node[] = ["new Assert\\Type('list')"]
      if (c.minItems !== undefined || c.maxItems !== undefined) {
        const args = [c.minItems !== undefined ? `min: ${c.minItems}` : null, c.maxItems !== undefined ? `max: ${c.maxItems}` : null]
        nodes.push(`new Assert\\Count(${args.filter(Boolean).join(', ')})`)
      }
      const items = typeConstraints(context, type.items, null, imports, depth + 1)
      nodes.push(list('new Assert\\All([', ['new Assert\\NotNull()', ...items], '])'))
      return nodes
    }
    case 'map': {
      const values = typeConstraints(context, type.value, null, imports, depth + 1)
      return [
        "new Assert\\Type('array')",
        ...(values.length > 0 ? [list('new Assert\\All([', ['new Assert\\NotNull()', ...values], '])')] : []),
      ]
    }
    case 'object': {
      const object = context.spec.objects.find((item) => item.name === type.name)
      if (!object || depth > 4) return ["new Assert\\Type('array')"]
      return ["new Assert\\Type('array')", collection(context, object.fields, 'object', imports, depth + 1)]
    }
  }
}

/** The constraints of the key a reference holds: the type of the target's key. */
function referenceConstraints(context: SymfonyContext, field: SpecField): Node[] {
  const target = context.spec.resources.find((item) => item.name === field.reference)!
  if (target.key.type.scalar === 'integer') return ["new Assert\\Type('integer')"]
  if (target.key.type.scalar === 'uuid') return ["new Assert\\Type('string')", 'new Assert\\Uuid()', BLANK]
  return ["new Assert\\Type('string')"]
}

/** A field of a Collection: required or optional, with its constraints. */
function fieldEntry(
  context: SymfonyContext,
  field: SpecField,
  shape: 'create' | 'update' | 'object',
  imports: PhpImports,
  depth: number,
): string[] {
  const required = shape !== 'update' && field.required
  const nodes: Node[] = field.nullable ? [] : ['new Assert\\NotNull()']
  if (field.reference) {
    const key = referenceConstraints(context, field)
    if (field.type.kind === 'array')
      nodes.push("new Assert\\Type('list')", list('new Assert\\All([', ['new Assert\\NotNull()', ...key], '])'))
    else nodes.push(...key)
  } else nodes.push(...typeConstraints(context, field.type, field, imports, depth))
  const wrapped = list(required ? 'new Assert\\Required([' : 'new Assert\\Optional([', nodes, '])')
  const entry = typeof wrapped === 'string' ? [wrapped] : wrapped
  const todo = field.todo ? [`// TODO: ${field.todo}`] : []
  return [...todo, `${phpString(field.wire)} => ${entry[0]}`, ...entry.slice(1)]
}

/** A Collection of fields: every one described, none other allowed. */
function collection(
  context: SymfonyContext,
  fields: SpecField[],
  shape: 'create' | 'update' | 'object',
  imports: PhpImports,
  depth: number,
): string[] {
  const entries = fields.flatMap((field) => {
    const entry = fieldEntry(context, field, shape, imports, depth)
    return entry.map((line, index) => `    ${line}${index === entry.length - 1 ? ',' : ''}`)
  })
  return entries.length > 0 ? ['new Assert\\Collection(fields: [', ...entries, '])'] : ['new Assert\\Collection(fields: [])']
}

/** The input class of a resource: the constraints of each shape and the defaults of a creation. */
export function inputFile(context: SymfonyContext, resource: SpecResource): GeneratedFile | null {
  if (!resource.endpoints.some((endpoint) => endpoint.input !== 'none')) return null
  const namespace = context.layout.resource(resource, 'input')
  const name = names(resource)
  const imports = new PhpImports(namespace).add('Symfony\\Component\\Validator\\Constraints as Assert')
  const shape = (kind: 'create' | 'update') => {
    const body = collection(context, shapeFields(resource.fields, kind), kind, imports, 0)
    const statement = [`return ${body[0]}`, ...body.slice(1)]
    statement[statement.length - 1] += ';'
    return statement.map((line) => `        ${line}`)
  }
  // The shapes go first: they add the imports of the enums the header lists.
  const createShape = shape('create')
  const updateShape = shape('update')
  const createDefaults = fieldDefaults(context, shapeFields(resource.fields, 'create'), '$values', 0, true)
  const updateDefaults = fieldDefaults(context, shapeFields(resource.fields, 'update'), '$values', 0, false)
  const content = lines(
    ...phpHeader(namespace, imports),
    phpDoc(`Bodies of the requests that create, replace or change part of ${article(resource.singular)}.`),
    `final class ${name.input}`,
    '{',
    `    /** The body of a request that creates or replaces ${article(resource.singular)}. */`,
    '    public static function create(): Assert\\Collection',
    '    {',
    createShape,
    '    }',
    '',
    `    /** The body of a request that changes part of ${article(resource.singular)}: only the fields sent change. */`,
    '    public static function update(): Assert\\Collection',
    '    {',
    updateShape,
    '    }',
    '',
    '    /**',
    '     * @param  array<string, mixed>  $values',
    '     * @return array<string, mixed> The values of a creation, with the defaults of the fields left out.',
    '     */',
    '    public static function createValues(array $values): array',
    '    {',
    createDefaults.map((line) => `        ${line}`),
    createDefaults.length > 0 && '',
    '        return $values;',
    '    }',
    '',
    '    /**',
    '     * @param  array<string, mixed>  $values',
    '     * @return array<string, mixed> The values of a change, with the defaults inside the objects sent.',
    '     */',
    '    public static function updateValues(array $values): array',
    '    {',
    updateDefaults.map((line) => `        ${line}`),
    updateDefaults.length > 0 && '',
    '        return $values;',
    '    }',
    '}',
  )
  return { path: classPath(namespace, name.input), content: fileText(content) }
}
