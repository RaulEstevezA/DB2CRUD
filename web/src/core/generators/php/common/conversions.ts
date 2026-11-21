/**
 * The conversions between the application models and the tables (conversions/plan.ts), written in PHP: per table, a
 * final class of static methods, one that turns a model into what the service takes (its create DTO, or the entity)
 * and one that turns what it returns into the model. Values are converted between the model's PHP types and the
 * column's (int, float and text, decimals kept as text, dates and times, enums by a match), as strict types ask;
 * lookups go through the repositories of the unit of work; Mapper's transformations are plain expressions; what the
 * plan leaves to the user is a `// TODO:` with the reason.
 *
 * Models are read and built as the application has them: public properties or getters, a constructor with named
 * arguments or properties set one by one. They are copied into the project (`settings.modelsModule` as their
 * namespace, in PascalCase) or, with `modelsSource: 'import'`, used from the user's namespace: the copy then goes to
 * `application-models/`, which Composer loads for that namespace (delete it inside the application).
 */
import {
  withoutHidden,
  type ConversionPlan,
  type ModelPath,
  type ReadValue,
  type Todo,
  type WriteValue,
} from '../../../conversions/plan.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import type { MapperTransform } from '../../../interop/mapper/read.ts'
import type { EnumDef, FieldDef, ModelDef, ModelSchema, TypeRef } from '../../../model/schema.ts'
import type { Line } from '../../types.ts'
import {
  className,
  columnOf,
  errorClass,
  findInfo,
  namespaceOf,
  pathOf,
  phpFile,
  query,
  queryName,
  rootClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createDto, readColumns, readDto } from './dtos.ts'
import { access, fieldName, pascalName, phpLiteral, phpString, PhpUses } from './php.ts'
import { testFile } from './tests.ts'

/** The folder of the copy of the models when they are imported from the user's namespace. */
export const MODELS_FOLDER = 'application-models'

/** The namespace of the application models: `app.application_models` → `App\ApplicationModels`. */
export const modelsNamespace = (context: Context) => context.settings.modelsModule.split('.').map(pascalName).join('\\')

const usesDtos = (context: Context, info: TableInfo) =>
  context.settings.services && context.settings.serviceTypes === 'dtos' && info.service !== null && info.role === 'entity'

/** The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them. */
export const servicePlans = (context: Context, plans: ConversionPlan[]) =>
  plans.map((plan) => {
    const info = findInfo(context, plan.table)
    return info && usesDtos(context, info) ? withoutHidden(plan, info.hidden) : plan
  })

/** The namespace of the conversions of a table, by architecture. */
export const conversionsNamespace = (context: Context, info: TableInfo) =>
  context.settings.architecture === 'table' ? `${context.base}\\Tables\\${info.folder}` : `${context.base}\\Conversions`

export const conversionsClass = (info: TableInfo) => `${info.entity}Conversions`

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/**
 * The names of a plan: its methods, the classes they take and return, and the name the model is used by (an alias,
 * `ProductModel`, when it is named like the entity or a DTO of the same file).
 */
export function conversionNames(context: Context, plan: ConversionPlan) {
  const info = findInfo(context, plan.table)!
  const dtos = usesDtos(context, info)
  const target = dtos ? createDto(info) : info.entity
  const source = dtos ? readDto(info) : info.entity
  const clash = [info.entity, target, source].includes(plan.model)
  const model = clash ? `${plan.model}Model` : plan.model
  return { write: `${lowerFirst(model)}To${target}`, read: `${lowerFirst(source)}To${model}`, target, source, model, clash }
}

// Types of the models

interface Models {
  schema: ModelSchema
  namespace: string
  /** The uses of the file being written: an enum the values name is used by its class */
  uses?: PhpUses
}

/** A model read from PHP keeps its names; the others get PHP's camelCase. */
const fromPhp = (model: ModelDef) => model.fields.some((field) => field.originalType !== undefined)

const memberOf = (model: ModelDef | undefined, name: string) => (model && fromPhp(model) ? name : fieldName(name))

