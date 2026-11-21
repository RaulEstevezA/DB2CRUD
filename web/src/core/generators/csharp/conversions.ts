/**
 * The conversions between the application models and the tables (conversions/plan.ts), written in C#: per table, a
 * static class with one method that turns a model into what the service takes (its create DTO, or the entity) and
 * one that turns what it returns into the model (asynchronous when it reads other rows). Values are converted between
 * the model's C# types and the column's (numbers of another size, text, dates and times, nullable values, enums by a
 * switch), so the project builds; lookups go through the repositories of the unit of work; Mapper's transformations
 * are plain expressions; what the plan leaves to the user is a `// TODO:` with the reason.
 *
 * Models are built as the application has them: positional records with their constructor, classes with an object
 * initializer. They are copied into the project (`settings.modelsModule` as their namespace, in PascalCase) or, with
 * `modelsSource: 'import'`, used from the user's namespace: the copy then goes to `application-models/`, which the
 * project compiles only while the folder exists (delete it inside the application).
 */
import { withoutHidden, type ConversionPlan, type ModelPath, type ReadValue, type Todo, type WriteValue } from '../../conversions/plan.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { MapperTransform } from '../../interop/mapper/read.ts'
import type { EnumDef, FieldDef, ModelDef, ModelSchema, TypeRef } from '../../model/schema.ts'
import { lines, type Line } from '../types.ts'
import { csString, CsUsings, localName, pascalName } from './csharp.ts'
import {
  columnOf,
  errorsNamespace,
  findInfo,
  namespaceOf,
  pathOf,
  query,
  queryName,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createColumns, createDto, readColumns, readDto } from './dtos.ts'

/** The folder of the copy of the models when they are imported from the user's namespace. */
export const MODELS_FOLDER = 'application-models'

/** The namespace of the application models: `app.application_models` → `App.ApplicationModels`. */
export const modelsNamespace = (context: Context) => context.settings.modelsModule.split('.').map(pascalName).join('.')

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
  context.settings.architecture === 'table' ? `${context.base}.Tables.${info.folder}` : `${context.base}.Conversions`

export const conversionsClass = (info: TableInfo) => `${info.entity}Conversions`

/**
 * The names of a plan: its methods (without `Async`), the classes they take and return, and the name the model is
 * used by (an alias, `ProductModel`, when it is named like the entity or a DTO of the same file).
 */
export function conversionNames(context: Context, plan: ConversionPlan) {
  const info = findInfo(context, plan.table)!
  const dtos = usesDtos(context, info)
  const target = dtos ? createDto(info) : info.entity
  const source = dtos ? readDto(info) : info.entity
  const clash = [info.entity, target, source].includes(plan.model)
  const model = clash ? `${plan.model}Model` : plan.model
  return { write: `${model}To${target}`, read: `${source}To${model}`, target, source, model, clash }
}

// Types of the models

interface Models {
  schema: ModelSchema
  namespace: string
}

/** A model read from C# keeps its names; the others get C#'s PascalCase. */
const fromCsharp = (model: ModelDef) => model.fields.some((field) => field.originalType !== undefined)

const memberOf = (model: ModelDef | undefined, name: string) => (model && fromCsharp(model) ? name : pascalName(name))

/** The C# type of a model's TypeRef, for models not read from C#. */
function typeRefCs(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return {
        string: 'string',
        integer: type.bits === 32 || type.bits === 16 || type.bits === 8 ? 'int' : 'long',
        float: type.bits === 32 ? 'float' : 'double',
        decimal: 'decimal',
        boolean: 'bool',
        date: 'DateOnly',
        datetime: 'DateTimeOffset',
        time: 'TimeOnly',
        duration: 'TimeSpan',
        uuid: 'Guid',
        binary: 'byte[]',
        any: 'object',
      }[type.name]
    case 'array':
      return `List<${typeRefCs(type.items)}>`
    case 'map':
      return `Dictionary<string, ${typeRefCs(type.value)}>`
    case 'model':
    case 'enum':
      return type.name
    case 'unknown':
      return 'object'
  }
}

