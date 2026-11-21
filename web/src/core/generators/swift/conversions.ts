/**
 * The conversions between the application models and the tables (conversions/plan.ts), written in Swift: per table,
 * an enum of static functions, one that turns a model into what the service takes (its create DTO, or the entity)
 * and one that turns what it returns into the model (`async throws` when it reads other rows). Values are converted
 * between the model's Swift types and the column's (numbers, decimals, text, dates, optionals, enums by a `switch`),
 * so the package builds without warnings; lookups go through the repositories of the unit of work; Mapper's
 * transformations are plain expressions; what the plan leaves to the user is a `// TODO:` with the reason, or a
 * `fatalError` with it where a value is needed.
 *
 * The models are in a target of their own, `ApplicationModels` (the last part of `settings.modelsModule`), so their
 * names never clash with the entities': copied into `Sources/ApplicationModels/`, or, with `modelsSource: 'import'`,
 * into `application-models/`, the target that stands for the user's module while the project runs on its own
 * (replace it with yours inside the application).
 */
import { withoutHidden, type ConversionPlan, type ModelPath, type ReadValue, type Todo, type WriteValue } from '../../conversions/plan.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { MapperTransform } from '../../interop/mapper/read.ts'
import type { EnumDef, FieldDef, ModelDef, ModelSchema, TypeRef } from '../../model/schema.ts'
import { columnOf, fileOf, findInfo, query, queryName, stored, swFile, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import { createDto, readColumns, readDto } from './dtos.ts'
import { imports, memberName, swString, typeName } from './swift.ts'

/** The folder of the copy of the models when they stand for the user's module. */
export const MODELS_FOLDER = 'application-models'

/** The module of the application models: `app.application_models` → `ApplicationModels`. */
export const modelsTarget = (context: Context) => typeName(context.settings.modelsModule.split('.').pop()!)

/** Where the target of the models is: in Sources/ when they are copied, in application-models/ when imported. */
export const modelsPath = (context: Context) =>
  context.settings.modelsSource === 'copy' ? `Sources/${modelsTarget(context)}` : MODELS_FOLDER

const usesDtos = (context: Context, info: TableInfo) =>
  context.settings.services && context.settings.serviceTypes === 'dtos' && info.service !== null && info.role === 'entity'

/** The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them. */
export const servicePlans = (context: Context, plans: ConversionPlan[]) =>
  plans.map((plan) => {
    const info = findInfo(context, plan.table)
    return info && usesDtos(context, info) ? withoutHidden(plan, info.hidden) : plan
  })

export const conversionsType = (info: TableInfo) => `${info.entity}Conversions`

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/**
 * The names of a plan: its functions, the types they take and return, and how the model is written (by its module
 * when it is named like the entity or a DTO).
 */
export function conversionNames(context: Context, plan: ConversionPlan) {
  const info = findInfo(context, plan.table)!
  const dtos = usesDtos(context, info)
  const target = dtos ? createDto(info) : info.entity
  const source = dtos ? readDto(info) : info.entity
  const clash = [info.entity, target, source].includes(plan.model)
  const named = clash ? `${plan.model}Model` : plan.model
  return {
    write: `${lowerFirst(named)}To${target}`,
    read: `${lowerFirst(source)}To${named}`,
    target,
    source,
    model: clash ? `${modelsTarget(context)}.${plan.model}` : plan.model,
  }
}

// Types of the models

interface Models {
  schema: ModelSchema
  target: string
}

/** A model read from Swift keeps its names and types; the others get Swift's. */
const fromSwift = (model: ModelDef) => model.fields.some((field) => field.originalType !== undefined)

const memberOf = (model: ModelDef | undefined, name: string) => (model && fromSwift(model) ? name : memberName(name))

/** The Swift type of a model's TypeRef, for models not read from Swift. */
function typeRefSw(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return {
        string: 'String',
        integer: 'Int',
        float: type.bits === 32 ? 'Float' : 'Double',
        decimal: 'Decimal',
        boolean: 'Bool',
        date: 'Date',
        datetime: 'Date',
        time: 'String',
        duration: 'Double',
        uuid: 'UUID',
        binary: 'Data',
        any: 'String',
      }[type.name]
    case 'array':
      return `[${typeRefSw(type.items)}]`
    case 'map':
      return `[String: ${typeRefSw(type.value)}]`
    case 'model':
    case 'enum':
      return type.name
    case 'unknown':
      return 'String'
  }
}