/** The PHP type of a model's TypeRef, for models not read from PHP. */
function typeRefPhp(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return {
        string: 'string',
        integer: 'int',
        float: 'float',
        decimal: 'string',
        boolean: 'bool',
        date: '\\DateTimeImmutable',
        datetime: '\\DateTimeImmutable',
        time: '\\DateTimeImmutable',
        duration: 'string',
        uuid: 'string',
        binary: 'string',
        any: 'mixed',
      }[type.name]
    case 'array':
    case 'map':
      return 'array'
    case 'model':
    case 'enum':
      return type.name
    case 'unknown':
      return 'mixed'
  }
}

/** The PHP type of a field, as the model has it (with `?` when it may be null). */
function fieldPhp(model: ModelDef | undefined, field: FieldDef): string {
  if (model && fromPhp(model) && field.originalType) return field.originalType.trim()
  const type = typeRefPhp(field.type)
  return (field.nullable || field.optional) && type !== 'mixed' ? `?${type}` : type
}

/** How a model is read and built. */
function styleOf(model: ModelDef): { getters: boolean; named: boolean } {
  return { getters: model.metadata?.accessors === 'getters', named: model.construction === 'named' }
}

/** The case of an enum value in PHP. */
const enumCase = (item: EnumDef, value: EnumDef['values'][number]) =>
  item.values.every((other) => /^[A-Z][A-Za-z0-9]*$/.test(other.name)) ? value.name : pascalName(value.name)

/** The text an enum value is stored as: its string value, or its name. */
const enumText = (value: EnumDef['values'][number]) => (typeof value.value === 'string' ? value.value : value.name)

/** The models and enums a set of models needs, in the order of the schema. */
function closure(schema: ModelSchema, names: string[]): { models: ModelDef[]; enums: EnumDef[] } {
  const models = new Set<string>()
  const enums = new Set<string>()
  const visit = (type: TypeRef) => {
    if (type.kind === 'array') visit(type.items)
    else if (type.kind === 'map') visit(type.value)
    else if (type.kind === 'enum') enums.add(type.name)
    else if (type.kind === 'model') add(type.name)
  }
  const add = (name: string) => {
    const model = schema.models.find((item) => item.name === name)
    if (!model || models.has(name)) return
    models.add(name)
    for (const parent of model.extends ?? []) add(parent)
    for (const field of model.fields) visit(field.type)
  }
  for (const name of names) add(name)
  return { models: schema.models.filter((model) => models.has(model.name)), enums: schema.enums.filter((item) => enums.has(item.name)) }
}

const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/** The class of a copied model, as the application has it. */
function modelClass(model: ModelDef): string[] {
  const { getters, named } = styleOf(model)
  const fields = model.fields.map((field) => ({ type: fieldPhp(model, field), name: memberOf(model, field.name) }))
  const doc = `/** ${model.name}, as the application has it. */`
  const parent = model.extends?.length ? ` extends ${model.extends[0]}` : ''
  if (named)
    return [
      doc,
      `class ${model.name}${parent}`,
      '{',
      '    public function __construct(',
      ...fields.map((field) => `        public ${field.type} $${field.name},`),
      '    ) {',
      '    }',
      '}',
    ]
  if (!getters) return [doc, `class ${model.name}${parent}`, '{', ...fields.map((field) => `    public ${field.type} $${field.name};`), '}']
  return [
    doc,
    `class ${model.name}${parent}`,
    '{',
    ...fields.map((field) => `    private ${field.type} $${field.name};`),
    ...fields.flatMap((field) => [
      '',
      `    public function get${capitalized(field.name)}(): ${field.type}`,
      '    {',
      `        return $this->${field.name};`,
      '    }',
      '',
      `    public function set${capitalized(field.name)}(${field.type} $${field.name}): void`,
      '    {',
      `        $this->${field.name} = $${field.name};`,
      '    }',
    ]),
    '}',
  ]
}

