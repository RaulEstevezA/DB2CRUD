/**
 * The conversions between the application models and the tables (conversions/plan.ts), written in Rust: per table,
 * a module with one function that turns a model into what the service takes (its create DTO, or the entity) and one
 * that turns what it returns into the model. Values are converted between the model's Rust types and the column's
 * (numbers of another size, decimals, text, chrono's dates and times, `Option`, enums by a `match`), so the crate
 * compiles without warnings; lookups go through the repositories of the unit of work (those functions are `async`
 * and return `Result<_, DomainError>`); Mapper's transformations are plain expressions; what the plan leaves to the
 * user is a `// TODO:` with the reason, or `todo!()` where a value is needed.
 *
 * Functions take references and clone what is not `Copy`. Models are built with a struct literal. They are copied
 * into the crate (`settings.modelsModule`, `app` standing for the crate) or, with `modelsSource: 'import'`, used from
 * the user's module: the copy then goes to `application-models/mod.rs`, which `lib.rs` declares with `#[path]` while
 * the project runs on its own (declare your module there inside the application).
 */
import { withoutHidden, type ConversionPlan, type ModelPath, type ReadValue, type Todo, type WriteValue } from '../../conversions/plan.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { MapperTransform } from '../../interop/mapper/read.ts'
import type { EnumDef, FieldDef, ModelDef, ModelSchema, TypeRef } from '../../model/schema.ts'
import {
  columnOf,
  fileOf,
  findInfo,
  moduleOf,
  pathIn,
  query,
  queryName,
  rsFile,
  stored,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { createDto, readColumns, readDto } from './dtos.ts'
import { rsString, RsUses, snakeName, typeName } from './rust.ts'

/** The folder of the copy of the models when they are imported from the user's module. */
export const MODELS_FOLDER = 'application-models'

/** The module of the application models in the crate: `app.application_models` → `crate::application_models`. */
export const modelsModule = (context: Context) => ['crate', ...context.settings.modelsModule.split('.').slice(1).map(snakeName)].join('::')

const usesDtos = (context: Context, info: TableInfo) =>
  context.settings.services && context.settings.serviceTypes === 'dtos' && info.service !== null && info.role === 'entity'

/** The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them. */
export const servicePlans = (context: Context, plans: ConversionPlan[]) =>
  plans.map((plan) => {
    const info = findInfo(context, plan.table)
    return info && usesDtos(context, info) ? withoutHidden(plan, info.hidden) : plan
  })

/** The module of the conversions of a table, by architecture. */
export const conversionsModule = (context: Context, info: TableInfo) =>
  context.settings.architecture === 'table' ? `crate::${info.attr}::conversions` : `crate::conversions::${info.module}`

/**
 * The names of a plan: its functions, the types they take and return, and the name the model is used by (an alias,
 * `ProductModel`, when it is named like the entity or a DTO of the same module).
 */
export function conversionNames(context: Context, plan: ConversionPlan) {
  const info = findInfo(context, plan.table)!
  const dtos = usesDtos(context, info)
  const target = dtos ? createDto(info) : info.entity
  const source = dtos ? readDto(info) : info.entity
  const clash = [info.entity, target, source].includes(plan.model)
  const model = clash ? `${plan.model}Model` : plan.model
  return {
    write: `${snakeName(model)}_to_${snakeName(target)}`,
    read: `${snakeName(source)}_to_${snakeName(model)}`,
    target,
    source,
    model,
    clash,
  }
}

// Types of the models

interface Models {
  schema: ModelSchema
  module: string
  uses?: RsUses
}

/** A model read from Rust keeps its names and types; the others get Rust's. */
const fromRust = (model: ModelDef) => model.fields.some((field) => field.originalType !== undefined)

const memberOf = (model: ModelDef | undefined, name: string) => (model && fromRust(model) ? name : snakeName(name))

const SHORT: Record<string, string> = {
  Decimal: 'rust_decimal::Decimal',
  NaiveDate: 'chrono::NaiveDate',
  NaiveTime: 'chrono::NaiveTime',
  NaiveDateTime: 'chrono::NaiveDateTime',
  Utc: 'chrono::Utc',
  FixedOffset: 'chrono::FixedOffset',
  DateTime: 'chrono::DateTime',
  Uuid: 'uuid::Uuid',
}

/** A type with the paths of the crates it names: `DateTime<Utc>` → `chrono::DateTime<chrono::Utc>`. */
const canonical = (type: string) =>
  type
    .replace(/\s+/g, '')
    .replace(/,/g, ', ')
    .replace(/(?<![\w:])([A-Z]\w*)/g, (name: string) => SHORT[name] ?? name)

/** The Rust type of a model's TypeRef, for models not read from Rust. */
function typeRefRs(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return {
        string: 'String',
        integer: type.bits === 32 || type.bits === 16 || type.bits === 8 ? 'i32' : 'i64',
        float: type.bits === 32 ? 'f32' : 'f64',
        decimal: 'rust_decimal::Decimal',
        boolean: 'bool',
        date: 'chrono::NaiveDate',
        datetime: 'chrono::DateTime<chrono::Utc>',
        time: 'chrono::NaiveTime',
        duration: 'i64',
        uuid: 'String',
        binary: 'Vec<u8>',
        any: 'String',
      }[type.name]
    case 'array':
      return `Vec<${typeRefRs(type.items)}>`
    case 'map':
      return `std::collections::HashMap<String, ${typeRefRs(type.value)}>`
    case 'model':
    case 'enum':
      return type.name
    case 'unknown':
      return 'String'
  }
}

