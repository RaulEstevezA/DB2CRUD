/**
 * The conversions between the application models and the tables (conversions/plan.ts), written in Java: per table, a
 * final class of static methods, one that turns a model into what the service takes (its create DTO, or the entity)
 * and one that turns what it returns into the model. Values are converted between the model's Java types and the
 * column's (numbers of another size, text, dates and times, enums by a switch), so the project compiles; lookups go
 * through the repositories of the unit of work; Mapper's transformations are plain expressions; what the plan leaves
 * to the user is a `// TODO:` with the reason.
 *
 * Models are read and built as the application has them: records with `name()`, classes with getters or public
 * fields, filled with setters, a builder or a constructor. They are copied into the project (`settings.modelsModule`
 * as their package) or, with `modelsSource: 'import'`, used from the user's package: the copy then goes to
 * `application-models/`, a source folder the build adds only while it exists (delete it inside the application).
 */
import { withoutHidden, type ConversionPlan, type ModelPath, type ReadValue, type Todo, type WriteValue } from '../../conversions/plan.ts'
import type { GeneratedFile } from '../../export/files.ts'
import type { MapperTransform } from '../../interop/mapper/read.ts'
import type { EnumDef, FieldDef, ModelDef, ModelSchema, TypeRef } from '../../model/schema.ts'
import { lines } from '../types.ts'
import { capitalized, javaPath, javaString, JavaImports, memberName } from './java.ts'
import { columnOf, errorsPackage, findInfo, qualified, query, queryName, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import { accessor, createColumns, createDto, readColumns, readDto } from './dtos.ts'

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The Java name of a model field: its name, or its camelCase form when the name is not an identifier. */
export const fieldName = (name: string) => (IDENTIFIER.test(name) ? name : memberName(name))

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

export const conversionsClass = (info: TableInfo) => `${info.entity}Conversions`

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/**
 * The names of a plan: its methods, the classes they take and return, and how the model is written (by its package
 * when it is named like the entity or a DTO of the same file).
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
    /** How the model's class is written in the file */
    model: clash ? `${context.settings.modelsModule}.${plan.model}` : plan.model,
    clash,
  }
}

// Types of the models

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
  List: 'java.util.List',
  Set: 'java.util.Set',
  Map: 'java.util.Map',
}

/** The Java type of a model's TypeRef, for models of no language. */
function typeRefJava(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return {
        string: 'String',
        integer: type.bits === 32 || type.bits === 16 || type.bits === 8 ? 'Integer' : 'Long',
        float: type.bits === 32 ? 'Float' : 'Double',
        decimal: 'BigDecimal',
        boolean: 'Boolean',
        date: 'LocalDate',
        datetime: 'OffsetDateTime',
        time: 'LocalTime',
        duration: 'Duration',
        uuid: 'UUID',
        binary: 'byte[]',
        any: 'Object',
      }[type.name]
    case 'array':
      return `List<${typeRefJava(type.items)}>`
    case 'map':
      return `Map<String, ${typeRefJava(type.value)}>`
    case 'model':
    case 'enum':
      return type.name
    case 'unknown':
      return 'Object'
  }
}

/** `java.time.LocalDate` → `LocalDate`, in every part of a type. */
const simple = (type: string) => type.replace(/\b(?:[a-z_][\w]*\.)+(?=[A-Z])/g, '')

interface Models {
  schema: ModelSchema
  /** The models were read from Java: their own types and accessors are kept */
  java: boolean
  /** The package the conversions import them from */
  pkg: string
}

/** The Java type of a field, as the model has it. */
function fieldJava(models: Models, field: FieldDef): string {
  if (models.java && field.originalType) return simple(field.originalType)
  return typeRefJava(field.type)
}

type Accessors = 'record' | 'getters' | 'fields'
type Construction = 'positional' | 'properties' | 'builder'

/** How a model is read and built. */
function styleOf(models: Models, model: ModelDef): { accessors: Accessors; construction: Construction } {
  if (!models.java)
    return (model.extends ?? []).length > 0
      ? { accessors: 'getters', construction: 'properties' }
      : { accessors: 'record', construction: 'positional' }
  const accessors = (model.metadata?.accessors as Accessors | undefined) ?? 'getters'
  if (accessors === 'record') return { accessors, construction: 'positional' }
  return { accessors, construction: model.metadata?.builder ? 'builder' : 'properties' }
}

const getter = (models: Models, field: FieldDef) =>
  `${fieldJava(models, field) === 'boolean' ? 'is' : 'get'}${capitalized(fieldName(field.name))}`