/** The copy of the application models the conversions use: a class or enum per file. */
export function modelFiles(context: Context, schema: ModelSchema, plans: ConversionPlan[]): GeneratedFile[] {
  const ns = modelsNamespace(context)
  const { models, enums } = closure(schema, [...new Set(plans.map((plan) => plan.model))])
  const path = (name: string) => (context.settings.modelsSource === 'copy' ? pathOf(ns, name) : `${MODELS_FOLDER}/${name}.php`)
  return [
    ...enums.map((item) => {
      const backing = item.values.every((value) => typeof value.value === 'string')
        ? ': string'
        : item.values.every((value) => typeof value.value === 'number')
          ? ': int'
          : ''
      return phpFile(path(item.name), ns, '', [
        `/** ${item.name}, as the application has it. */`,
        `enum ${item.name}${backing}`,
        '{',
        ...item.values.map((value) => `    case ${enumCase(item, value)}${backing ? ` = ${phpLiteral(value.value!)}` : ''};`),
        '}',
      ])
    }),
    ...models.map((model) => phpFile(path(model.name), ns, '', modelClass(model))),
  ]
}

// Values

interface Typed {
  expression: string
  /** The type without `?` or the leading backslash */
  type: string
  nullable: boolean
  /** Never null: a transformation's result */
  present?: boolean
}

const typed = (expression: string, type: string, nullable = false, present = false): Typed => ({
  expression,
  type: type.replace(/^\?/, '').replace(/^\\/, ''),
  nullable: nullable || type.startsWith('?'),
  present,
})

interface Body {
  lines: string[]
  uses: PhpUses
  uow: boolean
  helpers: Set<'pair' | 'part' | 'rest'>
}

const DATES = new Set(['DateTimeImmutable', 'DateTimeInterface', 'DateTime'])

/** A value that is there, of one PHP type, as another; null when DB2CRUD does not convert them. */
function core(models: Models, expression: string, from: string, to: string): string | null {
  if (from === to || to === 'mixed' || (DATES.has(from) && DATES.has(to))) return expression
  const fromEnum = models.schema.enums.find((item) => item.name === from)
  const toEnum = models.schema.enums.find((item) => item.name === to)
  for (const item of [fromEnum, toEnum]) if (item) models.uses?.add(className(models.namespace, item.name))
  if (fromEnum && to === 'string')
    return `match (${expression}) { ${fromEnum.values.map((item) => `${from}::${enumCase(fromEnum, item)} => ${phpString(enumText(item))}`).join(', ')} }`
  if (toEnum && from === 'string')
    return `match (${expression}) { ${toEnum.values.map((item) => `${phpString(enumText(item))} => ${to}::${enumCase(toEnum, item)}`).join(', ')}, default => throw new \\ValueError('No ${to} for this value') }`
  if (to === 'int' && ['float', 'string', 'bool'].includes(from)) return `(int) ${expression}`
  if (to === 'float' && ['int', 'string'].includes(from)) return `(float) ${expression}`
  if (to === 'string') {
    if (from === 'int' || from === 'float') return `(string) ${expression}`
    if (from === 'bool') return `(${expression} ? 'true' : 'false')`
    if (DATES.has(from)) return `${expression}->format(DATE_ATOM)`
    return null
  }
  if (from === 'string') {
    if (to === 'bool') return `filter_var(${expression}, FILTER_VALIDATE_BOOLEAN)`
    if (DATES.has(to)) return `new \\DateTimeImmutable(${expression})`
  }
  return null
}

/**
 * A value as another PHP type (`?` when it may be null), or null when DB2CRUD does not convert them. A value that may
 * be null stays null.
 */
function convert(models: Models, value: Typed, to: string): string | null {
  const target = to.replace(/^\?/, '').replace(/^\\/, '')
  const converted = core(models, value.expression, value.type, target)
  if (converted === null || converted === value.expression || !value.nullable || value.present) return converted
  return `(${value.expression} === null ? null : ${converted})`
}

/** A PHP literal of a Mapper constant, with its type. */
function literal(value: string | number | boolean | null): Typed {
  if (value === null) return typed('null', 'mixed', true)
  if (typeof value === 'string') return typed(phpString(value), 'string', false, true)
  if (typeof value === 'boolean') return typed(String(value), 'bool', false, true)
  return typed(String(value), Number.isInteger(value) ? 'int' : 'float', false, true)
}