/** The Swift type of a field, as the model has it (`?` when it may be nil). */
function fieldSw(model: ModelDef | undefined, field: FieldDef): string {
  if (model && fromSwift(model) && field.originalType) return field.originalType.replace(/\s+/g, ' ').trim()
  const type = typeRefSw(field.type)
  return field.nullable || field.optional ? `${type}?` : type
}

/** The case of an enum value in Swift. */
const enumCase = (item: EnumDef, value: EnumDef['values'][number]) =>
  item.values.every((other) => /^[a-z][A-Za-z0-9]*$/.test(other.name)) ? value.name : memberName(value.name).replace(/`/g, '')

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

/** The copy of the application models the conversions use: public types, one per file, in their own target. */
export function modelFiles(context: Context, schema: ModelSchema, plans: ConversionPlan[]): GeneratedFile[] {
  const { models, enums } = closure(schema, [...new Set(plans.map((plan) => plan.model))])
  const folder = modelsPath(context)
  return [
    ...enums.map((item) =>
      swFile(`${folder}/${item.name}.swift`, '', [
        `/// ${item.name}, as the application has it.`,
        `public enum ${item.name}: String, Sendable, Equatable {`,
        ...item.values.map((value) => `    case ${enumCase(item, value)} = ${swString(enumText(value))}`),
        '}',
      ]),
    ),
    ...models.map((model) => {
      const fields = model.fields.map((field) => ({ name: memberOf(model, field.name), type: fieldSw(model, field) }))
      const params = fields.map((field) => `${field.name}: ${field.type}${field.type.endsWith('?') ? ' = nil' : ''}`).join(', ')
      return swFile(`${folder}/${model.name}.swift`, imports('Foundation'), [
        `/// ${model.name}, as the application has it.`,
        `public struct ${model.name}: Sendable, Equatable {`,
        ...fields.map((field) => `    public var ${field.name}: ${field.type}`),
        '',
        `    public init(${params}) {`,
        ...fields.map((field) => `        self.${field.name} = ${field.name}`),
        '    }',
        '}',
      ])
    }),
  ]
}

// Values

interface Typed {
  expression: string
  /** The type without `?` */
  type: string
  optional: boolean
}

const typed = (expression: string, type: string, optional = false): Typed => ({
  expression,
  type: type.replace(/\?$/, ''),
  optional: optional || type.endsWith('?'),
})

interface Body {
  lines: string[]
  helpers: Set<'pair' | 'part' | 'rest'>
}

const INTEGERS = new Set(['Int', 'Int8', 'Int16', 'Int32', 'Int64', 'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64'])
const FLOATS = new Set(['Double', 'Float'])

/** A value that is there, of one Swift type, as another; null when DB2CRUD does not convert them. */
function core(models: Models, expression: string, from: string, to: string): string | null {
  if (from === to) return expression
  const fromEnum = models.schema.enums.find((item) => item.name === from)
  const toEnum = models.schema.enums.find((item) => item.name === to)
  if (fromEnum && to === 'String')
    return `{ () -> String in switch ${expression} { ${fromEnum.values.map((item) => `case .${enumCase(fromEnum, item)}: return ${swString(enumText(item))}`).join('; ')} } }()`
  if (toEnum && from === 'String')
    return `{ () -> ${to} in switch ${expression} { ${toEnum.values.map((item) => `case ${swString(enumText(item))}: return .${enumCase(toEnum, item)}`).join('; ')}; default: fatalError("No ${to} for this value") } }()`
  const number = (type: string) => INTEGERS.has(type) || FLOATS.has(type)
  if (number(from) && number(to)) return `${to}(${expression})`
  if (number(from) && to === 'Decimal') return INTEGERS.has(from) ? `Decimal(${expression})` : `Decimal(Double(${expression}))`
  if (from === 'Decimal' && number(to)) return `${to}(NSDecimalNumber(decimal: ${expression}).doubleValue)`
  if (to === 'String') {
    if (from === 'Date') return `ISO8601DateFormatter().string(from: ${expression})`
    if (from === 'UUID') return `${expression}.uuidString`
    return `String(describing: ${expression})`
  }
  if (from === 'String') {
    if (number(to) || to === 'Bool') return `${to}(${expression})!`
    if (to === 'Decimal') return `Decimal(string: ${expression})!`
    if (to === 'UUID') return `UUID(uuidString: ${expression})!`
    if (to === 'Date') return `ISO8601DateFormatter().date(from: ${expression})!`
  }
  return null
}

