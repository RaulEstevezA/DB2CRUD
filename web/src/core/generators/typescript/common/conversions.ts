/**
 * The conversions between the application models and the tables (conversions/plan.ts), written in TypeScript: per
 * table, a function that turns a model into what the service takes (its create DTO, or the entity) and one that turns
 * what it returns into the model. Values are converted between the model's type and the column's (`number` and a
 * decimal kept as text, `Date` and text, `undefined` and `null`), so the project type-checks; lookups go through the
 * repositories of the unit of work; Mapper's transformations are plain expressions; what the plan leaves to the user
 * is a `// TODO:` with the reason.
 *
 * The models are imported as types only: copied into `src/application-models.ts`, or, with `modelsSource: 'import'`,
 * from the user's module (`settings.modelsModule`), declared for the project on its own in
 * `src/application-models.d.ts` (to delete inside the application).
 */
import {
  hasTodo,
  lossy,
  withoutHidden,
  type ConversionPlan,
  type ModelPath,
  type ReadValue,
  type Todo,
  type WriteValue,
} from '../../../conversions/plan.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import { fieldsOf } from '../../../matching/names.ts'
import { nestedFields } from '../../../schema/documents.ts'
import type { DbType } from '../../../schema/types.ts'
import type { MapperTransform } from '../../../interop/mapper/read.ts'
import type { EnumDef, FieldDef, ModelDef, ModelSchema, TypeRef } from '../../../model/schema.ts'
import { lines } from '../../types.ts'
import { memberName, TsImports, tsLiteral } from '../typescript.ts'
import { columnOf, findInfo, moduleOf, pathOf, query, queryName, tsType, type ColumnInfo, type Context, type TableInfo } from './context.ts'
import { createDto, readDto } from './dtos.ts'

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The property of a model field: its name, or its camelCase form when the name is not an identifier. */
export const fieldProp = (name: string) => (IDENTIFIER.test(name) ? name : memberName(name))

/** The module of the copy of the models in the project. */
export const COPY_MODULE = 'src/application-models'
/** The declaration that stands in for the user's module when the models are imported. */
export const DECLARATION_PATH = 'src/application-models.d.ts'

/** The module the conversions import the models from: the copy, or the user's (dots as slashes). */
export const modelsImport = (context: Context) =>
  context.settings.modelsSource === 'copy' ? COPY_MODULE : context.settings.modelsModule.replace(/\./g, '/')

const usesDtos = (context: Context, info: TableInfo) =>
  context.settings.services && context.settings.serviceTypes === 'dtos' && info.service !== null && info.role === 'entity'

/** The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them. */
export const servicePlans = (context: Context, plans: ConversionPlan[]) =>
  plans.map((plan) => {
    const info = findInfo(context, plan.table)
    return info && usesDtos(context, info) ? withoutHidden(plan, info.hidden) : plan
  })

/** The names of a plan: its functions, the types they take and return, and the name the model is imported as. */
export function conversionNames(context: Context, plan: ConversionPlan) {
  const info = findInfo(context, plan.table)!
  const dtos = usesDtos(context, info)
  const target = dtos ? createDto(info) : info.entity
  const source = dtos ? readDto(info) : info.entity
  const model = [info.entity, target, source].includes(plan.model) ? `${plan.model}Model` : plan.model
  const imported = model === plan.model ? plan.model : `${plan.model} as ${model}`
  const lower = model.charAt(0).toLowerCase() + model.slice(1)
  return {
    write: `${lower}To${target}`,
    read: `${source.charAt(0).toLowerCase()}${source.slice(1)}To${model}`,
    target,
    source,
    model,
    imported,
  }
}

/** Module of the conversions of a table, by architecture. */
export function conversionsModule(context: Context, info: TableInfo): string {
  return context.settings.architecture === 'table' ? `src/${info.file}/conversions` : `src/conversions/${info.file}`
}

// Types