const INVERSE = { '*': '/', '/': '*', '+': '-', '-': '+' } as const

/** The transformation that undoes an invertible one. */
function inverse(transform: MapperTransform): MapperTransform {
  if (transform.kind === 'arithmetic') return { ...transform, operator: INVERSE[transform.operator] }
  if (transform.kind === 'enum') return { kind: 'enum', pairs: transform.pairs.map((pair) => ({ from: pair.to, to: pair.from })) }
  return transform
}

/** A value as the text Mapper compares: enums by their stored text. */
function text(models: Models, value: Typed): string {
  if (models.schema.enums.some((item) => item.name === value.type)) return convert(models, value, '?string') ?? value.expression
  if (value.type === 'string') return value.expression
  return `(string) ${value.expression}`
}

/** A Mapper transformation of typed values, as an expression of the type it gives; null when it cannot be written. */
function transformed(models: Models, transform: MapperTransform, values: Typed[], target: string, body: Body): Typed | null {
  const value = values[0]
  const present = (item: Typed): Typed => ({ ...item, present: true })
  switch (transform.kind) {
    case 'direct':
      return value
    case 'concat':
      return typed(
        `implode(${phpString(transform.separator)}, [${values.map((item) => text(models, item)).join(', ')}])`,
        'string',
        false,
        true,
      )
    case 'split':
      if (transform.part === 'rest') {
        body.helpers.add('rest')
        return typed(`self::rest(${text(models, value)}, ${phpString(transform.separator)})`, 'string', false, true)
      }
      body.helpers.add('part')
      return typed(
        `self::part(${text(models, value)}, ${phpString(transform.separator)}, ${transform.part === 'last' ? -1 : transform.part})`,
        'string',
        false,
        true,
      )
    case 'constant':
      return literal(transform.value)
    case 'boolean':
      return typed(
        `in_array(${text(models, value)}, [${transform.trueValues.map((item) => phpString(item)).join(', ')}], true)`,
        'bool',
        false,
        true,
      )
    case 'enum': {
      body.helpers.add('pair')
      const pairs = transform.pairs.map((pair) => `${phpString(pair.from)} => ${phpString(pair.to)}`).join(', ')
      const fallback = transform.fallback !== undefined ? phpString(transform.fallback) : 'null'
      return typed(`self::pair([${pairs}], ${text(models, value)}, ${fallback})`, 'string', false, true)
    }
    case 'epoch': {
      const milliseconds = transform.unit === 'milliseconds'
      const plain = target.replace(/^\?/, '')
      // From a date and time: a number; from a number: a date and time
      if (plain === 'int' || plain === 'float' || plain === 'string') {
        const moment = convert(models, present(value), 'DateTimeImmutable')
        if (moment === null) return null
        return typed(`${moment}->getTimestamp()${milliseconds ? ' * 1000' : ''}`, 'int', false, true)
      }
      const number = convert(models, present(value), 'int')
      if (number === null) return null
      return typed(`new \\DateTimeImmutable('@' . ${milliseconds ? `intdiv(${number}, 1000)` : number})`, 'DateTimeImmutable', false, true)
    }
    case 'arithmetic': {
      const number = convert(models, present(value), 'float')
      if (number === null) return null
      return typed(`(${number} ${transform.operator} ${literal(transform.operand).expression})`, 'float', false, true)
    }
    default:
      return null
  }
}

/** A typed value as the type a column or field has: whole numbers rounded, decimals with their scale. */
function fit(models: Models, result: Typed, to: string, column?: ColumnInfo): string | null {
  const plain = to.replace(/^\?/, '')
  if (result.type === 'float' && plain === 'int') return `(int) round(${result.expression})`
  if (result.type === 'float' && plain === 'string' && column?.column.type.kind === 'decimal')
    return `number_format(${result.expression}, ${column.column.type.scale ?? 0}, '.', '')`
  return convert(models, result, to)
}

// Conversions

