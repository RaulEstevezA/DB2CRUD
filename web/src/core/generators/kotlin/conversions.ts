/**
 * The conversions between the application models and the tables (conversions/plan.ts), written in Kotlin: per
 * table, an object with one function that turns a model into what the service takes (its create DTO, or the entity)
 * and one that turns what it returns into the model. Values are converted between the model's Kotlin types and the
 * column's (numbers of another size, text, dates and times, nullable values, enums by a `when`), so the project
 * compiles; lookups go through the repositories of the unit of work; Mapper's transformations are plain expressions;
 * what the plan leaves to the user is a `// TODO:` with the reason, or Kotlin's `TODO()` where a value is needed.
 *
 * Models are built as the application has them: a constructor with named arguments, or `apply` on a class whose
 * properties are set one by one. They are copied into the project (`settings.modelsModule` as their package) or,
 * with `modelsSource: 'import'`, used from the user's package: the copy then goes to `application-models/`, a source
 * folder the build adds while it exists (delete it inside the application).
 */
import {
  type ConversionPlan,
  hasTodo,
  lossy,
  type ModelPath,
  type ReadValue,
  type Todo,
  withoutHidden,
  type WriteValue,
} from '../../conversions/plan.ts'
import type { GeneratedFile } from '../../export/files.ts'
import { fieldsOf } from '../../matching/names.ts'
import type { MapperTransform } from '../../interop/mapper/read.ts'
import type { EnumDef, FieldDef, ModelDef, ModelSchema, TypeRef } from '../../model/schema.ts'
import {
  columnOf,
  errorsPackage,
  findInfo,
  ktFile,
  packageOf,
  pathOf,
  qualified,
  query,
  queryName,
  stored,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import type { NestedClass } from './documents.ts'
import { createDto, readColumns, readDto } from './dtos.ts'
import { KtImports, ktString, memberName } from './kotlin.ts'
import { closeTest, openTest } from './tests.ts'

/** The folder of the copy of the models when they are imported from the user's package. */
export const MODELS_FOLDER = 'application-models'

const usesDtos = (context: Context, info: TableInfo) =>
  context.settings.services && context.settings.serviceTypes === 'dtos' && info.service !== null && info.role === 'entity'

/** The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them. */
export const servicePlans = (context: Context, plans: ConversionPlan[]) =>
  plans.map((plan) => {
    const info = findInfo(context, plan.table)
    return info && usesDtos(context, info) ? withoutHidden(plan, info.hidden) : plan
  })

/** The package of the conversions of a table, by architecture. */
export const conversionsPackage = (context: Context, info: TableInfo) =>
  context.settings.architecture === 'table' ? `${context.base}.${info.pkg}` : `${context.base}.conversions`

export const conversionsObject = (info: TableInfo) => `${info.entity}Conversions`

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/**
 * The names of a plan: its functions, the classes they take and return, and the name the model is used by (an
 * import alias, `ProductModel`, when it is named like the entity or a DTO of the same file).
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
  pkg: string
  imports?: KtImports
  /** The database keeps documents: moments have no offset, and lists are lists */
  documents?: boolean
}

const KNOWN: Record<string, string> = {
  BigDecimal: 'java.math.BigDecimal',
  BigInteger: 'java.math.BigInteger',
  LocalDate: 'java.time.LocalDate',
  LocalDateTime: 'java.time.LocalDateTime',
  LocalTime: 'java.time.LocalTime',
  OffsetDateTime: 'java.time.OffsetDateTime',
  OffsetTime: 'java.time.OffsetTime',
  Instant: 'java.time.Instant',
  ZonedDateTime: 'java.time.ZonedDateTime',
  Duration: 'java.time.Duration',
  UUID: 'java.util.UUID',
}

/** A model read from Kotlin keeps its names and types; the others get Kotlin's. */
const fromKotlin = (model: ModelDef) => model.fields.some((field) => field.originalType !== undefined)

const memberOf = (model: ModelDef | undefined, name: string) => (model && fromKotlin(model) ? name : memberName(name))

/** The Kotlin type of a model's TypeRef, for models not read from Kotlin. */
function typeRefKt(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return {
        string: 'String',
        integer: type.bits === 32 || type.bits === 16 || type.bits === 8 ? 'Int' : 'Long',
        float: type.bits === 32 ? 'Float' : 'Double',
        decimal: 'BigDecimal',
        boolean: 'Boolean',
        date: 'LocalDate',
        datetime: 'OffsetDateTime',
        time: 'LocalTime',
        duration: 'Duration',
        uuid: 'UUID',
        binary: 'ByteArray',
        any: 'Any',
      }[type.name]
    case 'array':
      return `List<${typeRefKt(type.items)}>`
    case 'map':
      return `Map<String, ${typeRefKt(type.value)}>`
    case 'model':
    case 'enum':
      return type.name
    case 'unknown':
      return 'Any'
  }
}

/** `java.time.LocalDate` → `LocalDate`, in every part of a type. */
const simple = (type: string) => type.replace(/\b(?:[a-z_][\w]*\.)+(?=[A-Z])/g, '')