/** The TypeScript type of a model field. */
function modelTs(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      switch (type.name) {
        case 'integer':
        case 'float':
        case 'decimal':
        case 'duration':
          return 'number'
        case 'boolean':
          return 'boolean'
        case 'datetime':
          return 'Date'
        case 'binary':
          return 'Buffer'
        case 'any':
          return 'unknown'
        default:
          return 'string'
      }
    case 'array':
      return `${modelTs(type.items)}[]`
    case 'map':
      return `Record<string, ${modelTs(type.value)}>`
    case 'model':
    case 'enum':
      return type.name
    case 'unknown':
      return 'unknown'
  }
}

const PLAIN = new Set(['string', 'number', 'boolean', 'Date', 'Buffer', 'unknown'])

/** A value of one type as another: numbers and text, dates and text; enums are text. */
function convert(expression: string, from: string, to: string): string {
  if (from === to || to === 'unknown') return expression
  if (!PLAIN.has(to)) return from === 'string' ? `(${expression} as ${to})` : expression
  if (!PLAIN.has(from)) return to === 'string' ? `String(${expression})` : expression
  if (to === 'string') return from === 'Date' ? `${expression}.toISOString()` : `String(${expression})`
  if (to === 'number') return `Number(${expression})`
  if (to === 'Date') return `new Date(${expression} as string | number)`
  return expression
}

/**
 * A value of a document as another type: also the items of a list, and what the driver gives without a type. Only
 * document databases use it: the other conversions keep lists and free values as they are.
 */
function convertDocument(expression: string, from: string, to: string): string {
  if (from === to || to === 'unknown') return expression
  if (from === 'unknown') return `(${expression} as ${to})`
  if (from.endsWith('[]') && to.endsWith('[]')) {
    const item = convertDocument('item', from.slice(0, -2), to.slice(0, -2))
    return item === 'item' ? expression : `${expression}.map((item) => ${item})`
  }
  return convert(expression, from, to)
}

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

/**
 * The copy of the application models the conversions use, as interfaces and string enums: a module of the project,
 * or the declaration of the user's module (`declare`) when they are imported.
 */
export function modelsFile(schema: ModelSchema, plans: ConversionPlan[], declared: string | null): GeneratedFile {
  const { models, enums } = closure(schema, [...new Set(plans.map((plan) => plan.model))])
  const blocks = [
    ...enums.map((item) =>
      lines(
        `export enum ${item.name} {`,
        ...item.values.map(
          (value) =>
            `  ${memberName(value.name).replace(/^./, (first) => first.toUpperCase())} = ${tsLiteral(String(value.value ?? value.name))},`,
        ),
        '}',
      ),
    ),
    ...models.map((model) =>
      lines(
        `/** ${model.name}, as the application has it. */`,
        `export interface ${model.name}${model.extends?.length ? ` extends ${model.extends.join(', ')}` : ''} {`,
        ...model.fields.map(
          (field) => `  ${fieldProp(field.name)}${field.optional ? '?' : ''}: ${modelTs(field.type)}${field.nullable ? ' | null' : ''}`,
        ),
        '}',
      ),
    ),
  ]
  if (declared === null)
    return {
      path: pathOf(COPY_MODULE),
      content: lines(
        '/** The application models the conversions use: a copy of the classes DB2CRUD read. */',
        ...blocks.flatMap((block) => ['', block]),
        '',
      ),
    }
  return {
    path: DECLARATION_PATH,
    content: lines(
      `/** The application models, as the project imports them from \`${declared}\`: a copy of the classes DB2CRUD read, so it type-checks on its own. Delete it inside the application. */`,
      `declare module '${declared}' {`,
      ...blocks.flatMap((block, index) => [...(index > 0 ? [''] : []), ...block.split('\n').map((line) => `  ${line}`)]),
      '}',
      '',
    ),
  }
}

// Expressions

/** `A Customer`, `An Order`. */
const article = (name: string) => `${/^[AEIOU]/i.test(name) ? 'An' : 'A'} ${name}`