/** Whether an expression takes a member without parentheses. */
const simple = (expression: string) => /^[\w.$]+$/.test(expression)

/**
 * A value as another Swift type (`?` when it may be nil), or null when DB2CRUD does not convert them. A nil value
 * stays nil when the target takes it, and is taken as there (`!`) when it does not.
 */
function convert(models: Models, value: Typed, to: string): string | null {
  const target = to.replace(/\?$/, '')
  const optionalTarget = to.endsWith('?')
  const { expression } = value
  if (!value.optional) return core(models, expression, value.type, target)
  if (!optionalTarget) return core(models, simple(expression) ? `${expression}!` : `(${expression})!`, value.type, target)
  const converted = core(models, '$0', value.type, target)
  if (converted === null) return null
  return converted === '$0' ? expression : `${simple(expression) ? expression : `(${expression})`}.map { ${converted} }`
}

/** A Swift literal of a Mapper constant, with its type. */
function literal(value: string | number | boolean | null): Typed {
  if (value === null) return typed('nil', 'String', true)
  if (typeof value === 'string') return typed(swString(value), 'String')
  if (typeof value === 'boolean') return typed(String(value), 'Bool')
  return Number.isInteger(value) ? typed(String(value), 'Int') : typed(String(value), 'Double')
}

const INVERSE = { '*': '/', '/': '*', '+': '-', '-': '+' } as const

/** The transformation that undoes an invertible one. */
function inverse(transform: MapperTransform): MapperTransform {
  if (transform.kind === 'arithmetic') return { ...transform, operator: INVERSE[transform.operator] }
  if (transform.kind === 'enum') return { kind: 'enum', pairs: transform.pairs.map((pair) => ({ from: pair.to, to: pair.from })) }
  return transform
}

/** A value as the text Mapper compares: enums by their stored text. */
const text = (models: Models, value: Typed) => convert(models, value, 'String') ?? `String(describing: ${value.expression})`

/** A Mapper transformation of typed values, as an expression of the type it gives; null when it cannot be written. */
function transformed(models: Models, transform: MapperTransform, values: Typed[], target: string, body: Body): Typed | null {
  const value = values[0]
  switch (transform.kind) {
    case 'direct':
      return value
    case 'concat':
      return typed(`[${values.map((item) => text(models, item)).join(', ')}].joined(separator: ${swString(transform.separator)})`, 'String')
    case 'split':
      if (transform.part === 'rest') {
        body.helpers.add('rest')
        return typed(`rest(${text(models, value)}, ${swString(transform.separator)})`, 'String')
      }
      body.helpers.add('part')
      return typed(
        `part(${text(models, value)}, ${swString(transform.separator)}, ${transform.part === 'last' ? -1 : transform.part})`,
        'String',
      )
    case 'constant':
      return literal(transform.value)
    case 'boolean':
      return typed(`[${transform.trueValues.map((item) => swString(item)).join(', ')}].contains(${text(models, value)})`, 'Bool')
    case 'enum': {
      body.helpers.add('pair')
      const pairs = transform.pairs.map((pair) => `${swString(pair.from)}: ${swString(pair.to)}`).join(', ')
      const fallback = transform.fallback !== undefined ? swString(transform.fallback) : 'nil'
      return typed(`pair([${pairs}], ${text(models, value)}, ${fallback})`, 'String')
    }
    case 'epoch': {
      const milliseconds = transform.unit === 'milliseconds'
      const plain = target.replace(/\?$/, '')
      // From a date and time: a number; from a number: a date and time
      if (INTEGERS.has(plain) || FLOATS.has(plain) || plain === 'String') {
        const moment = convert(models, value, 'Date')
        if (moment === null) return null
        return typed(`Int(${moment}.timeIntervalSince1970${milliseconds ? ' * 1000' : ''})`, 'Int')
      }
      const number = convert(models, value, 'Double')
      if (number === null) return null
      return typed(`Date(timeIntervalSince1970: ${number}${milliseconds ? ' / 1000' : ''})`, 'Date')
    }
    case 'arithmetic': {
      const number = convert(models, value, 'Double')
      if (number === null) return null
      const operand = literal(transform.operand).expression
      return typed(`(${number} ${transform.operator} ${Number.isInteger(transform.operand) ? `${operand}.0` : operand})`, 'Double')
    }
    default:
      return null
  }
}