/** The C# type of a field, as the model has it (with `?` when it may be null). */
function fieldCs(model: ModelDef | undefined, field: FieldDef): string {
  if (model && fromCsharp(model) && field.originalType) return field.originalType.replace(/\s+/g, ' ').trim()
  const type = typeRefCs(field.type)
  return field.nullable || field.optional ? `${type}?` : type
}

/** The constant of an enum value in C#. */
function enumMember(item: EnumDef, value: EnumDef['values'][number]): string {
  return typeof value.value === 'number' || item.values.every((other) => /^[A-Z][A-Za-z0-9]*$/.test(other.name))
    ? value.name
    : pascalName(value.name)
}

/** The text an enum value is stored as: its string value, or its name (C#'s numbered members). */
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

const VALUE_TYPES = new Set([
  'bool',
  'byte',
  'sbyte',
  'short',
  'ushort',
  'int',
  'uint',
  'long',
  'ulong',
  'float',
  'double',
  'decimal',
  'char',
  'DateTime',
  'DateTimeOffset',
  'DateOnly',
  'TimeOnly',
  'TimeSpan',
  'Guid',
])

/** The class or record of a copied model, as the application has it. */
function modelType(models: Models, model: ModelDef): string[] {
  const fields = model.fields.map((field) => ({ type: fieldCs(model, field), name: memberOf(model, field.name) }))
  const doc = `/// <summary>${model.name}, as the application has it.</summary>`
  const parent = model.extends?.length ? ` : ${model.extends[0]}` : ''
  if (model.construction === 'positional')
    return [
      doc,
      `public record ${model.name}(`,
      ...fields.map((field, index) => `    ${field.type} ${field.name}${index < fields.length - 1 ? ',' : ''}`),
      `)${parent};`,
    ]
  const enums = new Set(models.schema.enums.map((item) => item.name))
  return [
    doc,
    `public class ${model.name}${parent}`,
    '{',
    ...fields.map((field) => {
      const reference = !field.type.endsWith('?') && !VALUE_TYPES.has(field.type) && !enums.has(field.type)
      return `    public ${field.type} ${field.name} { get; set; }${reference ? ' = null!;' : ''}`
    }),
    '}',
  ]
}

/** The copy of the application models the conversions use: a type per file. */
export function modelFiles(context: Context, schema: ModelSchema, plans: ConversionPlan[]): GeneratedFile[] {
  const models: Models = { schema, namespace: modelsNamespace(context) }
  const ns = models.namespace
  const { models: classes, enums } = closure(schema, [...new Set(plans.map((plan) => plan.model))])
  const unit = (name: string, body: string[]): GeneratedFile => ({
    path: context.settings.modelsSource === 'copy' ? pathOf(ns, name) : `${MODELS_FOLDER}/${name}.cs`,
    content: lines(`namespace ${ns};`, '', ...body, ''),
  })
  return [
    ...enums.map((item) =>
      unit(item.name, [
        `/// <summary>${item.name}, as the application has it.</summary>`,
        `public enum ${item.name}`,
        '{',
        ...item.values.map((value) => `    ${enumMember(item, value)},`),
        '}',
      ]),
    ),
    ...classes.map((model) => unit(model.name, modelType(models, model))),
  ]
}

// Values

interface Typed {
  expression: string
  /** The type without `?` */
  type: string
  nullable: boolean
  /** Never null: a transformation's result */
  present?: boolean
}

const typed = (expression: string, type: string, nullable = false, present = false): Typed => ({
  expression,
  type: type.replace(/\?$/, ''),
  nullable: nullable || type.endsWith('?'),
  present,
})

interface Body {
  lines: string[]
  uow: boolean
  usings: CsUsings
  helpers: Set<'pair' | 'part' | 'rest'>
}