const WHY: Record<Todo['reason'], string> = {
  pending: 'the matching waits for review',
  noField: 'no field of the model gives it',
  oneWay: "Mapper's relation only goes the other way",
  unsupported: 'DB2CRUD does not write this conversion',
  hidden: 'the service never returns it',
}
const todoComment = (todo: Todo, prop: string) => `// TODO: ${prop}: ${WHY[todo.reason]}${todo.detail ? ` (${todo.detail})` : ''}`

interface Typed {
  expression: string
  type: string
}

const INVERSE = { '*': '/', '/': '*', '+': '-', '-': '+' } as const

/** The transformation that undoes an invertible one. */
function inverse(transform: MapperTransform): MapperTransform {
  if (transform.kind === 'arithmetic') return { ...transform, operator: INVERSE[transform.operator] }
  if (transform.kind === 'enum') return { kind: 'enum', pairs: transform.pairs.map((pair) => ({ from: pair.to, to: pair.from })) }
  return transform
}

interface Body {
  lines: string[]
  uow: boolean
  /** It uses the helper that maps enum values */
  pairs: boolean
}

// Nested documents

const isDocuments = (context: Context) => context.settings.database === 'mongodb'

/** What a nested document is converted with: the functions written so far, and the types the file names. */
interface Nested {
  context: Context
  info: TableInfo
  schema: ModelSchema
  plan: ConversionPlan
  imports: TsImports
  functions: string[]
}

const upperFirst = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`
const propAccess = (root: string, name: string) => (IDENTIFIER.test(name) ? `${root}.${name}` : `${root}[${tsLiteral(name)}]`)
const propKey = (name: string) => (IDENTIFIER.test(name) ? name : tsLiteral(name))

/** The type of a nested document, from that of the column or document that holds it. */
const insideOf = (type: string, many: boolean) => (many ? `NonNullable<${type}>[number]` : `NonNullable<${type}>`)

/** The name a nested model is imported as. */
function nestedModel(nested: Nested, name: string): string {
  const taken = conversionNames(nested.context, nested.plan)
  const local = [nested.info.entity, taken.target, taken.source].includes(name) ? `${name}Model` : name
  nested.imports.type(modelsImport(nested.context), local === name ? name : `${name} as ${local}`)
  return local
}

const modelFields = (nested: Nested, name: string): FieldDef[] => {
  const model = nested.schema.models.find((item) => item.name === name)
  return model ? fieldsOf(model, nested.schema) : []
}

/** The call that converts a nested document or a list of them. */
const callFor = (name: string, many: boolean, expression: string) => (many ? `${expression}.map(${name})` : `${name}(${expression})`)

/** A value that may be missing, converted when it is there; `otherwise` is what a missing one is. */
const whenPresent = (expression: string, converted: string, missing: boolean, otherwise: string) =>
  !missing ? converted : converted === expression ? `${expression} ?? ${otherwise}` : `${expression} == null ? ${otherwise} : ${converted}`

/** Writes the function that gives a nested document from its model, and those inside it; gives its name. */
function writeDocument(nested: Nested, value: WriteValue & { kind: 'document' }, kept: DbType, type: string, path: string): string {
  const name = `${nested.plan.model.charAt(0).toLowerCase()}${nested.plan.model.slice(1)}${path}ToDocument`
  const fields = modelFields(nested, value.model)
  const result = insideOf(type, value.many)
  const props = value.values.flatMap((item): string[] => {
    const column = nestedFields(kept)!.find((candidate) => candidate.name === item.column)!
    const key = propKey(column.name)
    if (item.value.kind === 'todo') return [todoComment(item.value, key), `${key}: undefined as never,`]
    if (item.value.kind !== 'field' && item.value.kind !== 'document') return []
    const found = item.value.path[0]
    const field = fields.find((candidate) => candidate.name === found)!
    const read = propAccess('value', fieldProp(field.name))
    const missing = field.optional || field.nullable
    if (item.value.kind === 'document') {
      const inner = writeDocument(
        nested,
        item.value,
        column.type,
        `${result}[${tsLiteral(column.name)}]`,
        path + upperFirst(memberName(column.name)),
      )
      return [
        `${key}: ${whenPresent(read, callFor(inner, item.value.many, read), missing, column.nullable ? 'undefined' : 'undefined as never')},`,
      ]
    }
    const converted = convertDocument(read, modelTs(field.type), tsType(column.type))
    return [`${key}: ${whenPresent(read, converted, missing, column.nullable ? 'undefined' : 'undefined as never')},`]
  })
  nested.functions.push(
    lines(
      `/** ${article(value.model)} as the documents of the ${nested.info.name} collection keep it. */`,
      `function ${name}(value: ${nestedModel(nested, value.model)}): ${result} {`,
      value.unused.length > 0 && `  // Not stored: ${value.unused.join(', ')}`,
      '  return {',
      ...props.map((prop) => `    ${prop}`),
      '  }',
      '}',
    ),
  )
  return name
}