const WHY: Record<Todo['reason'], string> = {
  pending: 'the matching waits for review',
  noField: 'no field of the model gives it',
  oneWay: "Mapper's relation only goes the other way",
  unsupported: 'DB2CRUD does not write this conversion',
  hidden: 'the service never returns it',
}
const todoText = (todo: Todo) => `${WHY[todo.reason]}${todo.detail ? ` (${todo.detail})` : ''}`

/** `A Customer`, `An Order`. */
const article = (name: string) => `${/^[AEIOU]/i.test(name) ? 'An' : 'A'} ${name}`

/** One value of a call or of a block, with the comment that explains it. */
interface Value {
  name: string
  expression: string | null
  todo?: string
}

/** How a field of a model is read: `$model->name` or `$model->getName()`. */
const read = (model: ModelDef, field: FieldDef, root: string) =>
  styleOf(model).getters ? `${root}->get${capitalized(memberOf(model, field.name))}()` : access(root, memberOf(model, field.name))

/** The field of a model a path names, with how it is read, walking nested models. */
function walk(models: Models, model: ModelDef | undefined, path: ModelPath, root: string): Typed | null {
  let current = model
  let result: Typed | null = null
  let expression = root
  for (const part of path) {
    const field = current?.fields.find((item) => item.name === part)
    if (!current || !field) return null
    expression = read(current, field, expression).replace(/->(?=[^>]*$)/, result?.nullable ? '?->' : '->')
    result = typed(expression, fieldPhp(current, field), result?.nullable ?? false)
    current =
      field.type.kind === 'model' ? models.schema.models.find((item) => item.name === (field.type as { name: string }).name) : undefined
  }
  return result
}

function writeExpression(
  context: Context,
  models: Models,
  column: ColumnInfo,
  value: Exclude<WriteValue, Todo>,
  model: ModelDef | undefined,
  body: Body,
): { expression: string | null; todo?: string } {
  const unsupported = (detail: string) => ({ expression: null, todo: `${WHY.unsupported} (${detail})` })
  const source = (path: ModelPath) => walk(models, model, path, '$model')
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(column.field)
    const converted = fit(models, result, column.php, column)
    return converted === null ? unsupported(`${result.type} to ${column.php}`) : { expression: converted }
  }
  switch (value.kind) {
    case 'field':
      return finish(source(value.path))
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && query(other, 'findByUnique', [value.by])
      const given = source(value.path)
      if (!other || !finder || !given) return { expression: null, todo: 'no repository query finds the row it names' }
      const by = columnOf(other, value.by)
      const argument = convert(models, given, by.php)
      if (argument === null) return unsupported(`${given.type} to ${by.php}`)
      const name = `$${fieldName(other.entity)}`
      body.uow = true
      body.uses.add(errorClass(context, 'NotFoundException'))
      body.lines.push(
        `${name} = $uow->${other.attr}->${queryName(context, finder)}(${argument})`,
        `    ?? throw new NotFoundException(${phpString(other.entity)}, ${given.expression});`,
      )
      const key = columnOf(other, value.key)
      return finish(typed(access(name, key.prop), key.php))
    }
    case 'mapper': {
      const sources = value.sources.map(source)
      if (sources.some((item) => item === null)) return unsupported(column.field)
      return finish(transformed(models, value.transform, sources as Typed[], column.php, body))
    }
    case 'inverse': {
      const given = source(value.path)
      return finish(given && transformed(models, inverse(value.transform), [given], column.php, body))
    }
  }
}