/** A typed value as the type a column or field has: whole numbers rounded, then converted. */
function fit(models: Models, result: Typed, to: string): string | null {
  if (INTEGERS.has(to.replace(/\?$/, '')) && FLOATS.has(result.type))
    return convert(models, { ...result, expression: `${result.expression}.rounded()` }, to)
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

/** One argument of an initializer, with what is left to the user. */
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
    expression = `${expression}${result?.optional ? '?' : ''}.${memberOf(current, field.name)}`
    result = typed(expression, fieldSw(current, field), result?.optional ?? false)
    current =
      field.type.kind === 'model' ? models.schema.models.find((item) => item.name === (field.type as { name: string }).name) : undefined
  }
  return result
}

/** How a column is read: from a DTO as it is, from an entity as its optional. */
const columnTyped = (column: ColumnInfo, root: string, entity: boolean) =>
  typed(`${root}.${column.prop}`, column.sw, entity || column.column.nullable)

function writeExpression(
  context: Context,
  models: Models,
  column: ColumnInfo,
  value: Exclude<WriteValue, Todo>,
  model: ModelDef | undefined,
  body: Body,
): { expression: string | null; todo?: string } {
  const unsupported = (detail: string) => ({ expression: null, todo: `${WHY.unsupported} (${detail})` })
  const source = (path: ModelPath) => walk(models, model, path, 'model')
  // DTOs and entities take every value as an optional
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(column.key)
    const converted = fit(models, result, `${column.sw}?`)
    return converted === null ? unsupported(`${result.type} to ${column.sw}`) : { expression: converted }
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
      const argument = convert(models, given, by.sw)
      if (argument === null) return unsupported(`${given.type} to ${by.sw}`)
      const name = memberName(other.entity)
      body.lines.push(
        `guard let ${name} = try await uow.${other.attr}.${queryName(context, finder)}(${argument}) else {`,
        `    throw DomainError.notFound(entity: ${swString(other.entity)}, key: "\\(${given.expression})")`,
        '}',
      )
      return finish(columnTyped(columnOf(other, value.key), name, true))
    }
    case 'mapper': {
      const sources = value.sources.map(source)
      if (sources.some((item) => item === null)) return unsupported(column.key)
      return finish(transformed(models, value.transform, sources as Typed[], column.sw, body))
    }
    case 'inverse': {
      const given = source(value.path)
      return finish(given && transformed(models, inverse(value.transform), [given], column.sw, body))
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
  const target = fieldSw(model, field)
  const own = (name: string) => columnTyped(columnOf(info, name), 'row', !dtos)
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
      const name = memberName(other.entity)
      const key = own(value.column)
      const nullable = columnOf(info, value.column).column.nullable
      const call = `try await uow.${other.attr}.${queryName(context, finder)}`
      body.lines.push(
        ...(nullable
          ? [`var ${name}: ${other.entity}? = nil`, `if let key = ${key.expression} {`, `    ${name} = ${call}(key)`, '}']
          : [`let ${name} = ${call}(${convert(models, key, columnOf(info, value.column).sw)})`]),
      )
      const by = columnOf(other, value.by)
      return finish(typed(`${name}?.${by.prop}`, by.sw, true))
    }
    case 'children': {
      const other = findInfo(context, value.table)
      const lister = other && (query(other, 'listByParent', [value.by]) ?? query(other, 'findAllBy', [value.by]))
      if (!other || !lister) return { expression: null, todo: 'no repository query reads it' }
      const item = columnTyped(columnOf(other, value.value), '$0', true)
      const element = /^\[(.+)\]$/.exec(target)?.[1] ?? item.type
      const converted = convert(models, item, element)
      if (converted === null) return unsupported(`${item.type} to ${element}`)
      const key = convert(models, own(value.key), columnOf(info, value.key).sw)
      return { expression: `try await uow.${other.attr}.${queryName(context, lister)}(${key}).map { ${converted} }` }
    }
    case 'mapper':
      return finish(transformed(models, value.transform, value.columns.map(own), target, body))
    case 'inverse':
      return finish(transformed(models, inverse(value.transform), [own(value.column)], target, body))
  }
}