const NUMBERS = new Set(['byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'decimal'])
const PARSED = new Set([...NUMBERS, 'DateTime', 'DateTimeOffset', 'DateOnly', 'TimeOnly', 'TimeSpan'])

/** A value that is there, of one C# type, as another; null when DB2CRUD does not convert them. */
function core(models: Models, expression: string, from: string, to: string, body: Body): string | null {
  if (from === to || to === 'object') return expression
  const invariant = () => {
    body.usings.add('System.Globalization')
    return 'CultureInfo.InvariantCulture'
  }
  const fromEnum = models.schema.enums.find((item) => item.name === from)
  const toEnum = models.schema.enums.find((item) => item.name === to)
  if (fromEnum && to === 'string')
    return `${expression} switch { ${fromEnum.values.map((item) => `${from}.${enumMember(fromEnum, item)} => ${csString(enumText(item))}, `).join('')}_ => throw new ArgumentOutOfRangeException(nameof(${from})) }`
  if (toEnum && from === 'string')
    return `${expression} switch { ${toEnum.values.map((item) => `${csString(enumText(item))} => ${to}.${enumMember(toEnum, item)}, `).join('')}_ => throw new ArgumentException("No ${to} for this value") }`
  if (NUMBERS.has(from) && NUMBERS.has(to)) return `(${to})${expression}`
  if (to === 'string') {
    if (from === 'bool') return `(${expression} ? "true" : "false")`
    if (NUMBERS.has(from)) return `${expression}.ToString(${invariant()})`
    if (['DateTime', 'DateTimeOffset', 'DateOnly', 'TimeOnly'].includes(from)) return `${expression}.ToString("O", ${invariant()})`
    return `${expression}.ToString()`
  }
  if (from === 'string') {
    if (PARSED.has(to)) return `${to}.Parse(${expression}, ${invariant()})`
    if (to === 'bool' || to === 'Guid') return `${to}.Parse(${expression})`
    return null
  }
  const pairs: Record<string, string> = {
    'DateTimeOffset>DateTime': `${expression}.UtcDateTime`,
    'DateTime>DateTimeOffset': `new DateTimeOffset(DateTime.SpecifyKind(${expression}, DateTimeKind.Utc))`,
    'DateTime>DateOnly': `DateOnly.FromDateTime(${expression})`,
    'DateTimeOffset>DateOnly': `DateOnly.FromDateTime(${expression}.UtcDateTime)`,
    'DateOnly>DateTime': `${expression}.ToDateTime(TimeOnly.MinValue)`,
    'DateOnly>DateTimeOffset': `new DateTimeOffset(${expression}.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero)`,
    'TimeOnly>TimeSpan': `${expression}.ToTimeSpan()`,
    'TimeSpan>TimeOnly': `TimeOnly.FromTimeSpan(${expression})`,
  }
  return pairs[`${from}>${to}`] ?? null
}

/** Whether a value of this type is a value type (a struct or an enum of the models). */
const isValueType = (models: Models, type: string) => VALUE_TYPES.has(type) || models.schema.enums.some((item) => item.name === type)

/**
 * A value as another C# type (`?` when it may be null), or null when DB2CRUD does not convert them. A value that may
 * be null stays null when the target takes null.
 */
function convert(models: Models, value: Typed, to: string, body: Body): string | null {
  const target = to.replace(/\?$/, '')
  const nullableTarget = to.endsWith('?')
  const { expression } = value
  if (!value.nullable || value.present) return core(models, expression, value.type, target, body)
  if (value.type === target) {
    if (nullableTarget) return expression
    return isValueType(models, target) ? `(${expression} ?? default)` : `${expression}!`
  }
  const inner = isValueType(models, value.type) ? `${expression}.Value` : expression
  const converted = core(models, inner, value.type, target, body)
  if (converted === null) return null
  return nullableTarget ? `${expression} is null ? null : (${target}?)(${converted})` : converted
}

/** A C# literal of a Mapper constant, with its type. */
function literal(value: string | number | boolean | null): Typed {
  if (value === null) return typed('null', 'object', true)
  if (typeof value === 'string') return typed(csString(value), 'string', false, true)
  if (typeof value === 'boolean') return typed(String(value), 'bool', false, true)
  return Number.isInteger(value) ? typed(`${value}L`, 'long', false, true) : typed(String(value), 'double', false, true)
}

const INVERSE = { '*': '/', '/': '*', '+': '-', '-': '+' } as const

/** The transformation that undoes an invertible one. */
function inverse(transform: MapperTransform): MapperTransform {
  if (transform.kind === 'arithmetic') return { ...transform, operator: INVERSE[transform.operator] }
  if (transform.kind === 'enum') return { kind: 'enum', pairs: transform.pairs.map((pair) => ({ from: pair.to, to: pair.from })) }
  return transform
}

/** A value as the text Mapper compares: enums by their stored text. */
function text(models: Models, value: Typed, body: Body): string {
  if (models.schema.enums.some((item) => item.name === value.type)) return convert(models, value, 'string?', body) ?? value.expression
  return value.expression
}

/** A Mapper transformation of typed values, as an expression of the type it gives; null when it cannot be written. */
function transformed(models: Models, transform: MapperTransform, values: Typed[], target: string, body: Body): Typed | null {
  const value = values[0]
  // A value a transformation uses is taken as there: a nullable struct by its Value
  const present = (item: Typed): Typed => ({
    ...item,
    expression: item.nullable && !item.present && isValueType(models, item.type) ? `${item.expression}!.Value` : item.expression,
    present: true,
  })
  switch (transform.kind) {
    case 'direct':
      return value
    case 'concat':
      return typed(
        `string.Join(${csString(transform.separator)}, ${values.map((item) => text(models, item, body)).join(', ')})`,
        'string',
        false,
        true,
      )
    case 'split':
      if (transform.part === 'rest') {
        body.helpers.add('rest')
        return typed(`Rest(${text(models, value, body)}, ${csString(transform.separator)})`, 'string', false, true)
      }
      body.helpers.add('part')
      return typed(
        `Part(${text(models, value, body)}, ${csString(transform.separator)}, ${transform.part === 'last' ? -1 : transform.part})`,
        'string',
        false,
        true,
      )
    case 'constant':
      return literal(transform.value)
    case 'boolean':
      body.helpers.add('pair')
      return typed(
        `new[] { ${transform.trueValues.map((item) => csString(item)).join(', ')} }.Contains(Text(${text(models, value, body)}))`,
        'bool',
        false,
        true,
      )
    case 'enum': {
      body.helpers.add('pair')
      const pairs = transform.pairs.map((pair) => `[${csString(pair.from)}] = ${csString(pair.to)}`).join(', ')
      const fallback = transform.fallback !== undefined ? csString(transform.fallback) : 'null'
      return typed(`Pair(new Dictionary<string, string> { ${pairs} }, ${text(models, value, body)}, ${fallback})`, 'string', false, true)
    }
    case 'epoch': {
      const milliseconds = transform.unit === 'milliseconds'
      // From a date and time: a number; from a number: a date and time
      if (NUMBERS.has(target.replace(/\?$/, '')) || target.replace(/\?$/, '') === 'string') {
        const moment = convert(models, present(value), 'DateTimeOffset', body)
        if (moment === null) return null
        return typed(`(${moment}).${milliseconds ? 'ToUnixTimeMilliseconds()' : 'ToUnixTimeSeconds()'}`, 'long', false, true)
      }
      const number = convert(models, present(value), 'long', body)
      if (number === null) return null
      return typed(
        `DateTimeOffset.${milliseconds ? 'FromUnixTimeMilliseconds' : 'FromUnixTimeSeconds'}(${number})`,
        'DateTimeOffset',
        false,
        true,
      )
    }
    case 'arithmetic': {
      const number = convert(models, present(value), 'double', body)
      if (number === null) return null
      return typed(`(${number} ${transform.operator} ${literal(transform.operand).expression.replace(/L$/, '')})`, 'double', false, true)
    }
    default:
      return null
  }
}

/** A typed value as the type a column or field has: whole numbers rounded, then converted. */
function fit(models: Models, result: Typed, to: string, body: Body): string | null {
  const whole = ['byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong'].includes(to.replace(/\?$/, ''))
  const rounded =
    whole && (result.type === 'double' || result.type === 'float') ? { ...result, expression: `Math.Round(${result.expression})` } : result
  return convert(models, rounded, to, body)
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

/** One value of a call or an initializer, with the comment that explains it. */
interface Value {
  name: string
  expression: string
  todo?: string
}

const comment = (value: Value) => (value.todo ? ` // TODO: ${value.name}: ${value.todo}` : '')

/** The arguments of a constructor, one per line. */
const argumentLines = (values: Value[], indent: string) =>
  values.map((value, index) => `${indent}${value.expression}${index < values.length - 1 ? ',' : ''}${comment(value)}`)

/** The members of an object initializer, one per line. */
const initializerLines = (values: Value[], indent: string) =>
  values.map((value) => `${indent}${value.name} = ${value.expression},${comment(value)}`)

/** The field of a model a path names, with how it is read, walking nested models. */
function walk(models: Models, model: ModelDef | undefined, path: ModelPath, root: string): Typed | null {
  let current = model
  let expression = root
  let result: Typed | null = null
  for (const part of path) {
    const field = current?.fields.find((item) => item.name === part)
    if (!current || !field) return null
    expression = `${expression}${result?.nullable ? '?' : ''}.${memberOf(current, field.name)}`
    result = typed(expression, fieldCs(current, field), result?.nullable ?? false)
    current =
      field.type.kind === 'model' ? models.schema.models.find((item) => item.name === (field.type as { name: string }).name) : undefined
  }
  return result
}

const columnTyped = (column: ColumnInfo, root: string) => typed(`${root}.${column.prop}`, column.propType)

function writeExpression(
  context: Context,
  models: Models,
  column: ColumnInfo,
  value: Exclude<WriteValue, Todo>,
  model: ModelDef | undefined,
  body: Body,
): { expression: string; todo?: string } {
  const unsupported = (detail: string) => ({ expression: 'default!', todo: `${WHY.unsupported} (${detail})` })
  const source = (path: ModelPath) => walk(models, model, path, 'model')
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(column.prop)
    const converted = fit(models, result, column.propType, body)
    return converted === null ? unsupported(`${result.type} to ${column.cs}`) : { expression: converted }
  }
  switch (value.kind) {
    case 'field':
      return finish(source(value.path))
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && query(other, 'findByUnique', [value.by])
      const given = source(value.path)
      if (!other || !finder || !given) return { expression: 'default!', todo: 'no repository query finds the row it names' }
      const by = columnOf(other, value.by)
      const argument = convert(models, given, by.cs, body)
      if (argument === null) return unsupported(`${given.type} to ${by.cs}`)
      const name = localName(other.entity)
      body.uow = true
      body.usings.add(errorsNamespace(context))
      body.lines.push(
        `var ${name} = await uow.${other.attr}.${queryName(context, finder)}(${argument})`,
        `    ?? throw new NotFoundException(${csString(other.entity)}, ${given.expression}${given.nullable ? ' ?? ""' : ''});`,
      )
      return finish(columnTyped(columnOf(other, value.key), name))
    }
    case 'mapper': {
      const sources = value.sources.map(source)
      if (sources.some((item) => item === null)) return unsupported(column.prop)
      return finish(transformed(models, value.transform, sources as Typed[], column.propType, body))
    }
    case 'inverse': {
      const given = source(value.path)
      return finish(given && transformed(models, inverse(value.transform), [given], column.propType, body))
    }
  }
}

function readExpression(
  context: Context,
  models: Models,
  info: TableInfo,
  model: ModelDef,
  field: FieldDef,
  value: Exclude<ReadValue, Todo>,
  body: Body,
): { expression: string; todo?: string } {
  const target = fieldCs(model, field)
  const unsupported = (detail: string) => ({ expression: 'default!', todo: `${WHY.unsupported} (${detail})` })
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(field.name)
    const converted = fit(models, result, target, body)
    return converted === null ? unsupported(`${result.type} to ${target}`) : { expression: converted }
  }
  switch (value.kind) {
    case 'column':
      return finish(columnTyped(columnOf(info, value.column), 'row'))
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && (query(other, 'getByKey') ?? query(other, 'findByUnique', [value.key]))
      if (!other || !finder) return { expression: 'default!', todo: 'no repository query reads it' }
      const name = localName(other.entity)
      const own = columnOf(info, value.column)
      body.uow = true
      const argument = own.optional ? `row.${own.prop}${own.valueType ? '.Value' : ''}` : `row.${own.prop}`
      const found = `await uow.${other.attr}.${queryName(context, finder)}(${argument})`
      body.lines.push(own.optional ? `var ${name} = row.${own.prop} is null ? null : ${found};` : `var ${name} = ${found};`)
      const by = columnOf(other, value.by)
      return finish(typed(`${name}${own.optional ? '?' : '!'}.${by.prop}`, by.propType, own.optional))
    }
    case 'children': {
      const other = findInfo(context, value.table)
      const lister = other && (query(other, 'listByParent', [value.by]) ?? query(other, 'findAllBy', [value.by]))
      if (!other || !lister) return { expression: 'default!', todo: 'no repository query reads it' }
      body.uow = true
      const item = columnTyped(columnOf(other, value.value), 'item')
      const list = /^(?:List|IList|IEnumerable|ICollection|IReadOnlyList)<(.+)>\??$/.exec(target)
      const array = /^(.+)\[\]\??$/.exec(target)
      const element = list?.[1] ?? array?.[1] ?? item.type
      const converted = convert(models, item, element, body)
      if (converted === null) return unsupported(`${item.type} to ${element}`)
      const key = columnOf(info, value.key)
      const rows = `(await uow.${other.attr}.${queryName(context, lister)}(row.${key.prop}${key.optional && key.valueType ? '!.Value' : ''}))`
      return { expression: `${rows}.Select(item => ${converted}).${array ? 'ToArray' : 'ToList'}()` }
    }
    case 'mapper':
      return finish(
        transformed(
          models,
          value.transform,
          value.columns.map((name) => columnTyped(columnOf(info, name), 'row')),
          target,
          body,
        ),
      )
    case 'inverse':
      return finish(transformed(models, inverse(value.transform), [columnTyped(columnOf(info, value.column), 'row')], target, body))
  }
}