/** A missing value of a document, as a field of a model has it. */
const absent = (field: FieldDef) =>
  field.nullable ? 'null' : field.optional ? 'undefined' : field.type.kind === 'array' ? '[]' : 'undefined as never'

/** Writes the function that gives a model from its nested document, and those inside it; gives its name. */
function readDocument(nested: Nested, value: ReadValue & { kind: 'document' }, kept: DbType, type: string, path: string): string {
  const name = `${nested.plan.model.charAt(0).toLowerCase()}${nested.plan.model.slice(1)}${path}FromDocument`
  const fields = modelFields(nested, value.model)
  const source = insideOf(type, value.many)
  const props = value.values.flatMap((item): string[] => {
    const field = fields.find((candidate) => candidate.name === item.field)!
    const key = fieldProp(field.name)
    if (item.value.kind === 'todo') return [todoComment(item.value, key), `${key}: undefined as never,`]
    if (item.value.kind !== 'column' && item.value.kind !== 'document') return []
    const from = item.value.column
    const column = nestedFields(kept)!.find((candidate) => candidate.name === from)!
    const read = propAccess('value', column.name)
    const converted =
      item.value.kind === 'document'
        ? callFor(
            readDocument(
              nested,
              item.value,
              column.type,
              `${source}[${tsLiteral(column.name)}]`,
              path + upperFirst(memberName(column.name)),
            ),
            item.value.many,
            read,
          )
        : fromDocument(nested, field, read, tsType(column.type))
    // The type of a document says a field with a default may be missing too
    return [`${key}: ${whenPresent(read, converted, column.nullable || column.default !== undefined, absent(field))},`]
  })
  nested.functions.push(
    lines(
      `/** A document of the ${nested.info.name} collection as ${article(value.model).split(' ')[0].toLowerCase()} ${value.model}. */`,
      `function ${name}(value: ${source}): ${nestedModel(nested, value.model)} {`,
      '  return {',
      ...props.map((prop) => `    ${prop}`),
      '  }',
      '}',
    ),
  )
  return name
}

/** A value of a document as a field of a model has it. */
function fromDocument(nested: Nested, field: FieldDef, expression: string, type: string): string {
  for (const item of typesOf(field.type)) nested.imports.type(modelsImport(nested.context), item)
  return convertDocument(expression, type, modelTs(field.type))
}

/** The enums and models a type names. */
function typesOf(type: TypeRef): string[] {
  if (type.kind === 'array') return typesOf(type.items)
  if (type.kind === 'map') return typesOf(type.value)
  return type.kind === 'enum' || type.kind === 'model' ? [type.name] : []
}

/** The value of a column that holds documents, written from the model. */
function writeColumn(nested: Nested, column: ColumnInfo, value: WriteValue & { kind: 'document' }, field: FieldDef | undefined): string {
  const name = writeDocument(nested, value, column.column.type, `${nested.info.entity}['${column.prop}']`, upperFirst(column.prop))
  nested.imports.type(moduleOf(nested.context, nested.info, 'entity'), nested.info.entity)
  const read = ['model', ...value.path.map(fieldProp)].join('.')
  return whenPresent(
    read,
    callFor(name, value.many, read),
    !field || field.optional || field.nullable,
    column.column.nullable ? 'null' : 'undefined as never',
  )
}