const HELPERS = {
  pair: [
    '/// The value an enum pair gives, or the fallback; a value without a pair is an error.',
    'private static func pair(_ pairs: [String: String], _ value: String, _ fallback: String?) -> String {',
    '    guard let found = pairs[value] ?? fallback else { fatalError("No pair for \\(value)") }',
    '    return found',
    '}',
  ],
  part: [
    '/// One part of a text split by a separator (the last one for -1), or an empty text.',
    'private static func part(_ value: String, _ separator: String, _ index: Int) -> String {',
    '    let parts = value.components(separatedBy: separator)',
    '    let at = index < 0 ? parts.count - 1 : index',
    '    return at < parts.count ? parts[at] : ""',
    '}',
  ],
  rest: [
    '/// What follows the first separator of a text, or an empty text.',
    'private static func rest(_ value: String, _ separator: String) -> String {',
    '    guard let range = value.range(of: separator) else { return "" }',
    '    return String(value[range.upperBound...])',
    '}',
  ],
}

const comment = (value: Value) => (value.todo ? ` // TODO: ${value.name}: ${value.todo}` : '')

/** Whether a lookup or a list of the plan reads other rows, so the function takes the unit of work. */
const readsRows = (items: { value: { kind: string } }[] | null) =>
  (items ?? []).some((item) => ['lookup', 'children'].includes(item.value.kind))

/** The arguments of an initializer, one per line, without a comma after the last; comments on lines of their own. */
function argumentLines(values: Value[], indent: string): string[] {
  const given = values.filter((value) => value.expression !== null)
  const result: string[] = []
  for (const value of values) {
    if (value.expression === null) {
      result.push(`${indent}//${comment(value).slice(3)}`)
      continue
    }
    const last = given[given.length - 1] === value
    result.push(`${indent}${value.name}: ${value.expression}${last ? '' : ','}${comment(value)}`)
  }
  return result
}