const HELPERS = {
  pair: [
    '/// <summary>A value as the text Mapper compares.</summary>',
    'private static string Text(object? value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";',
    '',
    '/// <summary>The value an enum pair gives, or the fallback; a value without a pair is an error.</summary>',
    'private static string Pair(Dictionary<string, string> pairs, object? value, string? fallback) =>',
    '    pairs.TryGetValue(Text(value), out var found) ? found : fallback ?? throw new ArgumentException($"No pair for {value}");',
  ],
  part: [
    '/// <summary>One part of a text split by a separator (the last one for -1), or an empty text.</summary>',
    'private static string Part(object? value, string separator, int index)',
    '{',
    '    var parts = (Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Split(separator);',
    '    var at = index < 0 ? parts.Length - 1 : index;',
    '    return at < parts.Length ? parts[at] : "";',
    '}',
  ],
  rest: [
    '/// <summary>What follows the first separator of a text, or an empty text.</summary>',
    'private static string Rest(object? value, string separator)',
    '{',
    '    var text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";',
    '    var at = text.IndexOf(separator, StringComparison.Ordinal);',
    '    return at < 0 ? "" : text[(at + separator.Length)..];',
    '}',
  ],
}

/** The class of the conversions of one table: one method per direction its models go. */
export function conversionFile(context: Context, plans: ConversionPlan[], schema: ModelSchema): GeneratedFile | null {
  const info = findInfo(context, plans[0].table)
  if (!info) return null
  const models: Models = { schema, namespace: modelsNamespace(context) }
  const ns = conversionsNamespace(context, info)
  const usings = new CsUsings(ns)
  const aliases = new Set<string>()
  const helpers = new Set<'pair' | 'part' | 'rest'>()
  const methods: string[][] = []
  const dtos = usesDtos(context, info)
  const record = context.settings.dtoKind !== 'class'
  for (const plan of plans) {
    const model = schema.models.find((item) => item.name === plan.model)
    const names = conversionNames(context, plan)
    if (names.clash) aliases.add(`using ${names.model} = ${models.namespace}.${plan.model};`)
    else usings.add(models.namespace)
    usings.add(namespaceOf(context, info, dtos ? 'dtos' : 'entity'))
    const signature = (uow: boolean, result: string, name: string, param: string) =>
      uow
        ? `    public static async Task<${result}> ${name}Async(${param}, IUnitOfWork uow)`
        : `    public static ${result} ${name}(${param})`
    if (plan.write) {
      const body: Body = { lines: [], uow: false, usings, helpers }
      const values: Value[] = []
      for (const item of plan.write) {
        const column = columnOf(info, item.column)
        if (item.value.kind === 'todo') values.push({ name: column.prop, expression: 'default!', todo: todoText(item.value) })
        else values.push({ name: column.prop, ...writeExpression(context, models, column, item.value, model, body) })
      }
      let result: string[]
      if (dtos && record) {
        // Every value of the create DTO, in its order; those the model does not give are null
        const all = createColumns(info).map(
          (column) => values.find((value) => value.name === column.prop) ?? { name: column.prop, expression: 'null' },
        )
        result = [`        return new ${names.target}(`, ...argumentLines(all, '            '), '        );']
      } else result = [`        return new ${names.target}`, '        {', ...initializerLines(values, '            '), '        };']
      if (body.uow) usings.add(context.base)
      methods.push([
        `    /// <summary>${article(plan.model)} as the ${info.name} table takes it.</summary>`,
        signature(body.uow, names.target, names.write, `${names.model} model`),
        '    {',
        ...body.lines.map((line) => `        ${line}`),
        ...result,
        '    }',
      ])
    }
    if (plan.read && model) {
      const body: Body = { lines: [], uow: false, usings, helpers }
      const values: Value[] = []
      for (const field of model.fields) {
        const item = plan.read.find((candidate) => candidate.field === field.name)
        const name = memberOf(model, field.name)
        if (!item) values.push({ name, expression: 'default!' })
        else if (item.value.kind === 'todo') values.push({ name, expression: 'default!', todo: todoText(item.value) })
        else values.push({ name, ...readExpression(context, models, info, model, field, item.value, body) })
      }
      const given = new Set(plan.read.map((item) => memberOf(model, item.field)))
      if (body.uow) usings.add(context.base)
      const result =
        model.construction === 'positional'
          ? [`        return new ${names.model}(`, ...argumentLines(values, '            '), '        );']
          : [
              `        return new ${names.model}`,
              '        {',
              // Built by its properties: the fields the plan does not give keep the model's defaults
              ...initializerLines(
                values.filter((value) => given.has(value.name)),
                '            ',
              ),
              '        };',
            ]
      methods.push([
        `    /// <summary>A row of the ${info.name} table as ${article(plan.model).split(' ')[0].toLowerCase()} ${plan.model}.</summary>`,
        signature(body.uow, names.model, names.read, `${names.source} row`),
        '    {',
        ...body.lines.map((line) => `        ${line}`),
        ...result,
        '    }',
      ])
    }
  }
  if (helpers.size > 0) usings.add('System.Globalization')
  const helperBlocks = (['pair', 'part', 'rest'] as const)
    .filter((name) => helpers.has(name))
    .map((name) => HELPERS[name].map((line) => (line ? `    ${line}` : '')))
  const name = conversionsClass(info)
  const written = usings.write()
  const content = lines(
    written !== '' && written,
    ...[...aliases].sort(),
    (written !== '' || aliases.size > 0) && '',
    `namespace ${ns};`,
    '',
    `/// <summary>Conversions between the application models and the "${info.name}" table: what the service takes and returns.</summary>`,
    `public static class ${name}`,
    '{',
    ...[...methods, ...helperBlocks].flatMap((block, index) => [...(index > 0 ? [''] : []), ...block]),
    '}',
    '',
  )
  return { path: pathOf(ns, name), content }
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
  databaseMembers: Line[],
): GeneratedFile | null {
  const ns = `${context.base}.Tests`
  const usings = new CsUsings(ns).add('Xunit', context.base)
  const memory = context.settings.memoryRepositories
  const record = context.settings.dtoKind !== 'class'
  const tests: string[][] = []
  const readers = new Map<string, string>()
  for (const plan of plans) {
    const info = findInfo(context, plan.table)
    if (!info || !plan.read || hasTodo(plan.read) || !canMake(info) || !schema.models.some((item) => item.name === plan.model)) continue
    const names = conversionNames(context, plan)
    const dtos = usesDtos(context, info)
    const reads = plan.read.some((item) => ['lookup', 'children'].includes(item.value.kind))
    const writes = plan.write !== null && !hasTodo(plan.write)
    const writeUow = writes && plan.write!.some((item) => item.value.kind === 'lookup')
    usings.add(conversionsNamespace(context, info), namespaceOf(context, info, 'entity'))
    const reader = `${names.source}Of`
    if (dtos && !readers.has(info.name)) {
      usings.add(namespaceOf(context, info, 'dtos'))
      const columns = readColumns(info)
      readers.set(
        info.name,
        record
          ? `    private static ${names.source} ${reader}(${info.entity} entity) => new(${columns.map((column) => `entity.${column.prop}`).join(', ')});`
          : `    private static ${names.source} ${reader}(${info.entity} entity) => new() { ${columns.map((column) => `${column.prop} = entity.${column.prop}`).join(', ')} };`,
      )
    }
    const klass = conversionsClass(info)
    const call = (async: boolean, method: string, argument: string) =>
      async ? `await ${klass}.${method}Async(${argument}, uow)` : `${klass}.${method}(${argument})`
    const body = [
      `var row = await Factories.Add${info.entity}Async(uow, 1);`,
      `var model = ${call(reads, names.read, dtos ? `${reader}(row)` : 'row')};`,
      ...(writes
        ? [
            `var values = ${call(writeUow, names.write, 'model')};`,
            ...plan.write!.map(
              (item) => `Assert.Equal(row.${columnOf(info, item.column).prop}, values.${columnOf(info, item.column).prop});`,
            ),
          ]
        : ['Assert.NotNull(model);']),
    ]
    tests.push([
      '    [Fact]',
      `    public async Task ${writes ? `Reads${plan.model}AndWritesItBack` : `Reads${plan.model}`}()`,
      '    {',
      ...body.map((line) => `        ${line}`),
      '    }',
    ])
  }
  if (tests.length === 0) return null
  const content = lines(
    usings.write(),
    '',
    `namespace ${ns};`,
    '',
    '/// <summary>Tests of the conversions between the application models and the tables.</summary>',
    memory ? 'public class ConversionTests' : 'public class ConversionTests : IAsyncLifetime',
    '{',
    memory ? '    private readonly MemoryUnitOfWork uow = new();' : databaseMembers,
    ...tests.flatMap((test) => ['', ...test]),
    ...[...readers.values()].flatMap((reader) => ['', reader]),
    '}',
    '',
  )
  return { path: pathOf(ns, 'ConversionTests', true), content }
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