/** The value of a field that holds documents, read from a row. */
function readColumn(nested: Nested, column: ColumnInfo, value: ReadValue & { kind: 'document' }, field: FieldDef): string {
  const name = readDocument(nested, value, column.column.type, `${nested.info.entity}['${column.prop}']`, upperFirst(column.prop))
  nested.imports.type(moduleOf(nested.context, nested.info, 'entity'), nested.info.entity)
  const read = `row.${column.prop}`
  return whenPresent(read, callFor(name, value.many, read), column.column.nullable, absent(field))
}

/** A Mapper transformation of typed values, as an expression of the type it gives. */
function transformed(transform: MapperTransform, values: Typed[], target: string, body: Body): Typed {
  const value = values[0]
  switch (transform.kind) {
    case 'direct':
      return value
    case 'concat':
      return {
        expression: `[${values.map((item) => item.expression).join(', ')}].map(String).join(${tsLiteral(transform.separator)})`,
        type: 'string',
      }
    case 'split': {
      const parts = `String(${value.expression}).split(${tsLiteral(transform.separator)})`
      if (transform.part === 'last') return { expression: `(${parts}.at(-1) ?? '')`, type: 'string' }
      if (transform.part === 'rest') return { expression: `${parts}.slice(1).join(${tsLiteral(transform.separator)})`, type: 'string' }
      return { expression: `(${parts}[${transform.part}] ?? '')`, type: 'string' }
    }
    case 'constant':
      return { expression: tsLiteral(transform.value), type: transform.value === null ? 'unknown' : typeof transform.value }
    case 'boolean':
      return {
        expression: `[${transform.trueValues.map((item) => tsLiteral(item)).join(', ')}].includes(String(${value.expression}))`,
        type: 'boolean',
      }
    case 'enum': {
      body.pairs = true
      const pairs = transform.pairs.map((pair) => `${tsLiteral(pair.from)}: ${tsLiteral(pair.to)}`).join(', ')
      const fallback = transform.fallback !== undefined ? `, ${tsLiteral(transform.fallback)}` : ''
      return { expression: `pair({ ${pairs} }, ${value.expression}${fallback})`, type: 'string' }
    }
    case 'epoch': {
      const scale = transform.unit === 'milliseconds' ? '' : ' / 1000'
      if (target === 'number' || target === 'string')
        return { expression: `Math.round(${convert(value.expression, value.type, 'Date')}.getTime()${scale})`, type: 'number' }
      return { expression: `new Date(Number(${value.expression})${transform.unit === 'milliseconds' ? '' : ' * 1000'})`, type: 'Date' }
    }
    case 'arithmetic':
      return { expression: `(Number(${value.expression}) ${transform.operator} ${tsLiteral(transform.operand)})`, type: 'number' }
    default:
      return { expression: 'undefined', type: 'unknown' }
  }
}