/** The Rust type of a field, as the model has it (`Option<…>` when it may be null). */
function fieldRs(model: ModelDef | undefined, field: FieldDef): string {
  if (model && fromRust(model) && field.originalType) return canonical(field.originalType)
  const type = typeRefRs(field.type)
  return field.nullable || field.optional ? `Option<${type}>` : type
}

/** The variant of an enum value in Rust. */
const variant = (item: EnumDef, value: EnumDef['values'][number]) =>
  item.values.every((other) => /^[A-Z][A-Za-z0-9]*$/.test(other.name)) ? value.name : typeName(value.name)

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

/** The copy of the application models the conversions use: one module with every struct and enum. */
export function modelsFile(context: Context, schema: ModelSchema, plans: ConversionPlan[]): GeneratedFile {
  const { models, enums } = closure(schema, [...new Set(plans.map((plan) => plan.model))])
  const blocks = [
    ...enums.map((item) => [
      `/// ${item.name}, as the application has it.`,
      '#[derive(Debug, Clone, Copy, PartialEq)]',
      `pub enum ${item.name} {`,
      ...item.values.map((value) => `    ${variant(item, value)},`),
      '}',
    ]),
    ...models.map((model) => [
      `/// ${model.name}, as the application has it.`,
      '#[derive(Debug, Clone, PartialEq)]',
      `pub struct ${model.name} {`,
      ...model.fields.map((field) => `    pub ${memberOf(model, field.name)}: ${fieldRs(model, field)},`),
      '}',
    ]),
  ]
  const path = context.settings.modelsSource === 'copy' ? fileOf(modelsModule(context)) : `${MODELS_FOLDER}/mod.rs`
  return rsFile(
    path,
    '',
    blocks.flatMap((block, index) => [...(index > 0 ? [''] : []), ...block]),
    ['The application models the conversions use: a copy of the types DB2CRUD read.'],
  )
}

// Values

interface Typed {
  expression: string
  /** The type without `Option` */
  type: string
  optional: boolean
  /** A place (`row.name`): cloned when it is moved and its type is not `Copy` */
  place: boolean
  /** The name an `expect` gives when the value is empty */
  label?: string
}

const typed = (expression: string, type: string, optional = false, place = false): Typed => {
  const inner = /^Option<(.+)>$/.exec(type)
  return { expression, type: canonical(inner ? inner[1] : type), optional: optional || inner !== null, place }
}

interface Body {
  lines: string[]
  helpers: Set<'pair' | 'part' | 'rest'>
}