/** How a field of a model is read: `name()`, `getName()` or `name`. */
function access(models: Models, model: ModelDef, field: FieldDef): string {
  const style = styleOf(models, model).accessors
  if (style === 'record') return `${fieldName(field.name)}()`
  if (style === 'fields') return fieldName(field.name)
  return `${getter(models, field)}()`
}

/** The constant of an enum value in Java. */
function enumConstant(models: Models, value: EnumDef['values'][number]): string {
  if (models.java) return value.name
  return memberName(value.name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
}

/** The text an enum value is stored as. */
const enumText = (value: EnumDef['values'][number]) => String(value.value ?? value.name)

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

function importsOfTypes(imports: JavaImports, types: string[]) {
  for (const type of types) for (const word of type.match(/\b[A-Z]\w*/g) ?? []) if (KNOWN[word]) imports.add(KNOWN[word])
}

/** The class of a copied model, as the application has it. */
function modelClass(models: Models, model: ModelDef): string[] {
  const { accessors, construction } = styleOf(models, model)
  const fields = model.fields.map((field) => ({ type: fieldJava(models, field), name: fieldName(field.name), field }))
  const doc = `/** ${model.name}, as the application has it. */`
  if (accessors === 'record')
    return [
      doc,
      fields.length === 0 ? `public record ${model.name}() {}` : `public record ${model.name}(`,
      ...(fields.length === 0
        ? []
        : [...fields.map((item, index) => `        ${item.type} ${item.name}${index < fields.length - 1 ? ',' : ''}`), ') {}']),
    ]
  const extended = model.extends?.length ? ` extends ${model.extends[0]}` : ''
  const visibility = accessors === 'fields' ? 'public' : 'private'
  const body: string[] = fields.map((item) => `    ${visibility} ${item.type} ${item.name};`)
  if (accessors === 'getters')
    for (const item of fields)
      body.push(
        '',
        `    public ${item.type} ${getter(models, item.field)}() {`,
        `        return ${item.name};`,
        '    }',
        '',
        `    public void set${capitalized(item.name)}(${item.type} ${item.name}) {`,
        `        this.${item.name} = ${item.name};`,
        '    }',
      )
  if (construction === 'builder')
    body.push(
      '',
      `    public static Builder builder() {`,
      '        return new Builder();',
      '    }',
      '',
      `    /** Builds a ${model.name}, as Lombok's @Builder does. */`,
      '    public static class Builder {',
      `        private final ${model.name} built = new ${model.name}();`,
      ...fields.flatMap((item) => [
        '',
        `        public Builder ${item.name}(${item.type} ${item.name}) {`,
        `            built.${item.name} = ${item.name};`,
        '            return this;',
        '        }',
      ]),
      '',
      `        public ${model.name} build() {`,
      '            return built;',
      '        }',
      '    }',
    )
  return [doc, `public class ${model.name}${extended} {`, ...body, '}']
}

/** The copy of the application models the conversions use: a class or enum per file. */
export function modelFiles(context: Context, schema: ModelSchema, plans: ConversionPlan[]): GeneratedFile[] {
  const models: Models = { schema, java: schema.origin?.language === 'java', pkg: context.settings.modelsModule }
  const pkg = context.settings.modelsModule
  const folder = context.settings.modelsSource === 'copy' ? '' : `${MODELS_FOLDER}/`
  const { models: classes, enums } = closure(schema, [...new Set(plans.map((plan) => plan.model))])
  const unit = (name: string, imports: JavaImports, body: string[]): GeneratedFile => {
    const written = imports.write()
    return {
      path: `${folder}${javaPath(pkg, name)}`,
      content: lines(`package ${pkg};`, '', written !== '' && [written, ''], ...body, ''),
    }
  }
  return [
    ...enums.map((item) =>
      unit(item.name, new JavaImports(pkg), [
        `/** ${item.name}, as the application has it. */`,
        `public enum ${item.name} {`,
        `    ${item.values.map((value) => enumConstant(models, value)).join(', ')}`,
        '}',
      ]),
    ),
    ...classes.map((model) => {
      const imports = new JavaImports(pkg)
      importsOfTypes(
        imports,
        model.fields.map((field) => fieldJava(models, field)),
      )
      return unit(model.name, imports, modelClass(models, model))
    }),
  ]
}

// Values

const BOXES: Record<string, string> = {
  byte: 'Byte',
  short: 'Short',
  int: 'Integer',
  long: 'Long',
  float: 'Float',
  double: 'Double',
  boolean: 'Boolean',
  char: 'Character',
}
const PRIMITIVE_OF: Record<string, string> = Object.fromEntries(Object.entries(BOXES).map(([primitive, box]) => [box, primitive]))
const NUMBERS = new Set(['Byte', 'Short', 'Integer', 'Long', 'Float', 'Double', 'BigDecimal', 'BigInteger'])
const TEMPORAL = new Set(['LocalDate', 'LocalDateTime', 'LocalTime', 'OffsetDateTime', 'OffsetTime', 'Instant', 'ZonedDateTime'])
const PARSE: Record<string, string> = {
  Byte: 'Byte.valueOf',
  Short: 'Short.valueOf',
  Integer: 'Integer.valueOf',
  Long: 'Long.valueOf',
  Float: 'Float.valueOf',
  Double: 'Double.valueOf',
  Boolean: 'Boolean.valueOf',
}

const isPrimitive = (type: string) => type in BOXES
const boxed = (type: string) => BOXES[type] ?? type

interface Body {
  lines: string[]
  uow: boolean
  imports: JavaImports
  /** The helpers the file needs */
  helpers: Set<'pair' | 'part' | 'rest'>
}

interface Typed {
  expression: string
  type: string
  /** Never null: a transformation's result */
  present?: boolean
}

/** The conversion of a non-null value from one temporal type to another, or null. */
function temporal(expression: string, from: string, to: string, body: Body): string | null {
  const utc = () => {
    body.imports.add('java.time.ZoneOffset')
    return 'ZoneOffset.UTC'
  }
  const instant = (): string | null => {
    switch (from) {
      case 'Instant':
        return expression
      case 'OffsetDateTime':
      case 'ZonedDateTime':
        return `${expression}.toInstant()`
      case 'LocalDateTime':
        return `${expression}.toInstant(${utc()})`
      case 'LocalDate':
        return `${expression}.atStartOfDay().toInstant(${utc()})`
      default:
        return null
    }
  }
  if (from === 'OffsetDateTime' && to === 'LocalDateTime') return `${expression}.toLocalDateTime()`
  if (from === 'LocalDateTime' && to === 'LocalDate') return `${expression}.toLocalDate()`
  if (from === 'OffsetDateTime' && to === 'LocalDate') return `${expression}.toLocalDate()`
  if (from === 'LocalDate' && to === 'LocalDateTime') return `${expression}.atStartOfDay()`
  if (from === 'OffsetTime' && to === 'LocalTime') return `${expression}.toLocalTime()`
  if (from === 'LocalTime' && to === 'OffsetTime') return `${expression}.atOffset(${utc()})`
  const moment = instant()
  if (moment === null) return null
  if (KNOWN[to]) body.imports.add(KNOWN[to])
  switch (to) {
    case 'Instant':
      return moment
    case 'OffsetDateTime':
      return from === 'LocalDateTime' ? `${expression}.atOffset(${utc()})` : `${moment}.atOffset(${utc()})`
    case 'ZonedDateTime':
      return `${moment}.atZone(${utc()})`
    case 'LocalDateTime':
      return `LocalDateTime.ofInstant(${moment}, ${utc()})`
    case 'LocalDate':
      return `LocalDate.ofInstant(${moment}, ${utc()})`
    default:
      return null
  }
}

/**
 * A value of one Java type as another, or null when DB2CRUD does not convert them. A value that may be null stays
 * null.
 */
function convert(models: Models, value: Typed, to: string, body: Body): string | null {
  const { expression } = value
  const from = value.type
  const present = value.present === true || isPrimitive(from) || isPrimitive(to)
  if (from === to || to === 'Object' || boxed(from) === boxed(to)) return expression
  // A value that may be null is converted only when it is there
  const guard = (converted: string) => (present ? converted : `${expression} == null ? null : ${converted}`)
  const fromEnum = models.schema.enums.find((item) => item.name === from)
  const toEnum = models.schema.enums.find((item) => item.name === to)
  if (fromEnum && to === 'String')
    return guard(
      `switch (${expression}) { ${fromEnum.values.map((item) => `case ${enumConstant(models, item)} -> ${javaString(enumText(item))};`).join(' ')} }`,
    )
  if (toEnum) body.imports.add(`${models.pkg}.${to}`)
  if (toEnum && from === 'String')
    return guard(
      `switch (${expression}) { ${toEnum.values.map((item) => `case ${javaString(enumText(item))} -> ${to}.${enumConstant(models, item)};`).join(' ')} default -> throw new IllegalArgumentException(${present ? `"No ${to} for this value"` : `"No ${to} for " + ${expression}`}); }`,
    )
  const source = boxed(from)
  const target = boxed(to)
  if (NUMBERS.has(source) && NUMBERS.has(target)) {
    if (target === 'BigDecimal') {
      body.imports.add('java.math.BigDecimal')
      return guard(source === 'BigInteger' ? `new BigDecimal(${expression})` : `BigDecimal.valueOf(${expression})`)
    }
    if (target === 'BigInteger') {
      body.imports.add('java.math.BigInteger')
      return guard(source === 'BigDecimal' ? `${expression}.toBigInteger()` : `BigInteger.valueOf(${expression})`)
    }
    const primitive = PRIMITIVE_OF[target]
    return guard(isPrimitive(from) ? `(${primitive}) ${expression}` : `${expression}.${primitive}Value()`)
  }
  if (target === 'String') {
    if (isPrimitive(from)) return `String.valueOf(${expression})`
    return guard(from === 'BigDecimal' ? `${expression}.toPlainString()` : `${expression}.toString()`)
  }
  if (source === 'String') {
    if (PARSE[target]) return guard(`${PARSE[target]}(${expression})`)
    if (target === 'BigDecimal' || target === 'BigInteger') {
      body.imports.add(KNOWN[target])
      return guard(`new ${target}(${expression})`)
    }
    if (target === 'UUID') {
      body.imports.add('java.util.UUID')
      return guard(`UUID.fromString(${expression})`)
    }
    if (TEMPORAL.has(target)) {
      body.imports.add(KNOWN[target])
      return guard(`${target}.parse(${expression})`)
    }
    return null
  }
  if (TEMPORAL.has(source) && TEMPORAL.has(target)) {
    const converted = temporal(expression, source, target, body)
    return converted === null ? null : guard(converted)
  }
  return null
}

/** A Java literal of a Mapper constant, with its type. */
function literal(value: string | number | boolean | null): Typed {
  if (value === null) return { expression: 'null', type: 'Object' }
  if (typeof value === 'string') return { expression: javaString(value), type: 'String', present: true }
  if (typeof value === 'boolean') return { expression: String(value), type: 'boolean' }
  return Number.isInteger(value)
    ? { expression: `${value}L`, type: 'long', present: true }
    : { expression: String(value), type: 'double', present: true }
}

const INVERSE = { '*': '/', '/': '*', '+': '-', '-': '+' } as const

/** The transformation that undoes an invertible one. */
function inverse(transform: MapperTransform): MapperTransform {
  if (transform.kind === 'arithmetic') return { ...transform, operator: INVERSE[transform.operator] }
  if (transform.kind === 'enum') return { kind: 'enum', pairs: transform.pairs.map((pair) => ({ from: pair.to, to: pair.from })) }
  return transform
}

/** A Mapper transformation of typed values, as an expression of the type it gives; null when it cannot be written. */
function transformed(models: Models, transform: MapperTransform, values: Typed[], target: string, body: Body): Typed | null {
  const value = values[0]
  switch (transform.kind) {
    case 'direct':
      return value
    case 'concat':
      return {
        expression: `String.join(${javaString(transform.separator)}, ${values.map((item) => `String.valueOf(${item.expression})`).join(', ')})`,
        type: 'String',
        present: true,
      }
    case 'split':
      if (transform.part === 'rest') {
        body.helpers.add('rest')
        return { expression: `rest(${value.expression}, ${javaString(transform.separator)})`, type: 'String', present: true }
      }
      body.helpers.add('part')
      return {
        expression: `part(${value.expression}, ${javaString(transform.separator)}, ${transform.part === 'last' ? -1 : transform.part})`,
        type: 'String',
        present: true,
      }
    case 'constant':
      return literal(transform.value)
    case 'boolean':
      body.imports.add('java.util.List')
      return {
        expression: `List.of(${transform.trueValues.map((item) => javaString(item)).join(', ')}).contains(String.valueOf(${value.expression}))`,
        type: 'boolean',
        present: true,
      }
    case 'enum': {
      body.helpers.add('pair')
      body.imports.add('java.util.Map')
      const pairs = transform.pairs.map((pair) => `Map.entry(${javaString(pair.from)}, ${javaString(pair.to)})`).join(', ')
      const fallback = transform.fallback !== undefined ? javaString(transform.fallback) : 'null'
      return { expression: `pair(Map.ofEntries(${pairs}), ${value.expression}, ${fallback})`, type: 'String', present: true }
    }
    case 'epoch': {
      const milliseconds = transform.unit === 'milliseconds'
      // From a date and time: a number; from a number: an instant
      if (NUMBERS.has(boxed(target)) || target === 'String') {
        const moment = convert(models, { ...value, present: true }, 'Instant', body)
        if (moment === null) return null
        return { expression: `${moment}.${milliseconds ? 'toEpochMilli()' : 'getEpochSecond()'}`, type: 'long', present: true }
      }
      const number = convert(models, { ...value, present: true }, 'long', body)
      if (number === null) return null
      body.imports.add('java.time.Instant')
      return { expression: `Instant.${milliseconds ? 'ofEpochMilli' : 'ofEpochSecond'}(${number})`, type: 'Instant', present: true }
    }
    case 'arithmetic': {
      const number = convert(models, { ...value, present: true }, 'double', body)
      if (number === null) return null
      return {
        expression: `(${number} ${transform.operator} ${literal(transform.operand).expression.replace(/L$/, '')})`,
        type: 'double',
        present: true,
      }
    }
    default:
      return null
  }
}

/** A typed value as the type a column or field has: whole numbers rounded, then converted. */
function fit(models: Models, result: Typed, to: string, body: Body): string | null {
  const whole = ['Byte', 'Short', 'Integer', 'Long', 'BigInteger'].includes(boxed(to))
  const rounded =
    whole && (result.type === 'double' || result.type === 'float')
      ? { expression: `Math.round(${result.expression})`, type: 'long', present: true }
      : result
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

/** The default of a value left out of a constructor. */
const missing = (type: string) =>
  isPrimitive(type) ? ({ boolean: 'false', char: "'\\0'", float: '0f', double: '0d', long: '0L' }[type] ?? '0') : 'null'

/** One value of a call or of a block, with the comment that explains it. */
interface Value {
  name: string
  expression: string
  todo?: string
}

/** The arguments of a call, one per line, with their comments. */
function argumentLines(values: Value[], indent: string): string[] {
  return values.map((value, index) => {
    const comma = index < values.length - 1 ? ',' : ''
    return `${indent}${value.expression}${comma}${value.todo ? ` // TODO: ${value.name}: ${value.todo}` : ''}`
  })
}

/** The field of a model a path names, with how it is read, walking nested models. */
function walk(models: Models, model: ModelDef | undefined, path: ModelPath, root: string): Typed | null {
  let current = model
  let expression = root
  let type = 'Object'
  for (const part of path) {
    const field = current?.fields.find((item) => item.name === part)
    if (!current || !field) return null
    expression = `${expression}.${access(models, current, field)}`
    type = fieldJava(models, field)
    current =
      field.type.kind === 'model' ? models.schema.models.find((item) => item.name === (field.type as { name: string }).name) : undefined
  }
  return { expression, type }
}

function writeExpression(
  context: Context,
  models: Models,
  column: ColumnInfo,
  value: Exclude<WriteValue, Todo>,
  model: ModelDef | undefined,
  body: Body,
): { expression: string; todo?: string } {
  const unsupported = (detail: string) => ({ expression: 'null', todo: `${WHY.unsupported} (${detail})` })
  const typed = (path: ModelPath) => walk(models, model, path, 'model')
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(column.prop)
    const converted = fit(models, result, column.java, body)
    return converted === null ? unsupported(`${result.type} to ${column.java}`) : { expression: converted }
  }
  switch (value.kind) {
    case 'field':
      return finish(typed(value.path))
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && query(other, 'findByUnique', [value.by])
      const given = typed(value.path)
      if (!other || !finder || !given) return { expression: 'null', todo: 'no repository query finds the row it names' }
      const argument = convert(models, given, columnOf(other, value.by).java, body)
      if (argument === null) return unsupported(`${given.type} to ${columnOf(other, value.by).java}`)
      const name = memberName(other.entity)
      body.uow = true
      body.imports.add(qualified(context, other, 'entity', other.entity), `${errorsPackage(context)}.NotFoundException`)
      body.lines.push(
        `${other.entity} ${name} = uow.${other.attr}().${queryName(context, finder)}(${argument})`,
        `        .orElseThrow(() -> new NotFoundException(${javaString(other.entity)}, ${given.expression}));`,
      )
      return finish({ expression: `${name}.${columnOf(other, value.key).getter}()`, type: columnOf(other, value.key).java })
    }
    case 'mapper': {
      const sources = value.sources.map(typed)
      if (sources.some((item) => item === null)) return unsupported(column.prop)
      return finish(transformed(models, value.transform, sources as Typed[], column.java, body))
    }
    case 'inverse': {
      const source = typed(value.path)
      return finish(source && transformed(models, inverse(value.transform), [source], column.java, body))
    }
  }
}