/** The value of a column written from the model, with the statements it needs before. */
function writeExpression(
  context: Context,
  column: ColumnInfo,
  value: Exclude<WriteValue, Todo>,
  model: ModelDef | undefined,
  body: Body,
  imports: TsImports,
  nested: Nested,
): string | null {
  const documents = isDocuments(context)
  const field = (path: ModelPath) => model?.fields.find((item) => item.name === path[0])
  const typed = (path: ModelPath): Typed => {
    const found = field(path)
    return { expression: ['model', ...path.map(fieldProp)].join('.'), type: found && path.length === 1 ? modelTs(found.type) : 'unknown' }
  }
  const integer = column.column.type.kind === 'integer'
  const finish = (result: Typed, path?: ModelPath) => {
    const converted = (documents ? convertDocument : convert)(
      integer && result.type === 'number' && /[*/]/.test(result.expression) ? `Math.round(${result.expression})` : result.expression,
      result.type,
      column.ts,
    )
    const found = path ? field(path) : undefined
    // A field the model may leave out is null in the column
    if (found && (found.optional || found.nullable))
      return converted === result.expression ? `${result.expression} ?? null` : `${result.expression} == null ? null : ${converted}`
    return converted
  }
  switch (value.kind) {
    case 'document':
      return writeColumn(nested, column, value, field(value.path))
    case 'field':
      return finish(typed(value.path), value.path)
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && query(other, 'findByUnique', [value.by])
      if (!other || !finder) return null
      const name = memberName(other.entity)
      const given = typed(value.path)
      imports.from('src/errors', 'NotFoundError')
      body.uow = true
      body.lines.push(
        `const ${name} = await uow.${other.attr}.${queryName(context, finder)}(${convert(given.expression, given.type, columnOf(other, value.by).ts)})`,
        `if (!${name}) throw new NotFoundError(${tsLiteral(other.entity)}, ${given.expression})`,
      )
      return `${name}.${columnOf(other, value.key).prop}`
    }
    case 'mapper':
      return finish(transformed(value.transform, value.sources.map(typed), column.ts, body))
    case 'inverse':
      return finish(transformed(inverse(value.transform), [typed(value.path)], column.ts, body), value.path)
  }
}

function readExpression(
  context: Context,
  info: TableInfo,
  field: FieldDef | undefined,
  value: Exclude<ReadValue, Todo>,
  body: Body,
  imports: TsImports,
  nested: Nested,
): string | null {
  const target = field ? modelTs(field.type) : 'unknown'
  // An enum or a model of the application the value is cast to
  if (field && (field.type.kind === 'enum' || field.type.kind === 'model')) imports.type(modelsImport(context), target)
  const typed = (name: string): Typed => ({ expression: `row.${columnOf(info, name).prop}`, type: columnOf(info, name).ts })
  // A column that may be null into a field that may only be missing: undefined in the model
  const fit = (expression: string, nullable: boolean, converted: string) => {
    if (!nullable) return converted
    const body = converted === expression ? expression : `${expression} == null ? null : ${converted}`
    return field?.nullable ? body : `${body === expression ? expression : `(${body})`} ?? undefined`
  }
  switch (value.kind) {
    case 'document':
      return field ? readColumn(nested, columnOf(info, value.column), value, field) : null
    case 'column': {
      const source = typed(value.column)
      if (isDocuments(context) && field) {
        const converted = fromDocument(nested, field, source.expression, source.type)
        return whenPresent(source.expression, converted, columnOf(info, value.column).column.nullable, absent(field))
      }
      return fit(source.expression, columnOf(info, value.column).column.nullable, convert(source.expression, source.type, target))
    }
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && (query(other, 'getByKey') ?? query(other, 'findByUnique', [value.key]))
      if (!other || !finder) return null
      const name = memberName(other.entity)
      const nullable = columnOf(info, value.column).column.nullable
      body.uow = true
      body.lines.push(
        `const ${name} = ${nullable ? `row.${columnOf(info, value.column).prop} == null ? undefined : ` : ''}await uow.${other.attr}.${queryName(context, finder)}(row.${columnOf(info, value.column).prop})`,
      )
      const by = `${name}${nullable ? '?' : '!'}.${columnOf(other, value.by).prop}`
      return nullable ? `${by} ?? undefined` : convert(by, columnOf(other, value.by).ts, target)
    }
    case 'children': {
      const other = findInfo(context, value.table)
      const lister = other && (query(other, 'listByParent', [value.by]) ?? query(other, 'findAllBy', [value.by]))
      if (!other || !lister) return null
      body.uow = true
      return `(await uow.${other.attr}.${queryName(context, lister)}(row.${columnOf(info, value.key).prop})).map((item) => item.${columnOf(other, value.value).prop})`
    }
    case 'mapper': {
      const result = transformed(value.transform, value.columns.map(typed), target, body)
      return convert(result.expression, result.type, target)
    }
    case 'inverse': {
      const result = transformed(inverse(value.transform), [typed(value.column)], target, body)
      return convert(result.expression, result.type, target)
    }
  }
}