function readExpression(
  context: Context,
  models: Models,
  info: TableInfo,
  dtos: boolean,
  model: ModelDef,
  field: FieldDef,
  value: Exclude<ReadValue, Todo>,
  body: Body,
): { expression: string | null; todo?: string } {
  const target = fieldPhp(model, field)
  // What the service returns: a DTO by its fields, an entity by its properties
  const own = (name: string) => {
    const column = columnOf(info, name)
    return typed(dtos ? `$row->${column.field}` : access('$row', column.prop), column.php, column.column.nullable)
  }
  const unsupported = (detail: string) => ({ expression: null, todo: `${WHY.unsupported} (${detail})` })
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(field.name)
    const converted = fit(models, result, target)
    return converted === null ? unsupported(`${result.type} to ${target}`) : { expression: converted }
  }
  switch (value.kind) {
    case 'column':
      return finish(own(value.column))
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && (query(other, 'getByKey') ?? query(other, 'findByUnique', [value.key]))
      if (!other || !finder) return { expression: null, todo: 'no repository query reads it' }
      const name = `$${fieldName(other.entity)}`
      const key = own(value.column)
      body.uow = true
      const found = `$uow->${other.attr}->${queryName(context, finder)}(${key.expression})`
      body.lines.push(key.nullable ? `${name} = ${key.expression} === null ? null : ${found};` : `${name} = ${found};`)
      const by = columnOf(other, value.by)
      return finish(typed(access(name, by.prop).replace('->', '?->'), by.php, true))
    }
    case 'children': {
      const other = findInfo(context, value.table)
      const lister = other && (query(other, 'listByParent', [value.by]) ?? query(other, 'findAllBy', [value.by]))
      if (!other || !lister) return { expression: null, todo: 'no repository query reads it' }
      body.uow = true
      const item = columnOf(other, value.value)
      const element = field.type.kind === 'array' ? typeRefPhp(field.type.items) : item.php
      const converted = convert(models, typed(access('$item', item.prop), item.php), element)
      if (converted === null) return unsupported(`${item.php} to ${element}`)
      return {
        expression: `array_map(fn ($item) => ${converted}, $uow->${other.attr}->${queryName(context, lister)}(${own(value.key).expression}))`,
      }
    }
    case 'mapper':
      return finish(transformed(models, value.transform, value.columns.map(own), target, body))
    case 'inverse':
      return finish(transformed(models, inverse(value.transform), [own(value.column)], target, body))
  }
}

const HELPERS = {
  pair: [
    '/**',
    ' * The value an enum pair gives, or the fallback; a value without a pair is an error.',
    ' *',
    ' * @param array<string, string> $pairs',
    ' */',
    'private static function pair(array $pairs, string $value, ?string $fallback): string',
    '{',
    '    return $pairs[$value] ?? $fallback ?? throw new \\ValueError("No pair for {$value}");',
    '}',
  ],
  part: [
    '/** One part of a text split by a separator (the last one for -1), or an empty text. */',
    'private static function part(string $value, string $separator, int $index): string',
    '{',
    '    $parts = explode($separator, $value);',
    "    return $parts[$index < 0 ? count($parts) - 1 : $index] ?? '';",
    '}',
  ],
  rest: [
    '/** What follows the first separator of a text, or an empty text. */',
    'private static function rest(string $value, string $separator): string',
    '{',
    '    $at = strpos($value, $separator);',
    "    return $at === false ? '' : substr($value, $at + strlen($separator));",
    '}',
  ],
}

const comment = (value: Value) => (value.todo ? ` // TODO: ${value.name}: ${value.todo}` : '')