function readExpression(
  context: Context,
  models: Models,
  info: TableInfo,
  dtos: boolean,
  field: FieldDef,
  value: Exclude<ReadValue, Todo>,
  body: Body,
): { expression: string; todo?: string } {
  const target = fieldJava(models, field)
  const read = (other: TableInfo, name: string, root: string, entity = !dtos || other !== info): Typed => {
    const column = columnOf(other, name)
    return { expression: `${root}.${entity ? `${column.getter}()` : accessor(context, column.prop)}`, type: column.java }
  }
  const unsupported = (detail: string) => ({ expression: missing(target), todo: `${WHY.unsupported} (${detail})` })
  const finish = (result: Typed | null) => {
    if (!result) return unsupported(field.name)
    const converted = fit(models, result, target, body)
    return converted === null ? unsupported(`${result.type} to ${target}`) : { expression: converted }
  }
  switch (value.kind) {
    case 'column':
      return finish(read(info, value.column, 'row'))
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && (query(other, 'getByKey') ?? query(other, 'findByUnique', [value.key]))
      if (!other || !finder) return { expression: missing(target), todo: 'no repository query reads it' }
      const name = memberName(other.entity)
      const own = read(info, value.column, 'row')
      const nullable = columnOf(info, value.column).column.nullable
      body.uow = true
      body.imports.add(qualified(context, other, 'entity', other.entity))
      const found = `uow.${other.attr}().${queryName(context, finder)}(${own.expression})`
      body.lines.push(
        nullable
          ? `${other.entity} ${name} = ${own.expression} == null ? null : ${found}.orElse(null);`
          : `${other.entity} ${name} = ${found}.orElseThrow();`,
      )
      const by = read(other, value.by, name, true)
      const result: { expression: string; todo?: string } = finish(by)
      return nullable && !result.todo ? { expression: `${name} == null ? null : ${result.expression}` } : result
    }
    case 'children': {
      const other = findInfo(context, value.table)
      const lister = other && (query(other, 'listByParent', [value.by]) ?? query(other, 'findAllBy', [value.by]))
      if (!other || !lister) return { expression: missing(target), todo: 'no repository query reads it' }
      body.uow = true
      const item = read(other, value.value, 'item', true)
      const element = /^(?:List|Set|Collection)<(.+)>$/.exec(target)?.[1] ?? item.type
      const converted = convert(models, item, element, body)
      if (converted === null) return unsupported(`${item.type} to ${element}`)
      const key = read(info, value.key, 'row')
      const list = `uow.${other.attr}().${queryName(context, lister)}(${key.expression}).stream().map(item -> ${converted})`
      if (target.startsWith('Set<')) {
        body.imports.add('java.util.stream.Collectors')
        return { expression: `${list}.collect(Collectors.toSet())` }
      }
      return { expression: `${list}.toList()` }
    }
    case 'mapper':
      return finish(
        transformed(
          models,
          value.transform,
          value.columns.map((column) => read(info, column, 'row')),
          target,
          body,
        ),
      )
    case 'inverse':
      return finish(transformed(models, inverse(value.transform), [read(info, value.column, 'row')], target, body))
  }
}