const INTEGERS = new Set(['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'isize', 'usize'])
const FLOATS = new Set(['f32', 'f64'])
const COPY = new Set([
  ...INTEGERS,
  ...FLOATS,
  'bool',
  'char',
  'rust_decimal::Decimal',
  'chrono::NaiveDate',
  'chrono::NaiveTime',
  'chrono::NaiveDateTime',
  'chrono::DateTime<chrono::Utc>',
  'chrono::DateTime<chrono::FixedOffset>',
  'uuid::Uuid',
])
const DECIMAL = 'rust_decimal::Decimal'
const UTC = 'chrono::DateTime<chrono::Utc>'
const FIXED = 'chrono::DateTime<chrono::FixedOffset>'
const NAIVE = 'chrono::NaiveDateTime'

/** An expression without the parentheses around all of it, which Rust warns about where a value goes. */
function bare(expression: string): string {
  if (!expression.startsWith('(') || !expression.endsWith(')')) return expression
  let depth = 0
  for (let index = 0; index < expression.length; index++) {
    if (expression[index] === '(') depth++
    else if (expression[index] === ')') depth--
    if (depth === 0 && index < expression.length - 1) return expression
  }
  return expression.slice(1, -1)
}

const isCopy = (models: Models, type: string) => COPY.has(type) || models.schema.enums.some((item) => item.name === type)

/** A value moved out of a place: cloned when its type is not `Copy`. */
const owned = (models: Models, value: Typed) =>
  value.place && !isCopy(models, value.type) ? `${value.expression}.clone()` : value.expression

/** A value that is there, of one Rust type, as another; null when DB2CRUD does not convert them. */
function core(models: Models, value: Typed, to: string): string | null {
  const from = value.type
  const expression = owned(models, value)
  if (from === to) return expression
  const fromEnum = models.schema.enums.find((item) => item.name === from)
  const toEnum = models.schema.enums.find((item) => item.name === to)
  for (const item of [fromEnum, toEnum]) if (item) models.uses?.add(`${models.module}::${item.name}`)
  if (fromEnum && to === 'String')
    return `match ${value.expression} { ${fromEnum.values.map((item) => `${from}::${variant(fromEnum, item)} => ${rsString(enumText(item))}.to_string()`).join(', ')} }`
  if (toEnum && from === 'String')
    return `match ${value.expression}.as_str() { ${toEnum.values.map((item) => `${rsString(enumText(item))} => ${to}::${variant(toEnum, item)}`).join(', ')}, _ => panic!("No ${to} for this value") }`
  const number = (type: string) => INTEGERS.has(type) || FLOATS.has(type)
  if (number(from) && number(to)) return `${expression} as ${to}`
  if (number(from) && to === DECIMAL)
    return FLOATS.has(from)
      ? `<rust_decimal::Decimal as rust_decimal::prelude::FromPrimitive>::from_f64(${expression} as f64).expect("a decimal")`
      : `rust_decimal::Decimal::from(${expression})`
  if (from === DECIMAL && number(to)) {
    const method = FLOATS.has(to) ? 'to_f64' : 'to_i64'
    return `rust_decimal::prelude::ToPrimitive::${method}(&${expression}).expect("a number") as ${to}`
  }
  if (to === 'String') return `${value.expression}.to_string()`
  if (from === 'String') return `${value.expression}.parse::<${to}>().expect(${rsString(`a ${to}`)})`
  const pairs: Record<string, string> = {
    [`${FIXED}>${NAIVE}`]: `${expression}.naive_utc()`,
    [`${UTC}>${NAIVE}`]: `${expression}.naive_utc()`,
    [`${NAIVE}>${UTC}`]: `${expression}.and_utc()`,
    [`${NAIVE}>${FIXED}`]: `${expression}.and_utc().fixed_offset()`,
    [`${UTC}>${FIXED}`]: `${expression}.fixed_offset()`,
    [`${FIXED}>${UTC}`]: `${expression}.with_timezone(&chrono::Utc)`,
    [`${NAIVE}>chrono::NaiveDate`]: `${expression}.date()`,
    [`chrono::NaiveDate>${NAIVE}`]: `${expression}.and_hms_opt(0, 0, 0).expect("a time")`,
  }
  return pairs[`${from}>${to}`] ?? null
}

/**
 * A value as another Rust type (`Option<…>` when it may be empty), or null when DB2CRUD does not convert them. An
 * empty value stays empty when the target takes it, and is taken as set (`expect`) when it does not.
 */
function convert(models: Models, value: Typed, to: string): string | null {
  const inner = /^Option<(.+)>$/.exec(to)
  const target = canonical(inner ? inner[1] : to)
  if (!value.optional) {
    const converted = core(models, value, target)
    return converted === null ? null : inner ? `Some(${bare(converted)})` : converted
  }
  const name = value.label ?? (value.expression.replace(/^.*\./, '').replace(/\W/g, '') || 'value')
  if (!inner)
    return core(
      models,
      { ...value, expression: `${owned(models, value)}.expect(${rsString(`${name} is set`)})`, optional: false, place: false },
      target,
    )
  const converted = core(models, { expression: 'it', type: value.type, optional: false, place: false }, target)
  if (converted === null) return null
  return converted === 'it' ? owned(models, value) : `${owned(models, value)}.map(|it| ${converted})`
}

/** A Rust literal of a Mapper constant, with its type. */
function literal(value: string | number | boolean | null): Typed {
  if (value === null) return typed('None', 'String', true)
  if (typeof value === 'string') return typed(`${rsString(value)}.to_string()`, 'String')
  if (typeof value === 'boolean') return typed(String(value), 'bool')
  return Number.isInteger(value) ? typed(`${value}_i64`, 'i64') : typed(`${value}_f64`, 'f64')
}

const INVERSE = { '*': '/', '/': '*', '+': '-', '-': '+' } as const

/** The transformation that undoes an invertible one. */
function inverse(transform: MapperTransform): MapperTransform {
  if (transform.kind === 'arithmetic') return { ...transform, operator: INVERSE[transform.operator] }
  if (transform.kind === 'enum') return { kind: 'enum', pairs: transform.pairs.map((pair) => ({ from: pair.to, to: pair.from })) }
  return transform
}

/** A value as the text Mapper compares: enums by their stored text. */
const text = (models: Models, value: Typed) => convert(models, value, 'String') ?? `${value.expression}.to_string()`

/** A Mapper transformation of typed values, as an expression of the type it gives; null when it cannot be written. */
function transformed(models: Models, transform: MapperTransform, values: Typed[], target: string, body: Body): Typed | null {
  const value = values[0]
  switch (transform.kind) {
    case 'direct':
      return value
    case 'concat':
      return typed(`[${values.map((item) => text(models, item)).join(', ')}].join(${rsString(transform.separator)})`, 'String')
    case 'split':
      if (transform.part === 'rest') {
        body.helpers.add('rest')
        return typed(`rest(&${text(models, value)}, ${rsString(transform.separator)})`, 'String')
      }
      body.helpers.add('part')
      return typed(
        `part(&${text(models, value)}, ${rsString(transform.separator)}, ${transform.part === 'last' ? -1 : transform.part})`,
        'String',
      )
    case 'constant':
      return literal(transform.value)
    case 'boolean':
      return typed(`[${transform.trueValues.map((item) => rsString(item)).join(', ')}].contains(&${text(models, value)}.as_str())`, 'bool')
    case 'enum': {
      body.helpers.add('pair')
      const pairs = transform.pairs.map((pair) => `(${rsString(pair.from)}, ${rsString(pair.to)})`).join(', ')
      const fallback = transform.fallback !== undefined ? `Some(${rsString(transform.fallback)})` : 'None'
      return typed(`pair(&[${pairs}], &${text(models, value)}, ${fallback})`, 'String')
    }
    case 'epoch': {
      const milliseconds = transform.unit === 'milliseconds'
      const plain = canonical(target.replace(/^Option<(.+)>$/, '$1'))
      // From a date and time: a number; from a number: a date and time in UTC
      if (INTEGERS.has(plain) || FLOATS.has(plain) || plain === 'String') {
        const moment = convert(models, value, UTC)
        if (moment === null) return null
        return typed(`${moment}.${milliseconds ? 'timestamp_millis()' : 'timestamp()'}`, 'i64')
      }
      const number = convert(models, value, 'i64')
      if (number === null) return null
      const call = milliseconds ? `chrono::DateTime::from_timestamp_millis(${number})` : `chrono::DateTime::from_timestamp(${number}, 0)`
      return typed(`${call}.expect("a time")`, UTC)
    }
    case 'arithmetic': {
      const number = convert(models, value, 'f64')
      if (number === null) return null
      const operand = literal(transform.operand).expression.replace(/_i64$/, '.0').replace(/_f64$/, '')
      return typed(`(${number} ${transform.operator} ${operand})`, 'f64')
    }
    default:
      return null
  }
}

/** A typed value as the type a column or field has: whole numbers rounded, then converted. */
function fit(models: Models, result: Typed, to: string): string | null {
  const plain = canonical(to.replace(/^Option<(.+)>$/, '$1'))
  if (INTEGERS.has(plain) && FLOATS.has(result.type)) return convert(models, { ...result, expression: `${result.expression}.round()` }, to)
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

/** One value of a struct literal, with what is left to the user. */
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
    if (!current || !field || result?.optional) return null
    expression = `${expression}.${memberOf(current, field.name)}`
    result = typed(expression, fieldRs(current, field), false, true)
    current =
      field.type.kind === 'model' ? models.schema.models.find((item) => item.name === (field.type as { name: string }).name) : undefined
  }
  return result
}

/** How a column is read: from a DTO as it is, from an entity as its `Option`. */
const columnTyped = (column: ColumnInfo, root: string, entity: boolean) =>
  typed(`${root}.${column.field}`, column.rs, entity || column.column.nullable, true)

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
  // DTOs and entities take every value as an Option
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(column.key)
    const converted = fit(models, result, `Option<${column.rs}>`)
    return converted === null ? unsupported(`${result.type} to ${column.rs}`) : { expression: converted }
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
      const argument = convert(models, given, by.rs)
      if (argument === null) return unsupported(`${given.type} to ${by.rs}`)
      const name = snakeName(other.entity)
      models.uses?.add(`crate::errors::DomainError`)
      body.lines.push(
        `let ${name} = uow.${other.attr}().${queryName(context, finder)}(${argument}).await?`,
        `    .ok_or_else(|| DomainError::not_found(${rsString(other.entity)}, &${given.expression}))?;`,
      )
      return finish(columnTyped(columnOf(other, value.key), name, true))
    }
    case 'mapper': {
      const sources = value.sources.map(source)
      if (sources.some((item) => item === null)) return unsupported(column.key)
      return finish(transformed(models, value.transform, sources as Typed[], column.rs, body))
    }
    case 'inverse': {
      const given = source(value.path)
      return finish(given && transformed(models, inverse(value.transform), [given], column.rs, body))
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
  const target = fieldRs(model, field)
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
      const name = snakeName(other.entity)
      const key = own(value.column)
      const nullable = columnOf(info, value.column).column.nullable
      const call = `uow.${other.attr}().${queryName(context, finder)}`
      body.lines.push(
        nullable
          ? `let ${name} = match ${key.expression} { Some(key) => ${call}(key).await?, None => None };`
          : `let ${name} = ${call}(${convert(models, key, columnOf(info, value.column).rs)}).await?;`,
      )
      const by = columnOf(other, value.by)
      return finish({ ...typed(`${name}.as_ref().and_then(|row| row.${by.field}.clone())`, by.rs, true), label: `${other.name}.${by.key}` })
    }
    case 'children': {
      const other = findInfo(context, value.table)
      const lister = other && (query(other, 'listByParent', [value.by]) ?? query(other, 'findAllBy', [value.by]))
      if (!other || !lister) return { expression: null, todo: 'no repository query reads it' }
      const item = columnTyped(columnOf(other, value.value), 'item', true)
      const element = /^Vec<(.+)>$/.exec(target)?.[1] ?? item.type
      const converted = convert(models, { ...item, place: false }, element)
      if (converted === null) return unsupported(`${item.type} to ${element}`)
      const key = convert(models, own(value.key), columnOf(info, value.key).rs)
      return {
        expression: `uow.${other.attr}().${queryName(context, lister)}(${key}).await?.into_iter().map(|item| ${converted}).collect()`,
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
    '/// The value an enum pair gives, or the fallback; a value without a pair is an error.',
    'fn pair(pairs: &[(&str, &str)], value: &str, fallback: Option<&str>) -> String {',
    '    let found = pairs.iter().find(|(from, _)| *from == value).map(|(_, to)| *to).or(fallback);',
    '    found.unwrap_or_else(|| panic!("No pair for {value}")).to_string()',
    '}',
  ],
  part: [
    '/// One part of a text split by a separator (the last one for -1), or an empty text.',
    'fn part(value: &str, separator: &str, index: i64) -> String {',
    '    let parts: Vec<&str> = value.split(separator).collect();',
    '    let at = if index < 0 { parts.len() as i64 - 1 } else { index };',
    '    parts.get(at as usize).map(|part| part.to_string()).unwrap_or_default()',
    '}',
  ],
  rest: [
    '/// What follows the first separator of a text, or an empty text.',
    'fn rest(value: &str, separator: &str) -> String {',
    '    value.split_once(separator).map(|(_, rest)| rest.to_string()).unwrap_or_default()',
    '}',
  ],
}