/** The class of the conversions of one table: one method per direction its models go. */
export function conversionFile(context: Context, plans: ConversionPlan[], schema: ModelSchema): GeneratedFile | null {
  const info = findInfo(context, plans[0].table)
  if (!info) return null
  const ns = conversionsNamespace(context, info)
  const uses = new PhpUses(ns)
  const models: Models = { schema, namespace: modelsNamespace(context), uses }
  const helpers = new Set<'pair' | 'part' | 'rest'>()
  const methods: string[][] = []
  const dtos = usesDtos(context, info)
  for (const plan of plans) {
    const model = schema.models.find((item) => item.name === plan.model)
    const names = conversionNames(context, plan)
    uses.add(`${className(models.namespace, plan.model)}${names.clash ? ` as ${names.model}` : ''}`)
    if (plan.write) {
      const body: Body = { lines: [], uses, uow: false, helpers }
      const values: Value[] = []
      for (const item of plan.write) {
        const column = columnOf(info, item.column)
        if (item.value.kind === 'todo') values.push({ name: column.field, expression: null, todo: todoText(item.value) })
        else values.push({ name: column.field, ...writeExpression(context, models, column, item.value, model, body) })
      }
      let result: string[]
      if (dtos) {
        uses.add(className(namespaceOf(context, info, 'dtos'), names.target))
        // Named arguments: the fields left out take their default, null
        result = [
          `    return new ${names.target}(`,
          ...values.map((value) =>
            value.expression === null
              ? `        //${comment(value).slice(3)}`
              : `        ${value.name}: ${value.expression},${comment(value)}`,
          ),
          '    );',
        ]
      } else {
        uses.add(className(namespaceOf(context, info, 'entity'), info.entity))
        result = [
          `    $entity = new ${info.entity}();`,
          ...values.map((value) => {
            const column = info.columns.find((item) => item.field === value.name)!
            return value.expression === null
              ? `    //${comment(value).slice(3)}`
              : `    ${access('$entity', column.prop)} = ${value.expression};${comment(value)}`
          }),
          '    return $entity;',
        ]
      }
      if (body.uow) uses.add(rootClass(context, 'UnitOfWork'))
      methods.push([
        `/** ${article(plan.model)} as the ${info.name} table takes it. */`,
        `public static function ${names.write}(${names.model} $model${body.uow ? ', UnitOfWork $uow' : ''}): ${names.target}`,
        '{',
        ...body.lines.map((line) => `    ${line}`),
        ...result,
        '}',
      ])
    }
    if (plan.read && model) {
      const body: Body = { lines: [], uses, uow: false, helpers }
      const values: Value[] = []
      for (const field of model.fields) {
        const item = plan.read.find((candidate) => candidate.field === field.name)
        const name = memberOf(model, field.name)
        if (!item) values.push({ name, expression: null })
        else if (item.value.kind === 'todo') values.push({ name, expression: null, todo: todoText(item.value) })
        else values.push({ name, ...readExpression(context, models, info, dtos, model, field, item.value, body) })
      }
      uses.add(className(namespaceOf(context, info, dtos ? 'dtos' : 'entity'), names.source))
      if (body.uow) uses.add(rootClass(context, 'UnitOfWork'))
      const { getters, named } = styleOf(model)
      const result = named
        ? [
            `    return new ${names.model}(`,
            ...values.map((value) => `        ${value.name}: ${value.expression ?? 'null'},${comment(value)}`),
            '    );',
          ]
        : [
            `    $model = new ${names.model}();`,
            // Built by its properties: the fields the plan does not give keep the model's defaults
            ...values
              .filter((value) => value.expression !== null || value.todo)
              .map((value) =>
                value.expression === null
                  ? `    //${comment(value).slice(3)}`
                  : getters
                    ? `    $model->set${capitalized(value.name)}(${value.expression});${comment(value)}`
                    : `    ${access('$model', value.name)} = ${value.expression};${comment(value)}`,
              ),
            '    return $model;',
          ]
      methods.push([
        `/** A row of the ${info.name} table as ${article(plan.model).split(' ')[0].toLowerCase()} ${plan.model}. */`,
        `public static function ${names.read}(${names.source} $row${body.uow ? ', UnitOfWork $uow' : ''}): ${names.model}`,
        '{',
        ...body.lines.map((line) => `    ${line}`),
        ...result,
        '}',
      ])
    }
  }
  const blocks = [...methods, ...(['pair', 'part', 'rest'] as const).filter((name) => helpers.has(name)).map((name) => HELPERS[name])]
  const name = conversionsClass(info)
  return phpFile(pathOf(ns, name), ns, uses.write(), [
    `/** Conversions between the application models and the "${info.name}" table: what the service takes and returns. */`,
    `final class ${name}`,
    '{',
    ...blocks.flatMap((block, index) => [...(index > 0 ? [''] : []), ...block.map((line) => (line ? `    ${line}` : ''))]),
    '}',
  ])
}

const hasTodo = (items: { value: { kind: string } }[] | null) => (items ?? []).some((item) => item.value.kind === 'todo')