/** The Kotlin type of a field, as the model has it (with `?` when it may be null). */
function fieldKt(model: ModelDef | undefined, field: FieldDef): string {
  if (model && fromKotlin(model) && field.originalType) return simple(field.originalType.trim())
  const type = typeRefKt(field.type)
  return field.nullable || field.optional ? `${type}?` : type
}

/** The constant of an enum value in Kotlin. */
const enumConstant = (item: EnumDef, value: EnumDef['values'][number]) =>
  item.values.every((other) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(other.name))
    ? value.name
    : memberName(value.name)
        .replace(/`/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toUpperCase()

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

function importsOfTypes(imports: KtImports, types: string[]) {
  for (const type of types) for (const word of type.match(/\b[A-Z]\w*/g) ?? []) if (KNOWN[word]) imports.add(KNOWN[word])
}

/** The value a property of a copied class starts with. */
function initial(models: Models, type: string): string | null {
  if (type.endsWith('?')) return 'null'
  const zero: Record<string, string> = {
    Int: '0',
    Long: '0L',
    Short: '0',
    Double: '0.0',
    Float: '0f',
    Boolean: 'false',
    String: '""',
    BigDecimal: 'BigDecimal.ZERO',
  }
  if (zero[type]) return zero[type]
  if (/^List</.test(type)) return 'emptyList()'
  if (/^Map</.test(type)) return 'emptyMap()'
  const item = models.schema.enums.find((candidate) => candidate.name === type)
  if (item) return `${type}.${enumConstant(item, item.values[0])}`
  return null
}

/** The class of a copied model, as the application has it. */
function modelClass(models: Models, model: ModelDef): string[] {
  const fields = model.fields.map((field) => ({ type: fieldKt(model, field), name: memberOf(model, field.name) }))
  const doc = `/** ${model.name}, as the application has it. */`
  if (model.construction !== 'properties')
    return [
      doc,
      `data class ${model.name}(`,
      ...fields.map((field) => `    val ${field.name}: ${field.type}${field.type.endsWith('?') ? ' = null' : ''},`),
      ')',
    ]
  return [
    doc,
    `class ${model.name} {`,
    ...fields.map((field) => {
      const value = initial(models, field.type)
      return value === null ? `    lateinit var ${field.name}: ${field.type}` : `    var ${field.name}: ${field.type} = ${value}`
    }),
    '}',
  ]
}

/** The copy of the application models the conversions use: a class or enum per file. */
export function modelFiles(context: Context, schema: ModelSchema, plans: ConversionPlan[]): GeneratedFile[] {
  const models: Models = { schema, pkg: context.settings.modelsModule }
  const pkg = models.pkg
  const folder = context.settings.modelsSource === 'copy' ? '' : `${MODELS_FOLDER}/`
  const { models: classes, enums } = closure(schema, [...new Set(plans.map((plan) => plan.model))])
  return [
    ...enums.map((item) =>
      ktFile(`${folder}${pathOf(pkg, item.name)}`, pkg, '', [
        `/** ${item.name}, as the application has it. */`,
        `enum class ${item.name} {`,
        ...item.values.map((value) => `    ${enumConstant(item, value)},`),
        '}',
      ]),
    ),
    ...classes.map((model) => {
      const imports = new KtImports(pkg)
      const types = model.fields.map((field) => fieldKt(model, field))
      importsOfTypes(imports, types)
      return ktFile(`${folder}${pathOf(pkg, model.name)}`, pkg, imports.write(), modelClass(models, model))
    }),
  ]
}

// Values

interface Typed {
  expression: string
  /** The type without `?` */
  type: string
  nullable: boolean
}

const typed = (expression: string, type: string, nullable = false): Typed => ({
  expression,
  type: type.replace(/\?$/, ''),
  nullable: nullable || type.endsWith('?'),
})

interface Body {
  lines: string[]
  imports: KtImports
  helpers: Set<'pair' | 'part' | 'rest'>
}

const NUMBERS = new Set(['Byte', 'Short', 'Int', 'Long', 'Float', 'Double', 'BigDecimal', 'BigInteger'])
const TEMPORAL = new Set(['LocalDate', 'LocalDateTime', 'LocalTime', 'OffsetDateTime', 'OffsetTime', 'Instant', 'ZonedDateTime'])

/** `x!!`, with parentheses when the expression ends a chain of safe calls. */
const sure = (expression: string) => (/\?\.|\?:| /.test(expression) ? `(${expression})!!` : `${expression}!!`)

const LIST = /^(?:List|MutableList|Set|MutableSet|Collection)<(.+)>$/

/** `.toSet()`, when a list must become another collection. */
const collect = (type: string) =>
  /^Set</.test(type) ? '.toSet()' : /^Mutable(List|Set)</.test(type) ? `.to${/^\w+/.exec(type)![0]}()` : ''

/** What a document database keeps in its own way; undefined for the rest. */
function coreDocument(models: Models, expression: string, from: string, to: string): string | null | undefined {
  if (from === 'LocalDate' && to === 'Instant') {
    models.imports?.add('java.time.ZoneOffset')
    return `${expression}.atStartOfDay(ZoneOffset.UTC).toInstant()`
  }
  if (from === 'Instant' && to === 'LocalDate') {
    models.imports?.add('java.time.ZoneOffset')
    return `${expression}.atOffset(ZoneOffset.UTC).toLocalDate()`
  }
  if (from === 'Any') return null
  const fromItem = LIST.exec(from)
  const toItem = LIST.exec(to)
  if (!fromItem || !toItem) return undefined
  const converted = convert(models, typed('item', fromItem[1]), toItem[1])
  if (converted === null) return null
  return converted === 'item'
    ? `${expression}${collect(to) || (from.startsWith('List<') || from.startsWith('Mutable') ? '' : '.toList()')}`
    : `${expression}.map { item -> ${converted} }${collect(to)}`
}

/** A value that is there, of one Kotlin type, as another; null when DB2CRUD does not convert them. */
function core(models: Models, expression: string, from: string, to: string): string | null {
  if (from === to || to === 'Any') return expression
  if (models.documents) {
    const converted = coreDocument(models, expression, from, to)
    if (converted !== undefined) return converted
  }
  const utc = () => {
    models.imports?.add('java.time.ZoneOffset')
    return 'ZoneOffset.UTC'
  }
  const fromEnum = models.schema.enums.find((item) => item.name === from)
  const toEnum = models.schema.enums.find((item) => item.name === to)
  for (const item of [fromEnum, toEnum]) if (item) models.imports?.add(`${models.pkg}.${item.name}`)
  if (fromEnum && to === 'String')
    return `when (${expression}) { ${fromEnum.values.map((item) => `${from}.${enumConstant(fromEnum, item)} -> ${ktString(enumText(item))}`).join('; ')} }`
  if (toEnum && from === 'String')
    return `when (${expression}) { ${toEnum.values.map((item) => `${ktString(enumText(item))} -> ${to}.${enumConstant(toEnum, item)}`).join('; ')}; else -> throw IllegalArgumentException("No ${to} for this value") }`
  if (NUMBERS.has(from) && NUMBERS.has(to)) {
    if (to === 'BigDecimal') return from === 'BigInteger' ? `${expression}.toBigDecimal()` : `${expression}.toBigDecimal()`
    if (to === 'BigInteger') return from === 'BigDecimal' ? `${expression}.toBigInteger()` : `${expression}.toLong().toBigInteger()`
    if (to === 'Short' || to === 'Byte') return `${expression}.toInt().to${to}()`
    return `${expression}.to${to}()`
  }
  if (to === 'String') return from === 'BigDecimal' ? `${expression}.toPlainString()` : `${expression}.toString()`
  if (from === 'String') {
    if (['Int', 'Long', 'Short', 'Byte', 'Float', 'Double', 'Boolean'].includes(to)) return `${expression}.to${to}()`
    if (to === 'BigDecimal' || to === 'BigInteger') return `${expression}.to${to}()`
    if (to === 'UUID') {
      models.imports?.add('java.util.UUID')
      return `UUID.fromString(${expression})`
    }
    if (TEMPORAL.has(to)) {
      models.imports?.add(KNOWN[to])
      return `${to}.parse(${expression})`
    }
    return null
  }
  const pairs: Record<string, () => string> = {
    'OffsetDateTime>LocalDateTime': () => `${expression}.toLocalDateTime()`,
    'OffsetDateTime>Instant': () => `${expression}.toInstant()`,
    'OffsetDateTime>LocalDate': () => `${expression}.toLocalDate()`,
    'LocalDateTime>OffsetDateTime': () => `${expression}.atOffset(${utc()})`,
    'LocalDateTime>Instant': () => `${expression}.toInstant(${utc()})`,
    'LocalDateTime>LocalDate': () => `${expression}.toLocalDate()`,
    'LocalDate>LocalDateTime': () => `${expression}.atStartOfDay()`,
    'LocalDate>OffsetDateTime': () => `${expression}.atStartOfDay().atOffset(${utc()})`,
    'Instant>OffsetDateTime': () => `${expression}.atOffset(${utc()})`,
    'Instant>LocalDateTime': () => `LocalDateTime.ofInstant(${expression}, ${utc()})`,
  }
  const pair = pairs[`${from}>${to}`]
  if (!pair) return null
  if (KNOWN[to]) models.imports?.add(KNOWN[to])
  return pair()
}

/**
 * A value as another Kotlin type (`?` when it may be null), or null when DB2CRUD does not convert them. A value that
 * may be null stays null when the target takes null, and is taken as there (`!!`) when it does not.
 */
function convert(models: Models, value: Typed, to: string): string | null {
  const target = to.replace(/\?$/, '')
  const nullableTarget = to.endsWith('?')
  const { expression } = value
  if (!value.nullable) return core(models, expression, value.type, target)
  // A list that is not there is an empty one
  if (models.documents && !nullableTarget && LIST.test(target)) return core(models, `${expression}.orEmpty()`, value.type, target)
  if (!nullableTarget) return core(models, sure(expression), value.type, target)
  const converted = core(models, 'it', value.type, target)
  if (converted === null) return null
  return converted === 'it' ? expression : `${expression}?.let { ${converted} }`
}

/** A Kotlin literal of a Mapper constant, with its type. */
function literal(value: string | number | boolean | null): Typed {
  if (value === null) return typed('null', 'Any', true)
  if (typeof value === 'string') return typed(ktString(value), 'String')
  if (typeof value === 'boolean') return typed(String(value), 'Boolean')
  return Number.isInteger(value) ? typed(`${value}L`, 'Long') : typed(String(value), 'Double')
}

const INVERSE = { '*': '/', '/': '*', '+': '-', '-': '+' } as const

/** The transformation that undoes an invertible one. */
function inverse(transform: MapperTransform): MapperTransform {
  if (transform.kind === 'arithmetic') return { ...transform, operator: INVERSE[transform.operator] }
  if (transform.kind === 'enum') return { kind: 'enum', pairs: transform.pairs.map((pair) => ({ from: pair.to, to: pair.from })) }
  return transform
}

/** A value as the text Mapper compares: enums by their stored text. */
const text = (models: Models, value: Typed) => convert(models, value, 'String') ?? `${value.expression}.toString()`

/** A Mapper transformation of typed values, as an expression of the type it gives; null when it cannot be written. */
function transformed(models: Models, transform: MapperTransform, values: Typed[], target: string, body: Body): Typed | null {
  const value = values[0]
  switch (transform.kind) {
    case 'direct':
      return value
    case 'concat':
      return typed(
        `listOf(${values.map((item) => text(models, item)).join(', ')}).joinToString(${ktString(transform.separator)})`,
        'String',
      )
    case 'split':
      if (transform.part === 'rest') {
        body.helpers.add('rest')
        return typed(`rest(${text(models, value)}, ${ktString(transform.separator)})`, 'String')
      }
      body.helpers.add('part')
      return typed(
        `part(${text(models, value)}, ${ktString(transform.separator)}, ${transform.part === 'last' ? -1 : transform.part})`,
        'String',
      )
    case 'constant':
      return literal(transform.value)
    case 'boolean':
      return typed(`${text(models, value)} in setOf(${transform.trueValues.map((item) => ktString(item)).join(', ')})`, 'Boolean')
    case 'enum': {
      body.helpers.add('pair')
      const pairs = transform.pairs.map((pair) => `${ktString(pair.from)} to ${ktString(pair.to)}`).join(', ')
      const fallback = transform.fallback !== undefined ? ktString(transform.fallback) : 'null'
      return typed(`pair(mapOf(${pairs}), ${text(models, value)}, ${fallback})`, 'String')
    }
    case 'epoch': {
      const milliseconds = transform.unit === 'milliseconds'
      const plain = target.replace(/\?$/, '')
      // From a date and time: a number; from a number: an instant
      if (NUMBERS.has(plain) || plain === 'String') {
        const moment = convert(models, value, 'Instant')
        if (moment === null) return null
        return typed(`${moment}.${milliseconds ? 'toEpochMilli()' : 'epochSecond'}`, 'Long')
      }
      const number = convert(models, value, 'Long')
      if (number === null) return null
      models.imports?.add('java.time.Instant')
      return typed(`Instant.${milliseconds ? 'ofEpochMilli' : 'ofEpochSecond'}(${number})`, 'Instant')
    }
    case 'arithmetic': {
      const number = convert(models, value, 'Double')
      if (number === null) return null
      return typed(`(${number} ${transform.operator} ${literal(transform.operand).expression.replace(/L$/, '.0')})`, 'Double')
    }
    default:
      return null
  }
}

/** A typed value as the type a column or field has: whole numbers rounded, then converted. */
function fit(models: Models, result: Typed, to: string): string | null {
  const whole = ['Byte', 'Short', 'Int', 'Long', 'BigInteger'].includes(to.replace(/\?$/, ''))
  if (whole && (result.type === 'Double' || result.type === 'Float'))
    return convert(models, { ...result, expression: `Math.round(${result.expression})`, type: 'Long' }, to)
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

/** One value of a call or of a block, with what is left to the user. */
interface Value {
  name: string
  expression: string | null
  todo?: string
}

/** The field of a model a path names, with how it is read, walking nested models. */
function walk(models: Models, model: ModelDef | undefined, path: ModelPath, root: string): Typed | null {
  let current = model
  let result: Typed | null = null
  let expression = root
  for (const part of path) {
    const field = current?.fields.find((item) => item.name === part)
    if (!current || !field) return null
    expression = `${expression}${result?.nullable ? '?' : ''}.${memberOf(current, field.name)}`
    result = typed(expression, fieldKt(current, field), result?.nullable ?? false)
    current =
      field.type.kind === 'model' ? models.schema.models.find((item) => item.name === (field.type as { name: string }).name) : undefined
  }
  return result
}

/** How a column is read: from a DTO as it is, from an entity as its nullable property. */
const columnTyped = (column: ColumnInfo, root: string, entity: boolean) =>
  typed(`${root}.${column.prop}`, column.kt, entity || column.column.nullable)

// Nested documents

interface Nested {
  context: Context
  models: Models
  info: TableInfo
  plan: ConversionPlan
  imports: KtImports
  /** The functions written so far */
  functions: string[][]
}

/** How a nested model is written: by an alias when the entity or a DTO of the file has its name. */
function nestedModel({ context, models, info, plan, imports }: Nested, name: string): string {
  const { target, source } = conversionNames(context, plan)
  const clash = [info.entity, target, source].includes(name)
  imports.add(`${qualified(models.pkg, name)}${clash ? ` as ${name}Model` : ''}`)
  return clash ? `${name}Model` : name
}

const modelNamed = ({ models }: Nested, name: string): ModelDef => {
  const model = models.schema.models.find((item) => item.name === name)!
  return { ...model, fields: fieldsOf(model, models.schema) }
}

const importEntity = ({ context, info, imports }: Nested) => imports.add(qualified(packageOf(context, info, 'entity'), info.entity))

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/`/g, '')

/** A nested document, or each of a list, converted by a function; `to` is the type it becomes. */
function callFor(name: string, many: boolean, value: Typed, to: string): string {
  const nullable = to.endsWith('?')
  const { expression } = value
  if (many) {
    const collected = collect(to)
    if (!value.nullable) return `${expression}.map { ${name}(it) }${collected}`
    if (!nullable) return `${expression}.orEmpty().map { ${name}(it) }${collected}`
    return `${expression}?.map { ${name}(it) }${collected && `?${collected}`}`
  }
  if (!value.nullable) return `${name}(${expression})`
  return nullable ? `${expression}?.let { ${name}(it) }` : `${name}(${sure(expression)})`
}

/** A class built with named arguments: the values left out take their default, null. */
const namedLines = (type: string, values: Value[]): string[] => [
  `    return ${type}(`,
  ...values.map((value) =>
    value.expression === null ? `        //${comment(value).slice(3)}` : `        ${value.name} = ${value.expression},${comment(value)}`,
  ),
  '    )',
]

/** What a property of a model could be hidden by */
const PARAMETERS = new Set(['row', 'uow', 'value'])

/** A model built as the application has it, from the values the plan gives. */
const modelLines = (type: string, model: ModelDef, values: Value[], given: Set<string>): string[] =>
  model.construction === 'properties'
    ? [
        // Built by its properties: the fields the plan does not give keep the model's defaults
        `    return ${type}().apply {`,
        ...values
          .filter((value) => given.has(value.name))
          .map((value) =>
            value.expression === null
              ? `        //${comment(value).slice(3)}`
              : `        ${PARAMETERS.has(value.name) ? 'this.' : ''}${value.name} = ${value.expression}${comment(value)}`,
          ),
        '    }',
      ]
    : [
        `    return ${type}(`,
        // Kotlin's TODO() stands for a value left to the user, and says why when it runs
        ...values.map((value) =>
          value.expression === null
            ? `        ${value.name} = TODO(${ktString(`${value.name}: ${value.todo}`)}),`
            : `        ${value.name} = ${value.expression},${comment(value)}`,
        ),
        '    )',
      ]

/** The value of a field no column gives. */
const leftOut = (name: string, type: string): Value =>
  type.endsWith('?') ? { name, expression: 'null' } : { name, expression: null, todo: 'no column gives it' }

/** Writes the function that gives a nested document from its model, and those inside it; gives its name. */
function writeDocument(nested: Nested, value: WriteValue & { kind: 'document' }, kept: NestedClass, path: string): string {
  const { models } = nested
  const name = `${lowerFirst(nested.plan.model)}${path}ToDocument`
  const model = modelNamed(nested, value.model)
  const values = value.values.flatMap((item): Value[] => {
    const field = kept.fields.find((candidate) => candidate.column.name === item.column)!
    if (item.value.kind === 'todo') return [{ name: field.prop, expression: null, todo: todoText(item.value) }]
    if (item.value.kind !== 'field' && item.value.kind !== 'document') return []
    const read = walk(models, model, item.value.path, 'value')!
    if (item.value.kind === 'document') {
      const inner = writeDocument(nested, item.value, field.nested!, path + upperFirst(field.prop))
      return [{ name: field.prop, expression: callFor(inner, item.value.many, read, `${field.kt}?`) }]
    }
    const converted = fit(models, read, `${field.kt}?`)
    if (converted !== null) return [{ name: field.prop, expression: converted }]
    return [{ name: field.prop, expression: null, todo: `${WHY.unsupported} (${read.type} to ${field.kt})` }]
  })
  importEntity(nested)
  nested.functions.push([
    `/** ${article(value.model)} as the documents of the ${nested.info.name} collection keep it. */`,
    ...(values.every((item) => item.expression === null) ? ['@Suppress("UNUSED_PARAMETER")'] : []),
    `private fun ${name}(value: ${nestedModel(nested, value.model)}): ${kept.path} {`,
    ...(value.unused.length > 0 ? [`    // Not stored: ${value.unused.join(', ')}`] : []),
    ...namedLines(kept.path, values),
    '}',
  ])
  return name
}

/** Writes the function that gives a model from its nested document, and those inside it; gives its name. */
function readDocument(nested: Nested, value: ReadValue & { kind: 'document' }, kept: NestedClass, path: string): string {
  const { models } = nested
  const name = `${lowerFirst(nested.plan.model)}${path}FromDocument`
  const model = modelNamed(nested, value.model)
  const given = new Set<string>()
  const values = model.fields.map((field): Value => {
    const item = value.values.find((candidate) => candidate.field === field.name)
    const prop = memberOf(model, field.name)
    const target = fieldKt(model, field)
    if (!item || (item.value.kind !== 'todo' && item.value.kind !== 'column' && item.value.kind !== 'document'))
      return leftOut(prop, target)
    given.add(prop)
    if (item.value.kind === 'todo') return { name: prop, expression: null, todo: todoText(item.value) }
    const column = item.value.column
    const from = kept.fields.find((candidate) => candidate.column.name === column)!
    const read = typed(`value.${from.prop}`, from.kt, true)
    if (item.value.kind === 'document') {
      const inner = readDocument(nested, item.value, from.nested!, path + upperFirst(from.prop))
      return { name: prop, expression: callFor(inner, item.value.many, read, target) }
    }
    const converted = fit(models, read, target)
    return converted === null
      ? { name: prop, expression: null, todo: `${WHY.unsupported} (${from.kt} to ${target})` }
      : { name: prop, expression: converted }
  })
  const type = nestedModel(nested, value.model)
  importEntity(nested)
  nested.functions.push([
    `/** A document of the ${nested.info.name} collection as ${article(value.model).split(' ')[0].toLowerCase()} ${value.model}. */`,
    `private fun ${name}(value: ${kept.path}): ${type} {`,
    ...modelLines(type, model, values, given),
    '}',
  ])
  return name
}

function writeExpression(
  context: Context,
  models: Models,
  column: ColumnInfo,
  value: Exclude<WriteValue, Todo>,
  model: ModelDef | undefined,
  body: Body,
  nested: Nested,
): { expression: string | null; todo?: string } {
  const unsupported = (detail: string) => ({ expression: null, todo: `${WHY.unsupported} (${detail})` })
  const source = (path: ModelPath) => walk(models, model, path, 'model')
  // DTOs and entities take every value as nullable
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(column.prop)
    const converted = fit(models, result, `${column.kt}?`)
    return converted === null ? unsupported(`${result.type} to ${column.kt}`) : { expression: converted }
  }
  switch (value.kind) {
    case 'document': {
      const given = source(value.path)
      const kept = nested.info.nested.get(column.column.name)
      if (!given || !kept) return unsupported(column.prop)
      return { expression: callFor(writeDocument(nested, value, kept, upperFirst(column.prop)), value.many, given, `${column.kt}?`) }
    }
    case 'field':
      return finish(source(value.path))
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && query(other, 'findByUnique', [value.by])
      const given = source(value.path)
      if (!other || !finder || !given) return { expression: null, todo: 'no repository query finds the row it names' }
      const by = columnOf(other, value.by)
      const argument = convert(models, given, by.kt)
      if (argument === null) return unsupported(`${given.type} to ${by.kt}`)
      const name = memberName(other.entity)
      body.imports.add(qualified(errorsPackage(context), 'NotFoundException'))
      body.lines.push(
        `val ${name} = uow.${other.attr}.${queryName(context, finder)}(${argument})`,
        `    ?: throw NotFoundException(${ktString(other.entity)}, ${given.expression}${given.nullable ? ' ?: ""' : ''})`,
      )
      return finish(columnTyped(columnOf(other, value.key), name, true))
    }
    case 'mapper': {
      const sources = value.sources.map(source)
      if (sources.some((item) => item === null)) return unsupported(column.prop)
      return finish(transformed(models, value.transform, sources as Typed[], column.kt, body))
    }
    case 'inverse': {
      const given = source(value.path)
      return finish(given && transformed(models, inverse(value.transform), [given], column.kt, body))
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
  nested: Nested,
): { expression: string | null; todo?: string } {
  const target = fieldKt(model, field)
  const own = (name: string) => columnTyped(columnOf(info, name), 'row', !dtos)
  const unsupported = (detail: string) => ({ expression: null, todo: `${WHY.unsupported} (${detail})` })
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(field.name)
    const converted = fit(models, result, target)
    return converted === null ? unsupported(`${result.type} to ${target}`) : { expression: converted }
  }
  switch (value.kind) {
    case 'document': {
      const kept = info.nested.get(value.column)
      if (!kept) return unsupported(field.name)
      const name = readDocument(nested, value, kept, upperFirst(columnOf(info, value.column).prop))
      return { expression: callFor(name, value.many, own(value.column), target) }
    }
    case 'column':
      return finish(own(value.column))
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && (query(other, 'getByKey') ?? query(other, 'findByUnique', [value.key]))
      if (!other || !finder) return { expression: null, todo: 'no repository query reads it' }
      const name = memberName(other.entity)
      const key = own(value.column)
      const nullable = columnOf(info, value.column).column.nullable
      const argument = key.nullable && !nullable ? sure(key.expression) : key.expression
      body.lines.push(
        nullable
          ? `val ${name} = ${key.expression}?.let { uow.${other.attr}.${queryName(context, finder)}(it) }`
          : `val ${name} = uow.${other.attr}.${queryName(context, finder)}(${argument})`,
      )
      return finish(typed(`${name}?.${columnOf(other, value.by).prop}`, columnOf(other, value.by).kt, true))
    }
    case 'children': {
      const other = findInfo(context, value.table)
      const lister = other && (query(other, 'listByParent', [value.by]) ?? query(other, 'findAllBy', [value.by]))
      if (!other || !lister) return { expression: null, todo: 'no repository query reads it' }
      const item = columnTyped(columnOf(other, value.value), 'it', true)
      const element = /^(?:List|Set|Collection)<(.+)>\??$/.exec(target)?.[1] ?? item.type
      const converted = convert(models, item, element)
      if (converted === null) return unsupported(`${item.type} to ${element}`)
      const key = own(value.key)
      const rows = `uow.${other.attr}.${queryName(context, lister)}(${key.nullable ? sure(key.expression) : key.expression})`
      return { expression: `${rows}.map { ${converted} }${target.startsWith('Set<') ? '.toSet()' : ''}` }
    }
    case 'mapper':
      return finish(transformed(models, value.transform, value.columns.map(own), target, body))
    case 'inverse':
      return finish(transformed(models, inverse(value.transform), [own(value.column)], target, body))
  }
}

const HELPERS = {
  pair: [
    '/** The value an enum pair gives, or the fallback; a value without a pair is an error. */',
    'private fun pair(pairs: Map<String, String>, value: String, fallback: String?): String =',
    '    pairs[value] ?: fallback ?: throw IllegalArgumentException("No pair for $value")',
  ],
  part: [
    '/** One part of a text split by a separator (the last one for -1), or an empty text. */',
    'private fun part(value: String, separator: String, index: Int): String {',
    '    val parts = value.split(separator)',
    '    return parts.getOrNull(if (index < 0) parts.size - 1 else index) ?: ""',
    '}',
  ],
  rest: [
    '/** What follows the first separator of a text, or an empty text. */',
    'private fun rest(value: String, separator: String): String =',
    '    if (separator in value) value.substringAfter(separator) else ""',
  ],
}

const comment = (value: Value) => (value.todo ? ` // TODO: ${value.name}: ${value.todo}` : '')

/** Whether a lookup or a list of the plan reads other rows, so the function takes the unit of work. */
const readsRows = (items: { value: { kind: string } }[] | null) =>
  (items ?? []).some((item) => ['lookup', 'children'].includes(item.value.kind))

/** The object of the conversions of one table: one function per direction its models go. */
export function conversionFile(context: Context, plans: ConversionPlan[], schema: ModelSchema): GeneratedFile | null {
  const info = findInfo(context, plans[0].table)
  if (!info) return null
  const pkg = conversionsPackage(context, info)
  const imports = new KtImports(pkg)
  const models: Models = { schema, pkg: context.settings.modelsModule, imports, documents: context.orm.documents }
  const helpers = new Set<'pair' | 'part' | 'rest'>()
  const functions: string[][] = []
  const dtos = usesDtos(context, info)
  for (const plan of plans) {
    const model = schema.models.find((item) => item.name === plan.model)
    const names = conversionNames(context, plan)
    const nested: Nested = { context, models, info, plan, imports, functions: [] }
    imports.add(`${qualified(models.pkg, plan.model)}${names.clash ? ` as ${names.model}` : ''}`)
    if (plan.write) {
      const body: Body = { lines: [], imports, helpers }
      const values: Value[] = []
      for (const item of plan.write) {
        const column = columnOf(info, item.column)
        if (item.value.kind === 'todo') values.push({ name: column.prop, expression: null, todo: todoText(item.value) })
        else values.push({ name: column.prop, ...writeExpression(context, models, column, item.value, model, body, nested) })
      }
      imports.add(qualified(packageOf(context, info, dtos ? 'dtos' : 'entity'), names.target))
      const uow = readsRows(plan.write)
      if (uow) imports.add(qualified(context.base, 'UnitOfWork'))
      functions.push([
        `/** ${article(plan.model)} as the ${info.name} table takes it. */`,
        `fun ${names.write}(model: ${names.model}${uow ? ', uow: UnitOfWork' : ''}): ${names.target} {`,
        ...body.lines.map((line) => `    ${line}`),
        ...namedLines(names.target, values),
        '}',
      ])
    }
    if (plan.read && model) {
      const body: Body = { lines: [], imports, helpers }
      const values: Value[] = []
      for (const field of model.fields) {
        const item = plan.read.find((candidate) => candidate.field === field.name)
        const name = memberOf(model, field.name)
        const type = fieldKt(model, field)
        if (!item) values.push(leftOut(name, type))
        else if (item.value.kind === 'todo') values.push({ name, expression: null, todo: todoText(item.value) })
        else values.push({ name, ...readExpression(context, models, info, dtos, model, field, item.value, body, nested) })
      }
      imports.add(qualified(packageOf(context, info, dtos ? 'dtos' : 'entity'), names.source))
      const uow = readsRows(plan.read)
      if (uow) imports.add(qualified(context.base, 'UnitOfWork'))
      const given = new Set(plan.read.map((item) => memberOf(model, item.field)))
      functions.push([
        `/** A row of the ${info.name} table as ${article(plan.model).split(' ')[0].toLowerCase()} ${plan.model}. */`,
        `fun ${names.read}(row: ${names.source}${uow ? ', uow: UnitOfWork' : ''}): ${names.model} {`,
        ...body.lines.map((line) => `    ${line}`),
        ...modelLines(names.model, model, values, given),
        '}',
      ])
    }
    functions.push(...nested.functions)
  }
  const blocks = [...functions, ...(['pair', 'part', 'rest'] as const).filter((name) => helpers.has(name)).map((name) => HELPERS[name])]
  const name = conversionsObject(info)
  return ktFile(pathOf(pkg, name), pkg, imports.write(), [
    `/** Conversions between the application models and the "${info.name}" table: what the service takes and returns. */`,
    `object ${name} {`,
    ...blocks.flatMap((block, index) => [...(index > 0 ? [''] : []), ...block.map((line) => (line ? `    ${line}` : ''))]),
    '}',
  ])
}

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
): GeneratedFile | null {
  const pkg = context.base
  const imports = new KtImports(pkg).add(
    'kotlin.test.BeforeTest',
    'kotlin.test.Test',
    'kotlin.test.assertEquals',
    'kotlin.test.assertNotNull',
  )
  const memory = context.settings.memoryRepositories
  if (!memory && context.orm.closeTest.length > 0) imports.add('kotlin.test.AfterTest')
  const tests: string[][] = []
  const readers = new Map<string, string[]>()
  for (const plan of plans) {
    const info = findInfo(context, plan.table)
    if (!info || !plan.read || hasTodo(plan.read) || !canMake(info)) continue
    const model = schema.models.find((item) => item.name === plan.model)
    if (!model) continue
    const names = conversionNames(context, plan)
    const dtos = usesDtos(context, info)
    const writes = plan.write !== null && !hasTodo(plan.write)
    const object = conversionsObject(info)
    imports.add(qualified(conversionsPackage(context, info), object))
    const reader = `${lowerFirst(names.source)}Of`
    if (dtos && !readers.has(info.name)) {
      imports.add(qualified(packageOf(context, info, 'dtos'), names.source), qualified(packageOf(context, info, 'entity'), info.entity))
      readers.set(info.name, [
        '    /** The row as the service returns it. */',
        `    private fun ${reader}(entity: ${info.entity}): ${names.source} =`,
        `        ${names.source}(`,
        ...readColumns(info).map((column) => `            ${column.prop} = ${stored(`entity.${column.prop}`, column)},`),
        '        )',
      ])
    }
    const body = [
      `val row = Factories.add${info.entity}(uow, 1)`,
      `val model = ${object}.${names.read}(${dtos ? `${reader}(row)` : 'row'}${readsRows(plan.read) ? ', uow' : ''})`,
      ...(writes
        ? [
            `val values = ${object}.${names.write}(model${readsRows(plan.write) ? ', uow' : ''})`,
            ...plan.write!.flatMap((item) => {
              const column = columnOf(info, item.column)
              // A value the model keeps with less detail is not written back as it was
              if (context.orm.documents && lossy(item.value, column.column.type, fieldsOf(model, schema), schema)) return []
              return [`assertEquals(row.${column.prop}, values.${column.prop})`]
            }),
          ]
        : ['assertNotNull(model)']),
    ]
    tests.push([
      '    @Test',
      `    fun ${writes ? `reads${plan.model}AndWritesItBack` : `reads${plan.model}`}() {`,
      ...body.map((line) => `        ${line}`),
      '    }',
    ])
  }
  if (tests.length === 0) return null
  return ktFile(pathOf(pkg, 'ConversionTest', true), pkg, imports.write(), [
    '/** Tests of the conversions between the application models and the tables. */',
    'class ConversionTest {',
    memory
      ? '    private lateinit var uow: MemoryUnitOfWork'
      : '    /** The repositories over the test database, opened empty for every test */',
    !memory && '    private lateinit var uow: SqlUnitOfWork',
    '',
    '    @BeforeTest',
    '    fun open() {',
    memory ? '        uow = MemoryUnitOfWork()' : '        uow = TestDatabase.open()',
    ...(memory ? [] : openTest(context)),
    '    }',
    ...(memory ? [] : closeTest(context)),
    ...tests.flatMap((test) => ['', ...test]),
    ...[...readers.values()].flatMap((reader) => ['', ...reader]),
    '}',
  ])
}

/** The conversion objects of a project and the copy of the models they use. */
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