/** The file of the conversions of one table: one function per direction its models go. */
export function conversionFile(context: Context, plans: ConversionPlan[], schema: ModelSchema): GeneratedFile | null {
  const info = findInfo(context, plans[0].table)
  if (!info) return null
  const models: Models = { schema, target: modelsTarget(context) }
  const helpers = new Set<'pair' | 'part' | 'rest'>()
  const functions: string[][] = []
  const dtos = usesDtos(context, info)
  for (const plan of plans) {
    const model = schema.models.find((item) => item.name === plan.model)
    const names = conversionNames(context, plan)
    if (plan.write) {
      const body: Body = { lines: [], helpers }
      const values: Value[] = []
      for (const item of plan.write) {
        const column = columnOf(info, item.column)
        if (item.value.kind === 'todo') values.push({ name: column.prop, expression: null, todo: todoText(item.value) })
        else values.push({ name: column.prop, ...writeExpression(context, models, column, item.value, model, body) })
      }
      const uow = readsRows(plan.write)
      functions.push([
        `/// ${article(plan.model)} as the ${info.name} table takes it.`,
        uow
          ? `public static func ${names.write}(_ model: ${names.model}, uow: any UnitOfWork) async throws -> ${names.target} {`
          : `public static func ${names.write}(_ model: ${names.model}) -> ${names.target} {`,
        ...body.lines.map((line) => `    ${line}`),
        // The values left out take their default, nil
        `    return ${names.target}(`,
        ...argumentLines(values, '        '),
        '    )',
        '}',
      ])
    }
    if (plan.read && model) {
      const body: Body = { lines: [], helpers }
      const values: Value[] = []
      for (const field of model.fields) {
        const item = plan.read.find((candidate) => candidate.field === field.name)
        const name = memberOf(model, field.name)
        const type = fieldSw(model, field)
        let value: Value
        if (!item) value = type.endsWith('?') ? { name, expression: 'nil' } : { name, expression: null, todo: 'no column gives it' }
        else if (item.value.kind === 'todo') value = { name, expression: null, todo: todoText(item.value) }
        else value = { name, ...readExpression(context, models, info, dtos, model, field, item.value, body) }
        // A value left to the user stops the program with the reason, should it run
        if (value.expression === null)
          value = { name, expression: `{ () -> ${type} in fatalError(${swString(`${name}: ${value.todo}`)}) }()` }
        values.push(value)
      }
      const uow = readsRows(plan.read)
      functions.push([
        `/// A row of the ${info.name} table as ${article(plan.model).split(' ')[0].toLowerCase()} ${plan.model}.`,
        uow
          ? `public static func ${names.read}(_ row: ${names.source}, uow: any UnitOfWork) async throws -> ${names.model} {`
          : `public static func ${names.read}(_ row: ${names.source}) -> ${names.model} {`,
        ...body.lines.map((line) => `    ${line}`),
        `    return ${names.model}(`,
        ...argumentLines(values, '        '),
        '    )',
        '}',
      ])
    }
  }
  const blocks = [...functions, ...(['pair', 'part', 'rest'] as const).filter((name) => helpers.has(name)).map((name) => HELPERS[name])]
  const name = conversionsType(info)
  return swFile(fileOf(context, info, 'service', name), imports('Foundation', models.target), [
    `/// Conversions between the application models and the "${info.name}" table: what the service takes and returns.`,
    `public enum ${name} {`,
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
): GeneratedFile | null {
  const memory = context.settings.memoryRepositories
  const tests: string[][] = []
  const readers = new Map<string, string[]>()
  for (const plan of plans) {
    const info = findInfo(context, plan.table)
    if (!info || !plan.read || hasTodo(plan.read) || !canMake(info) || !schema.models.some((item) => item.name === plan.model)) continue
    const names = conversionNames(context, plan)
    const dtos = usesDtos(context, info)
    const writes = plan.write !== null && !hasTodo(plan.write)
    const type = conversionsType(info)
    const reader = `${lowerFirst(names.source)}Of`
    if (dtos && !readers.has(info.name))
      readers.set(info.name, [
        // By its module: Swift Testing has types of its own, such as Tag
        '/// The row as the service returns it.',
        `fileprivate func ${reader}(_ entity: ${context.module}.${info.entity}) -> ${context.module}.${names.source} {`,
        `    ${names.source}(${readColumns(info)
          .map((column) => `${column.prop}: ${stored(`entity.${column.prop}`, column)}`)
          .join(', ')})`,
        '}',
      ])
    const call = (async: boolean, method: string, argument: string) =>
      async ? `try await ${type}.${method}(${argument}, uow: uow)` : `${type}.${method}(${argument})`
    const body = [
      `let row = try await Factories.add${info.entity}(uow, 1)`,
      `let model = ${call(readsRows(plan.read), names.read, dtos ? `${reader}(row)` : 'row')}`,
      ...(writes
        ? [
            `let values = ${call(readsRows(plan.write), names.write, 'model')}`,
            ...plan.write!.map((item) => `#expect(values.${columnOf(info, item.column).prop} == row.${columnOf(info, item.column).prop})`),
          ]
        : ['_ = model']),
    ]
    tests.push([
      `@Test func ${writes ? `reads${plan.model}AndWritesItBack` : `reads${plan.model}`}() async throws {`,
      ...(memory
        ? ['    let uow = MemoryUnitOfWork()', ...body.map((line) => `    ${line}`)]
        : ['    try await TestDatabase.with { uow in', ...body.map((line) => `        ${line}`), '    }']),
      '}',
    ])
  }
  if (tests.length === 0) return null
  return swFile(
    `Tests/${context.module}Tests/ConversionTests.swift`,
    ['import Foundation', 'import Testing', `@testable import ${context.module}`].join('\n'),
    [
      'extension DataTests {',
      '    /// The conversions between the application models and the tables.',
      '    @Suite struct ConversionTests {',
      ...tests.flatMap((test) => ['', ...test.map((line) => `        ${line}`)]),
      '    }',
      '}',
      ...[...readers.values()].flatMap((reader) => ['', ...reader]),
    ],
  )
}

/** The conversion files of a project and the copy of the models they use. */
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