/**
 * The tests of the conversions: a row stored by the factories is read as the model, and a model that goes both ways
 * and leaves nothing to the user is written back, giving every value of the row (lookups and Mapper's lossless
 * transformations included).
 */
export function conversionTestFile(
  context: Context,
  plans: ConversionPlan[],
  schema: ModelSchema,
  canMake: (info: TableInfo) => boolean,
  databaseMembers: (uses: PhpUses) => Line[],
): GeneratedFile | null {
  const uses = new PhpUses('Tests').add('PHPUnit\\Framework\\TestCase')
  const memory = context.settings.memoryRepositories
  const tests: string[][] = []
  const readers = new Map<string, string[]>()
  for (const plan of plans) {
    const info = findInfo(context, plan.table)
    if (!info || !plan.read || hasTodo(plan.read) || !canMake(info) || !schema.models.some((item) => item.name === plan.model)) continue
    const names = conversionNames(context, plan)
    const dtos = usesDtos(context, info)
    const reads = plan.read.some((item) => ['lookup', 'children'].includes(item.value.kind))
    const writes = plan.write !== null && !hasTodo(plan.write)
    const writeUow = writes && plan.write!.some((item) => item.value.kind === 'lookup')
    const klass = conversionsClass(info)
    uses.add(className(conversionsNamespace(context, info), klass))
    const reader = `${lowerFirst(names.source)}Of`
    if (dtos && !readers.has(info.name)) {
      uses.add(className(namespaceOf(context, info, 'dtos'), names.source), className(namespaceOf(context, info, 'entity'), info.entity))
      readers.set(info.name, [
        '    /** The row as the service returns it. */',
        `    private static function ${reader}(${info.entity} $entity): ${names.source}`,
        '    {',
        `        return new ${names.source}(`,
        ...readColumns(info).map((column) => `            ${column.field}: ${access('$entity', column.prop)},`),
        '        );',
        '    }',
      ])
    }
    const body = [
      '$uow = $this->uow;',
      `$row = Factories::add${info.entity}($uow, 1);`,
      `$model = ${klass}::${names.read}(${dtos ? `self::${reader}($row)` : '$row'}${reads ? ', $uow' : ''});`,
      ...(writes
        ? [
            `$values = ${klass}::${names.write}($model${writeUow ? ', $uow' : ''});`,
            ...plan.write!.map((item) => {
              const column = columnOf(info, item.column)
              return `self::assertEquals(${access('$row', column.prop)}, ${dtos ? `$values->${column.field}` : access('$values', column.prop)});`
            }),
          ]
        : ['self::assertNotNull($model);']),
    ]
    tests.push([
      `    public function ${writes ? `testReads${plan.model}AndWritesItBack` : `testReads${plan.model}`}(): void`,
      '    {',
      ...body.map((line) => `        ${line}`),
      '    }',
    ])
  }
  if (tests.length === 0) return null
  let members: Line[]
  if (memory) {
    uses.add(rootClass(context, 'MemoryUnitOfWork'))
    members = [
      '    private MemoryUnitOfWork $uow;',
      '',
      '    protected function setUp(): void',
      '    {',
      '        $this->uow = new MemoryUnitOfWork();',
      '    }',
    ]
  } else members = databaseMembers(uses)
  return testFile('ConversionTest', uses, [
    '/** Tests of the conversions between the application models and the tables. */',
    'final class ConversionTest extends TestCase',
    '{',
    ...members,
    ...tests.flatMap((test) => ['', ...test]),
    ...[...readers.values()].flatMap((reader) => ['', ...reader]),
    '}',
  ])
}

/** The conversion classes of a project and the copy of the models they use. */
export function conversionFiles(context: Context, schema: ModelSchema, plans: ConversionPlan[]): GeneratedFile[] {
  const files: GeneratedFile[] = []
  for (const table of [...new Set(plans.map((plan) => plan.table))]) {
    const file = conversionFile(
      context,
      plans.filter((plan) => plan.table === table),
      schema,
    )
    if (file) files.push(file)
  }
  if (files.length === 0) return files
  return [...files, ...modelFiles(context, schema, plans)]
}