const comment = (value: Value) => (value.todo ? ` // TODO: ${value.name}: ${value.todo}` : '')

/** Whether a lookup or a list of the plan reads other rows, so the function takes the unit of work. */
const readsRows = (items: { value: { kind: string } }[] | null) =>
  (items ?? []).some((item) => ['lookup', 'children'].includes(item.value.kind))

/** The module of the conversions of one table: one function per direction its models go. */
export function conversionFile(context: Context, plans: ConversionPlan[], schema: ModelSchema): GeneratedFile | null {
  const info = findInfo(context, plans[0].table)
  if (!info) return null
  const uses = new RsUses()
  const models: Models = { schema, module: modelsModule(context), uses }
  const helpers = new Set<'pair' | 'part' | 'rest'>()
  const functions: string[][] = []
  const dtos = usesDtos(context, info)
  const kind = dtos ? 'dtos' : 'entity'
  for (const plan of plans) {
    const model = schema.models.find((item) => item.name === plan.model)
    const names = conversionNames(context, plan)
    uses.add(`${pathIn(models.module, plan.model)}${names.clash ? ` as ${names.model}` : ''}`)
    if (plan.write) {
      const body: Body = { lines: [], helpers }
      const values: Value[] = []
      for (const item of plan.write) {
        const column = columnOf(info, item.column)
        if (item.value.kind === 'todo') values.push({ name: column.field, expression: null, todo: todoText(item.value) })
        else values.push({ name: column.field, ...writeExpression(context, models, column, item.value, model, body) })
      }
      uses.add(pathIn(moduleOf(context, info, kind), names.target))
      const uow = readsRows(plan.write)
      if (uow) uses.add('crate::errors::DomainError', 'crate::unit_of_work::UnitOfWork')
      // Every field left out takes its default, None
      const literal = [
        `${names.target} {`,
        ...values.map((value) =>
          value.expression === null ? `    //${comment(value).slice(3)}` : `    ${value.name}: ${bare(value.expression)},${comment(value)}`,
        ),
        '    ..Default::default()',
        '}',
      ]
      functions.push([
        `/// ${article(plan.model)} as the ${info.name} table takes it.`,
        uow
          ? `pub async fn ${names.write}(model: &${names.model}, uow: &dyn UnitOfWork) -> Result<${names.target}, DomainError> {`
          : `pub fn ${names.write}(model: &${names.model}) -> ${names.target} {`,
        ...body.lines.map((line) => `    ${line}`),
        ...(uow ? ['    Ok(', ...literal.map((line) => `        ${line}`), '    )'] : literal.map((line) => `    ${line}`)),
        '}',
      ])
    }
    if (plan.read && model) {
      const body: Body = { lines: [], helpers }
      const values: Value[] = []
      for (const field of model.fields) {
        const item = plan.read.find((candidate) => candidate.field === field.name)
        const name = memberOf(model, field.name)
        const optional = fieldRs(model, field).startsWith('Option<')
        if (!item) values.push(optional ? { name, expression: 'None' } : { name, expression: null, todo: 'no column gives it' })
        else if (item.value.kind === 'todo') values.push({ name, expression: null, todo: todoText(item.value) })
        else values.push({ name, ...readExpression(context, models, info, dtos, model, field, item.value, body) })
      }
      uses.add(pathIn(moduleOf(context, info, kind), names.source))
      const uow = readsRows(plan.read)
      if (uow) uses.add('crate::errors::DomainError', 'crate::unit_of_work::UnitOfWork')
      const pending = values.some((value) => value.expression === null)
      // todo!() stands for a value left to the user, and says why when it runs
      const literal = [
        `${names.model} {`,
        ...values.map((value) =>
          value.expression === null
            ? `    ${value.name}: todo!(${rsString(`${value.name}: ${value.todo}`)}),`
            : `    ${value.name}: ${bare(value.expression)},${comment(value)}`,
        ),
        '}',
      ]
      functions.push(
        [
          `/// A row of the ${info.name} table as ${article(plan.model).split(' ')[0].toLowerCase()} ${plan.model}.`,
          pending && '#[allow(unreachable_code)]',
          uow
            ? `pub async fn ${names.read}(row: &${names.source}, uow: &dyn UnitOfWork) -> Result<${names.model}, DomainError> {`
            : `pub fn ${names.read}(row: &${names.source}) -> ${names.model} {`,
          ...body.lines.map((line) => `    ${line}`),
          ...(uow ? ['    Ok(', ...literal.map((line) => `        ${line}`), '    )'] : literal.map((line) => `    ${line}`)),
          '}',
        ].filter((line): line is string => typeof line === 'string'),
      )
    }
  }
  const blocks = [...functions, ...(['pair', 'part', 'rest'] as const).filter((name) => helpers.has(name)).map((name) => HELPERS[name])]
  const module = conversionsModule(context, info)
  return rsFile(
    fileOf(module),
    uses.write(),
    blocks.flatMap((block, index) => [...(index > 0 ? [''] : []), ...block]),
    [`Conversions between the application models and the "${info.name}" table: what the service takes and returns.`],
  )
}