/** The file of the conversions of one table: one function per direction its models go. */
export function conversionFile(context: Context, plans: ConversionPlan[], schema: ModelSchema): GeneratedFile | null {
  const info = findInfo(context, plans[0].table)
  if (!info) return null
  const module = conversionsModule(context, info)
  const imports = new TsImports(module)
  const functions: string[] = []
  let pairs = false
  for (const plan of plans) {
    const nested: Nested = { context, info, schema, plan, imports, functions }
    const model = schema.models.find((item) => item.name === plan.model)
    const names = conversionNames(context, plan)
    const dtos = usesDtos(context, info)
    imports.type(modelsImport(context), names.imported)
    if (plan.write) {
      const body: Body = { lines: [], uow: false, pairs: false }
      const props: string[] = []
      for (const item of plan.write) {
        const column = columnOf(info, item.column)
        if (item.value.kind === 'todo') {
          // The comment stays, and the property keeps the project type-checking until it is filled
          props.push(todoComment(item.value, column.prop), `${column.prop}: undefined as never,`)
          continue
        }
        const expression = writeExpression(context, column, item.value, model, body, imports, nested)
        props.push(
          expression === null
            ? `${column.prop}: undefined as never, // TODO: no repository query finds the row it names`
            : `${column.prop}: ${expression},`,
        )
      }
      pairs ||= body.pairs
      if (body.uow) imports.type('src/unit-of-work', 'UnitOfWork')
      if (dtos) imports.type(moduleOf(context, info, 'dtos'), names.target)
      else imports.from(moduleOf(context, info, 'entity'), info.entity)
      const result = dtos
        ? ['  return {', ...props.map((prop) => `    ${prop}`), '  }']
        : [`  return Object.assign(new ${info.entity}(), {`, ...props.map((prop) => `    ${prop}`), '  })']
      functions.push(
        lines(
          `/** ${article(plan.model)} as the ${info.name} table takes it. */`,
          body.uow
            ? `export async function ${names.write}(model: ${names.model}, uow: UnitOfWork): Promise<${names.target}> {`
            : `export function ${names.write}(model: ${names.model}): ${names.target} {`,
          ...body.lines.map((line) => `  ${line}`),
          ...result,
          '}',
        ),
      )
    }
    if (plan.read) {
      const body: Body = { lines: [], uow: false, pairs: false }
      const props: string[] = []
      for (const item of plan.read) {
        const field = model?.fields.find((candidate) => candidate.name === item.field)
        const prop = fieldProp(item.field)
        if (item.value.kind === 'todo') {
          props.push(todoComment(item.value, prop), `${prop}: undefined as never,`)
          continue
        }
        const expression = readExpression(context, info, field, item.value, body, imports, nested)
        props.push(expression === null ? `${prop}: undefined as never, // TODO: no repository query reads it` : `${prop}: ${expression},`)
      }
      pairs ||= body.pairs
      if (body.uow) imports.type('src/unit-of-work', 'UnitOfWork')
      imports.type(dtos ? moduleOf(context, info, 'dtos') : moduleOf(context, info, 'entity'), names.source)
      functions.push(
        lines(
          `/** A row of the ${info.name} table as ${article(plan.model).split(' ')[0].toLowerCase()} ${plan.model}. */`,
          body.uow
            ? `export async function ${names.read}(row: ${names.source}, uow: UnitOfWork): Promise<${names.model}> {`
            : `export function ${names.read}(row: ${names.source}): ${names.model} {`,
          ...body.lines.map((line) => `  ${line}`),
          '  return {',
          ...props.map((prop) => `    ${prop}`),
          '  }',
          '}',
        ),
      )
    }
  }
  const helper = pairs
    ? [
        '',
        '/** The value an enum pair gives, or the fallback; a value without a pair is an error. */',
        'function pair(pairs: Record<string, string>, value: unknown, fallback?: string): string {',
        '  const found = pairs[String(value)] ?? fallback',
        '  if (found === undefined) throw new Error(`No pair for ${String(value)}`)',
        '  return found',
        '}',
      ]
    : []
  const content = lines(
    `/** Conversions between the application models and the "${info.name}" table: what the service takes and returns. */`,
    imports.write(),
    ...helper,
    ...functions.flatMap((block) => ['', block]),
    '',
  )
  return { path: pathOf(module), content }
}