const HELPERS = {
  pair: [
    '/** The value an enum pair gives, or the fallback; a value without a pair is an error. */',
    'private static String pair(Map<String, String> pairs, Object value, String fallback) {',
    '    String found = pairs.getOrDefault(String.valueOf(value), fallback);',
    '    if (found == null) throw new IllegalArgumentException("No pair for " + value);',
    '    return found;',
    '}',
  ],
  part: [
    '/** One part of a text split by a separator (the last one for -1), or an empty text. */',
    'private static String part(Object value, String separator, int index) {',
    '    String[] parts = String.valueOf(value).split(Pattern.quote(separator), -1);',
    '    int at = index < 0 ? parts.length - 1 : index;',
    '    return at < parts.length ? parts[at] : "";',
    '}',
  ],
  rest: [
    '/** What follows the first separator of a text, or an empty text. */',
    'private static String rest(Object value, String separator) {',
    '    String text = String.valueOf(value);',
    '    int at = text.indexOf(separator);',
    '    return at < 0 ? "" : text.substring(at + separator.length());',
    '}',
  ],
}

/** The class of the conversions of one table: one method per direction its models go. */
export function conversionFile(context: Context, plans: ConversionPlan[], schema: ModelSchema): GeneratedFile | null {
  const info = findInfo(context, plans[0].table)
  if (!info) return null
  const models: Models = { schema, java: schema.origin?.language === 'java', pkg: context.settings.modelsModule }
  const pkg = conversionsPackage(context, info)
  const imports = new JavaImports(pkg)
  const helpers = new Set<'pair' | 'part' | 'rest'>()
  const methods: string[][] = []
  const dtos = usesDtos(context, info)
  for (const plan of plans) {
    const model = schema.models.find((item) => item.name === plan.model)
    const names = conversionNames(context, plan)
    if (!names.clash) imports.add(`${context.settings.modelsModule}.${plan.model}`)
    if (plan.write) {
      const body: Body = { lines: [], uow: false, imports, helpers }
      const values: Value[] = []
      for (const item of plan.write) {
        const column = columnOf(info, item.column)
        if (item.value.kind === 'todo') values.push({ name: column.prop, expression: 'null', todo: todoText(item.value) })
        else values.push({ name: column.prop, ...writeExpression(context, models, column, item.value, model, body) })
      }
      const params = `${names.model} model${body.uow ? ', UnitOfWork uow' : ''}`
      if (body.uow) imports.add(`${context.base}.UnitOfWork`)
      let result: string[]
      if (dtos) {
        imports.add(qualified(context, info, 'dtos', names.target))
        // Every value of the create DTO, in its order; those the model does not give are null
        const all = createColumns(info).map(
          (column) => values.find((value) => value.name === column.prop) ?? { name: column.prop, expression: 'null' },
        )
        result = [`        return new ${names.target}(`, ...argumentLines(all, '                '), '        );']
      } else {
        imports.add(qualified(context, info, 'entity', info.entity))
        result = [
          `        ${info.entity} entity = new ${info.entity}();`,
          ...values.map((value) => {
            const setter = info.columns.find((column) => column.prop === value.name)!.setter
            const call = `        entity.${setter}(${value.expression});`
            return value.todo ? `${call} // TODO: ${value.name}: ${value.todo}` : call
          }),
          '        return entity;',
        ]
      }
      methods.push([
        `    /** ${article(plan.model)} as the ${info.name} table takes it. */`,
        `    public static ${names.target} ${names.write}(${params}) {`,
        ...body.lines.map((line) => `        ${line}`),
        ...result,
        '    }',
      ])
    }
    if (plan.read && model) {
      const body: Body = { lines: [], uow: false, imports, helpers }
      const values: Value[] = []
      for (const field of model.fields) {
        const item = plan.read.find((candidate) => candidate.field === field.name)
        const name = fieldName(field.name)
        if (!item) {
          values.push({ name, expression: missing(fieldJava(models, field)) })
          continue
        }
        if (item.value.kind === 'todo') values.push({ name, expression: missing(fieldJava(models, field)), todo: todoText(item.value) })
        else values.push({ name, ...readExpression(context, models, info, dtos, field, item.value, body) })
      }
      const given = new Set(plan.read.map((item) => fieldName(item.field)))
      imports.add(dtos ? qualified(context, info, 'dtos', names.source) : qualified(context, info, 'entity', info.entity))
      if (body.uow) imports.add(`${context.base}.UnitOfWork`)
      const params = `${names.source} row${body.uow ? ', UnitOfWork uow' : ''}`
      const { accessors, construction } = styleOf(models, model)
      let result: string[]
      if (construction === 'positional')
        result = [`        return new ${names.model}(`, ...argumentLines(values, '                '), '        );']
      else {
        // Built by its properties: the fields the plan does not give keep the model's defaults
        const set = values.filter((value) => given.has(value.name))
        const comment = (value: Value) => (value.todo ? ` // TODO: ${value.name}: ${value.todo}` : '')
        if (construction === 'builder')
          result = [
            `        return ${names.model}.builder()`,
            ...set.map((value) => `                .${value.name}(${value.expression})${comment(value)}`),
            '                .build();',
          ]
        else
          result = [
            `        ${names.model} model = new ${names.model}();`,
            ...set.map((value) =>
              accessors === 'fields'
                ? `        model.${value.name} = ${value.expression};${comment(value)}`
                : `        model.set${capitalized(value.name)}(${value.expression});${comment(value)}`,
            ),
            '        return model;',
          ]
      }
      methods.push([
        `    /** A row of the ${info.name} table as ${article(plan.model).split(' ')[0].toLowerCase()} ${plan.model}. */`,
        `    public static ${names.model} ${names.read}(${params}) {`,
        ...body.lines.map((line) => `        ${line}`),
        ...result,
        '    }',
      ])
    }
  }
  if (helpers.has('part')) imports.add('java.util.regex.Pattern')
  const helperBlocks = (['pair', 'part', 'rest'] as const)
    .filter((name) => helpers.has(name))
    .map((name) => HELPERS[name].map((line) => `    ${line}`))
  const name = conversionsClass(info)
  const written = imports.write()
  const content = lines(
    `package ${pkg};`,
    '',
    written !== '' && [written, ''],
    `/** Conversions between the application models and the "${info.name}" table: what the service takes and returns. */`,
    `public final class ${name} {`,
    `    private ${name}() {}`,
    ...[...methods, ...helperBlocks].flatMap((block) => ['', ...block]),
    '}',
    '',
  )
  return { path: javaPath(pkg, name), content }
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
  const pkg = context.base
  const imports = new JavaImports(pkg)
    .add('org.junit.jupiter.api.Test')
    .addStatic('org.junit.jupiter.api.Assertions.assertEquals', 'org.junit.jupiter.api.Assertions.assertNotNull')
  const memory = context.settings.memoryRepositories
  const caller = context.settings.transactions === 'caller'
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
    const conversions = `${conversionsPackage(context, info)}.${conversionsClass(info)}`
    imports.add(conversions, qualified(context, info, 'entity', info.entity))
    const row = dtos ? `${lowerFirst(names.source)}Of(row)` : 'row'
    if (dtos && !readers.has(info.name)) {
      imports.add(qualified(context, info, 'dtos', names.source))
      readers.set(info.name, [
        `    /** The row as the service returns it. */`,
        `    private static ${names.source} ${lowerFirst(names.source)}Of(${info.entity} entity) {`,
        `        return new ${names.source}(${readColumns(info)
          .map((column) => `entity.${column.getter}()`)
          .join(', ')});`,
        '    }',
      ])
    }
    const body = [
      `${info.entity} row = Factories.add${info.entity}(uow, 1);`,
      `var model = ${conversionsClass(info)}.${names.read}(${row}${reads ? ', uow' : ''});`,
      ...(writes
        ? [
            `var values = ${conversionsClass(info)}.${names.write}(model${writeUow ? ', uow' : ''});`,
            ...plan.write!.map((item) => {
              const column = columnOf(info, item.column)
              const given = dtos ? accessor(context, column.prop) : `${column.getter}()`
              return `assertEquals(row.${column.getter}(), values.${given});`
            }),
          ]
        : ['assertNotNull(model);']),
    ]
    const named = plan.model
    tests.push([
      '',
      '    @Test',
      `    void ${writes ? `reads${named}AndWritesItBack` : `reads${named}`}() {`,
      ...body.map((line) => `        ${line}`),
      '    }',
    ])
  }
  if (tests.length === 0) return null
  if (!memory) imports.add('jakarta.persistence.EntityManager', 'org.junit.jupiter.api.AfterEach', 'org.junit.jupiter.api.BeforeEach')
  const content = lines(
    `package ${pkg};`,
    '',
    imports.write(),
    '',
    '/** Tests of the conversions between the application models and the tables. */',
    'class ConversionsTest {',
    memory
      ? '    private final MemoryUnitOfWork uow = new MemoryUnitOfWork();'
      : [
          '    private EntityManager entityManager;',
          '    /** The repositories over the test database, opened empty for every test */',
          '    private SqlUnitOfWork uow;',
          '',
          '    @BeforeEach',
          '    void open() {',
          '        entityManager = TestDatabase.open();',
          caller && '        // The caller owns the transaction: the test opens it, and rolls it back at the end',
          caller && '        entityManager.getTransaction().begin();',
          '        uow = new SqlUnitOfWork(entityManager);',
          '    }',
          '',
          '    @AfterEach',
          '    void close() {',
          '        if (entityManager.getTransaction().isActive()) entityManager.getTransaction().rollback();',
          '        entityManager.close();',
          '    }',
        ],
    ...tests.flat(),
    ...[...readers.values()].flatMap((block) => ['', ...block]),
    '}',
    '',
  )
  return { path: javaPath(pkg, 'ConversionsTest', true), content }
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