const hasTodo = (items: { value: { kind: string } }[] | null) => (items ?? []).some((item) => item.value.kind === 'todo')

/** A path of the crate, as the tests name it: `crate::errors` → `data_access::errors`. */
const external = (context: Context, path: string) => path.replace(/^crate::/, `${context.crate}::`)

/**
 * The tests of the conversions (tests/data/conversions.rs): a row stored by the factories is read as the model, and
 * a model that goes both ways and leaves nothing to the user is written back, giving every value of the row (lookups
 * and Mapper's lossless transformations included).
 */
export function conversionTestFile(
  context: Context,
  plans: ConversionPlan[],
  schema: ModelSchema,
  canMake: (info: TableInfo) => boolean,
): GeneratedFile | null {
  const uses = new RsUses().add('super::factories')
  const memory = context.settings.memoryRepositories
  if (memory) uses.add(`${context.crate}::unit_of_work::MemoryUnitOfWork`)
  else uses.add('super::database')
  const tests: string[][] = []
  const readers = new Map<string, string[]>()
  for (const plan of plans) {
    const info = findInfo(context, plan.table)
    if (!info || !plan.read || hasTodo(plan.read) || !canMake(info) || !schema.models.some((item) => item.name === plan.model)) continue
    const names = conversionNames(context, plan)
    const dtos = usesDtos(context, info)
    const writes = plan.write !== null && !hasTodo(plan.write)
    const module = external(context, conversionsModule(context, info))
    uses.add(`${module}::${names.read}`)
    if (writes) uses.add(`${module}::${names.write}`)
    const reader = `${snakeName(names.source)}_of`
    if (dtos && !readers.has(info.name)) {
      uses.add(
        external(context, pathIn(moduleOf(context, info, 'dtos'), names.source)),
        external(context, pathIn(moduleOf(context, info, 'entity'), info.entity)),
      )
      readers.set(info.name, [
        '/// The row as the service returns it.',
        `fn ${reader}(entity: &${info.entity}) -> ${names.source} {`,
        `    ${names.source} {`,
        ...readColumns(info).map((column) => `        ${column.field}: ${stored(`entity.${column.field}`, column)},`),
        '    }',
        '}',
      ])
    }
    const call = (async: boolean, method: string, argument: string) =>
      async ? `${method}(${argument}, &uow).await.expect("a conversion")` : `${method}(${argument})`
    const body = [
      memory ? 'let uow = MemoryUnitOfWork::default();' : 'let (_turn, uow) = database::open().await;',
      `let row = factories::add_${info.module.replace(/^r#/, '')}(&uow, 1).await;`,
      `let model = ${call(readsRows(plan.read), names.read, dtos ? `&${reader}(&row)` : '&row')};`,
      ...(writes
        ? [
            `let values = ${call(readsRows(plan.write), names.write, '&model')};`,
            ...plan.write!.map(
              (item) => `assert_eq!(row.${columnOf(info, item.column).field}, values.${columnOf(info, item.column).field});`,
            ),
          ]
        : ['let _ = model;']),
    ]
    tests.push([
      '#[tokio::test]',
      `async fn ${writes ? `reads_${snakeName(plan.model)}_and_writes_it_back` : `reads_${snakeName(plan.model)}`}() {`,
      ...body.map((line) => `    ${line}`),
      '}',
    ])
  }
  if (tests.length === 0) return null
  return rsFile(
    'tests/data/conversions.rs',
    uses.write(),
    [...tests, ...readers.values()].flatMap((block, index) => [...(index > 0 ? [''] : []), ...block]),
    ['The conversions between the application models and the tables.'],
  )
}

/** The conversion modules of a project and, when they are copied, the module of the models. */
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
  return [...files, modelsFile(context, schema, plans)]
}