/**
 * The tests of the conversions: a row stored by the factories is read as the model, and a model that goes both ways
 * and leaves nothing to the user is written back, giving every value of the row (lookups and Mapper's lossless
 * transformations included).
 */
export function conversionTestFile(
  context: Context,
  plans: ConversionPlan[],
  schema: ModelSchema | null,
  canMake: (info: TableInfo) => boolean,
): GeneratedFile | null {
  const module = 'test/conversions.test'
  const imports = new TsImports(module).from('vitest', 'describe', 'expect', 'it')
  const memory = context.settings.memoryRepositories
  const tests: string[] = []
  for (const plan of plans) {
    const info = findInfo(context, plan.table)
    if (!info || !plan.read || hasTodo(plan.read) || !canMake(info)) continue
    const names = conversionNames(context, plan)
    const reads = plan.read.some((item) => ['lookup', 'children'].includes(item.value.kind))
    const writes = plan.write !== null && !hasTodo(plan.write)
    const writeUow = writes && plan.write!.some((item) => item.value.kind === 'lookup')
    imports.from(conversionsModule(context, info), names.read, ...(writes ? [names.write] : []))
    imports.from('test/factories', `add${info.entity}`)
    const model = schema?.models.find((item) => item.name === plan.model)
    // A value the model keeps with less detail is not written back as it was
    const changes = (item: { column: string; value: WriteValue }) =>
      isDocuments(context) && model && schema && lossy(item.value, columnOf(info, item.column).column.type, fieldsOf(model, schema), schema)
    const body = [
      memory ? 'const uow = new MemoryUnitOfWork()' : 'const uow = sqlUow()',
      `const row = await add${info.entity}(uow)`,
      `const model = ${reads ? 'await ' : ''}${names.read}(row${reads ? ', uow' : ''})`,
      ...(writes
        ? [
            `const values = ${writeUow ? 'await ' : ''}${names.write}(model${writeUow ? ', uow' : ''})`,
            ...plan
              .write!.filter((item) => !changes(item))
              .map((item) => `expect(values.${columnOf(info, item.column).prop}).toEqual(row.${columnOf(info, item.column).prop})`),
          ]
        : ['expect(model).toBeDefined()']),
    ]
    const named = article(plan.model).replace(/^A/, 'a')
    tests.push(
      lines(
        `  it('${writes ? `reads a row as ${named} and writes it back` : `reads a row as ${named}`}', async () => {`,
        ...body.map((line) => `    ${line}`),
        '  })',
      ),
    )
  }
  if (tests.length === 0) return null
  if (memory) imports.from('src/unit-of-work', 'MemoryUnitOfWork')
  else imports.from('test/database', 'useTestDatabase')
  const content = lines(
    '/** Tests of the conversions between the application models and the tables. */',
    imports.write(),
    !memory && ['', '/** The repositories over the test database, opened empty for every test */', 'const sqlUow = useTestDatabase()'],
    '',
    "describe('conversions', () => {",
    ...tests.flatMap((test, index) => (index === 0 ? [test] : ['', test])),
    '})',
    '',
  )
  return { path: `${module}.ts`, content }
}

/** The conversion files of a project and, when they are copied, the module of the models. */
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
  files.push(modelsFile(schema, plans, context.settings.modelsSource === 'copy' ? null : modelsImport(context)))
  return files
}
