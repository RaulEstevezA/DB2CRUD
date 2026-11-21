/**
 * The conversions between the application models and the tables (conversions/plan.ts), written in Python: per table,
 * a function that turns a model into what the service takes (its create DTO, or the entity) and one that turns what
 * it returns into the model. Lookups go through the repositories of the unit of work; Mapper's transformations are
 * written as plain expressions; what the plan leaves to the user is a `# TODO:` with the reason.
 *
 * The model classes are imported from `settings.modelsModule`; with `modelsSource: 'copy'` that module is written
 * into the project (`modelsFile`) as dataclasses, so the project runs on its own.
 */
import {
  withoutHidden,
  type ConversionPlan,
  type ModelPath,
  type ReadValue,
  type Todo,
  type WriteValue,
} from '../../../conversions/plan.ts'
import type { MapperTransform } from '../../../interop/mapper/read.ts'
import type { EnumDef, FieldDef, ModelDef, ModelSchema, TypeRef } from '../../../model/schema.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { Imports, pyLiteral, snakeName } from '../python.ts'
import { createDto, readDto } from './dtos.ts'
import { aw, def, findInfo, moduleOf, pathOf, query, queryName, type Context, type TableInfo } from './context.ts'
import { canMake } from './tests.ts'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The attribute of a model field: its name, or its snake form when the name is not an identifier. */
export const fieldAttr = (name: string) => (IDENTIFIER.test(name) ? name : snakeName(name))

/**
 * The Python names of a plan: its functions, the classes they take and return, and the name the model is imported
 * as (`ProductModel` when the model is named like the entity or a DTO it is converted to).
 */
export function conversionNames(
  context: Context,
  plan: ConversionPlan,
): { write: string; read: string; target: string; source: string; model: string; imported: string } {
  const info = findInfo(context, plan.table)!
  const dtos = usesDtos(context, info)
  const target = dtos ? createDto(info) : info.entity
  const source = dtos ? readDto(info) : info.entity
  const taken = [info.entity, target, source]
  const model = taken.includes(plan.model) ? `${plan.model}Model` : plan.model
  const imported = model === plan.model ? plan.model : `${plan.model} as ${model}`
  const snake = snakeName(model)
  return { write: `${snake}_to_${snakeName(target)}`, read: `${snakeName(source)}_to_${snake}`, target, source, model, imported }
}

const usesDtos = (context: Context, info: TableInfo) =>
  context.settings.services && context.settings.serviceTypes === 'dtos' && info.service !== null && info.role === 'entity'

/** The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them. */
export const servicePlans = (context: Context, plans: ConversionPlan[]) =>
  plans.map((plan) => {
    const info = findInfo(context, plan.table)
    return info && usesDtos(context, info) ? withoutHidden(plan, info.hidden) : plan
  })

/** Module of the conversions of a table, by architecture. */
export function conversionsModule(context: Context, info: TableInfo): string {
  return context.settings.architecture === 'table' ? `app.${info.module}.conversions` : `app.conversions.${info.module}`
}

// Types of the models

function modelType(type: TypeRef, imports: Imports): string {
  switch (type.kind) {
    case 'primitive':
      switch (type.name) {
        case 'string':
          return 'str'
        case 'integer':
          return 'int'
        case 'float':
          return 'float'
        case 'decimal':
          imports.from('decimal', 'Decimal')
          return 'Decimal'
        case 'boolean':
          return 'bool'
        case 'date':
          imports.from('datetime', 'date')
          return 'date'
        case 'datetime':
          imports.from('datetime', 'datetime')
          return 'datetime'
        case 'time':
          imports.from('datetime', 'time')
          return 'time'
        case 'duration':
          imports.from('datetime', 'timedelta')
          return 'timedelta'
        case 'uuid':
          imports.from('uuid', 'UUID')
          return 'UUID'
        case 'binary':
          return 'bytes'
        default:
          imports.from('typing', 'Any')
          return 'Any'
      }
    case 'array':
      return `list[${modelType(type.items, imports)}]`
    case 'map':
      return `dict[${modelType(type.key, imports)}, ${modelType(type.value, imports)}]`
    case 'model':
    case 'enum':
      return type.name
    case 'unknown':
      imports.from('typing', 'Any')
      return 'Any'
  }
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
  return {
    models: schema.models.filter((model) => models.has(model.name)),
    enums: schema.enums.filter((item) => enums.has(item.name)),
  }
}

/**
 * The copy of the application models the conversions use, as dataclasses: at `settings.modelsModule`, or, when they
 * are imported from the user's module, at `tests/application_models.py` for the tests only.
 */
export function modelsFile(schema: ModelSchema, plans: ConversionPlan[], path: string): GeneratedFile {
  const imports = new Imports().annotations()
  const { models, enums } = closure(schema, [...new Set(plans.map((plan) => plan.model))])
  if (models.length > 0) imports.from('dataclasses', 'dataclass')
  if (enums.length > 0) imports.from('enum', 'Enum')
  const field = (item: FieldDef) => {
    const type = modelType(item.type, imports)
    const optional = item.optional || item.nullable
    return `    ${fieldAttr(item.name)}: ${type}${optional ? ' | None = None' : ''}`
  }
  const enumBlocks = enums.map((item) =>
    lines(
      `class ${item.name}(str, Enum):`,
      ...item.values.map((value) => `    ${fieldAttr(value.name).toUpperCase()} = ${pyLiteral(String(value.value ?? value.name))}`),
    ),
  )
  const modelBlocks = models.map((model) => {
    const fields = model.fields.map(field)
    // Fields without a default first: a dataclass refuses them after one with a default
    const ordered = [...fields.filter((item) => !item.includes(' = ')), ...fields.filter((item) => item.includes(' = '))]
    const bases = model.extends?.length ? `(${model.extends.join(', ')})` : ''
    return lines(
      '@dataclass(kw_only=True)',
      `class ${model.name}${bases}:`,
      `    """${model.name}, as the application has it."""`,
      ...(ordered.length > 0 ? ['', ...ordered] : ['    pass']),
    )
  })
  const content = lines(
    '"""The application models the conversions use: a copy of the classes DB2CRUD read."""',
    '',
    imports.write('app'),
    ...[...enumBlocks, ...modelBlocks].flatMap((block) => ['', '', block]),
    '',
  )
  return { path, content }
}

/**
 * `tests/__init__.py` when the models are imported: without the user's module (the project on its own), the tests
 * take the copy in its place, so they run anywhere and use the real classes inside the application.
 */
export function testsPackage(context: Context): GeneratedFile {
  const module = pyLiteral(context.settings.modelsModule)
  const content = lines(
    '"""The tests. The application models come from your module; without it, they are the copy DB2CRUD read."""',
    '',
    'import importlib',
    'import sys',
    '',
    'try:',
    `    importlib.import_module(${module})`,
    'except ModuleNotFoundError:',
    `    sys.modules[${module}] = importlib.import_module("tests.application_models")`,
    '',
  )
  return { path: 'tests/__init__.py', content }
}

// Expressions

/** `A Customer`, `An Order`. */
const article = (name: string) => `${/^[AEIOU]/i.test(name) ? 'An' : 'A'} ${name}`

const access = (root: string, path: ModelPath) => [root, ...path.map(fieldAttr)].join('.')

const todoComment = (todo: Todo, attr: string) => {
  const why: Record<Todo['reason'], string> = {
    pending: 'the matching waits for review',
    noField: 'no field of the model gives it',
    oneWay: "Mapper's relation only goes the other way",
    unsupported: 'DB2CRUD does not write this conversion',
    hidden: 'the service never returns it',
  }
  return `# TODO: ${attr}: ${why[todo.reason]}${todo.detail ? ` (${todo.detail})` : ''}`
}

/** `Enum` members are written by their value. */
const plain = (value: string) => `_plain(${value})`

/** A Mapper transformation of the given values (`forward`), or its inverse of one value. */
function transformed(transform: MapperTransform, values: string[], toInteger: boolean, imports: Imports): string {
  const value = values[0]
  switch (transform.kind) {
    case 'direct':
      return value
    case 'concat':
      return `${pyLiteral(transform.separator)}.join(str(part) for part in (${values.join(', ')}))`
    case 'split': {
      const parts = `str(${value}).split(${pyLiteral(transform.separator)}${transform.part === 'rest' ? ', 1' : ''})`
      if (transform.part === 'last') return `${parts}[-1]`
      if (transform.part === 'rest') return `(${parts} + [""])[1]`
      return `(${parts} + [""] * ${transform.part + 1})[${transform.part}]`
    }
    case 'constant':
      return pyLiteral(transform.value)
    case 'boolean':
      return `${plain(value)} in (${transform.trueValues.map((item) => pyLiteral(item)).join(', ')}${transform.trueValues.length === 1 ? ',' : ''})`
    case 'enum': {
      const pairs = transform.pairs.map((pair) => `${pyLiteral(pair.from)}: ${pyLiteral(pair.to)}`).join(', ')
      return transform.fallback !== undefined
        ? `{${pairs}}.get(${plain(value)}, ${pyLiteral(transform.fallback)})`
        : `{${pairs}}[${plain(value)}]`
    }
    case 'epoch': {
      // From a number: a date and time; from a date and time: a number
      imports.from('datetime', 'datetime', 'timezone')
      const divisor = transform.unit === 'milliseconds' ? ' / 1000' : ''
      return toInteger
        ? `int(${value}.timestamp()${transform.unit === 'milliseconds' ? ' * 1000' : ''})`
        : `datetime.fromtimestamp(${value}${divisor}, tz=timezone.utc)`
    }
    case 'arithmetic': {
      const result = `${value} ${transform.operator} ${pyLiteral(transform.operand)}`
      return toInteger ? `round(${result})` : result
    }
    default:
      return 'None'
  }
}

const INVERSE: Record<'*' | '/' | '+' | '-', '*' | '/' | '+' | '-'> = { '*': '/', '/': '*', '+': '-', '-': '+' }

/** The transformation that undoes an invertible one. */
function inverse(transform: MapperTransform): MapperTransform {
  if (transform.kind === 'arithmetic') return { ...transform, operator: INVERSE[transform.operator] }
  if (transform.kind === 'enum') return { kind: 'enum', pairs: transform.pairs.map((pair) => ({ from: pair.to, to: pair.from })) }
  return transform
}

interface Body {
  lines: string[]
  /** It reads through the unit of work */
  uow: boolean
}

/** The statements before the result, and the value of a column written from the model. */
function writeExpression(
  context: Context,
  info: TableInfo,
  column: string,
  value: Exclude<WriteValue, Todo>,
  body: Body,
  imports: Imports,
): string | null {
  const columnInfo = info.columns.find((item) => item.column.name === column)
  const toInteger = columnInfo?.column.type.kind === 'integer'
  switch (value.kind) {
    case 'field':
      return access('model', value.path)
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && query(other, 'findByUnique', [value.by])
      if (!other || !finder) return null
      const name = other.module
      const given = access('model', value.path)
      imports.from('app.errors', 'NotFoundError')
      body.uow = true
      body.lines.push(
        `${name} = ${aw(context)}uow.${other.attr}.${queryName(context, finder)}(${given})`,
        `if ${name} is None:`,
        `    raise NotFoundError(${pyLiteral(other.entity)}, ${given})`,
      )
      const key = other.columns.find((item) => item.column.name === value.key)
      return `${name}.${key?.attr ?? value.key}`
    }
    case 'mapper':
      return transformed(
        value.transform,
        value.sources.map((path) => access('model', path)),
        toInteger,
        imports,
      )
    case 'inverse':
      return transformed(inverse(value.transform), [access('model', value.path)], toInteger, imports)
  }
}

function readExpression(
  context: Context,
  info: TableInfo,
  field: FieldDef | undefined,
  value: Exclude<ReadValue, Todo>,
  body: Body,
  imports: Imports,
): string | null {
  const attr = (column: string) => info.columns.find((item) => item.column.name === column)?.attr ?? column
  const toInteger = field?.type.kind === 'primitive' && field.type.name === 'integer'
  const enumOf = (expression: string) => {
    if (field?.type.kind !== 'enum') return expression
    imports.from(context.settings.modelsModule, field.type.name)
    return `${field.type.name}(${expression})`
  }
  switch (value.kind) {
    case 'column':
      return `row.${attr(value.column)}`
    case 'lookup': {
      const other = findInfo(context, value.table)
      const finder = other && (query(other, 'getByKey') ?? query(other, 'findByUnique', [value.key]))
      if (!other || !finder) return null
      const name = other.module
      body.uow = true
      body.lines.push(`${name} = ${aw(context)}uow.${other.attr}.${queryName(context, finder)}(row.${attr(value.column)})`)
      const by = other.columns.find((item) => item.column.name === value.by)
      return `${name}.${by?.attr ?? value.by} if ${name} is not None else None`
    }
    case 'children': {
      const other = findInfo(context, value.table)
      const lister = other && (query(other, 'listByParent', [value.by]) ?? query(other, 'findAllBy', [value.by]))
      if (!other || !lister) return null
      body.uow = true
      const item = other.columns.find((column) => column.column.name === value.value)
      return `[item.${item?.attr ?? value.value} for item in ${aw(context)}uow.${other.attr}.${queryName(context, lister)}(row.${attr(value.key)})]`
    }
    case 'mapper':
      return enumOf(
        transformed(
          value.transform,
          value.columns.map((column) => `row.${attr(column)}`),
          toInteger,
          imports,
        ),
      )
    case 'inverse':
      return enumOf(transformed(inverse(value.transform), [`row.${attr(value.column)}`], toInteger, imports))
  }
}

/** The file of the conversions of one table: one function per direction its models go. */
export function conversionFile(context: Context, plans: ConversionPlan[], schema: ModelSchema): GeneratedFile | null {
  const info = findInfo(context, plans[0].table)
  if (!info) return null
  const imports = new Imports().annotations()
  const functions: string[] = []
  let usesUow = false
  let usesPlain = false
  for (const plan of plans) {
    const model = schema.models.find((item) => item.name === plan.model)
    const names = conversionNames(context, plan)
    const dtos = usesDtos(context, info)
    imports.from(context.settings.modelsModule, names.imported)
    imports.from(dtos ? moduleOf(context, info, 'dtos') : moduleOf(context, info, 'entity'), dtos ? names.target : info.entity)
    if (plan.write) {
      const body: Body = { lines: [], uow: false }
      const args: string[] = []
      for (const item of plan.write) {
        const attr = info.columns.find((column) => column.column.name === item.column)?.attr ?? item.column
        if (item.value.kind === 'todo') {
          args.push(`${todoComment(item.value, attr)}`)
          continue
        }
        const expression = writeExpression(context, info, item.column, item.value, body, imports)
        args.push(expression === null ? `# TODO: ${attr}: no repository query finds the row it names` : `${attr}=${expression},`)
      }
      if (args.some((arg) => arg.includes('_plain('))) usesPlain = true
      usesUow ||= body.uow
      const params = body.uow ? `model: ${names.model}, uow: UnitOfWork` : `model: ${names.model}`
      functions.push(
        lines(
          `${body.uow ? def(context) : 'def'} ${names.write}(${params}) -> ${names.target}:`,
          `    """${article(plan.model)} as the ${info.name} table takes it."""`,
          ...body.lines.map((line) => `    ${line}`),
          `    return ${names.target}(`,
          ...args.map((arg) => `        ${arg}`),
          '    )',
        ),
      )
    }
    if (plan.read) {
      const body: Body = { lines: [], uow: false }
      const args: string[] = []
      for (const item of plan.read) {
        const field = model ? model.fields.find((candidate) => candidate.name === item.field) : undefined
        if (item.value.kind === 'todo') {
          args.push(todoComment(item.value, fieldAttr(item.field)), `${fieldAttr(item.field)}=None,`)
          continue
        }
        const expression = readExpression(context, info, field, item.value, body, imports)
        args.push(
          expression === null
            ? `${fieldAttr(item.field)}=None,  # TODO: no repository query reads it`
            : `${fieldAttr(item.field)}=${expression},`,
        )
      }
      if (args.some((arg) => arg.includes('_plain('))) usesPlain = true
      usesUow ||= body.uow
      const params = body.uow ? `row: ${names.source}, uow: UnitOfWork` : `row: ${names.source}`
      if (dtos) imports.from(moduleOf(context, info, 'dtos'), names.source)
      functions.push(
        lines(
          `${body.uow ? def(context) : 'def'} ${names.read}(${params}) -> ${names.model}:`,
          `    """A row of the ${info.name} table as ${article(plan.model)
            .toLowerCase()
            .replace(/^(an?) .*/, '$1')} ${plan.model}."""`,
          ...body.lines.map((line) => `    ${line}`),
          `    return ${names.model}(`,
          ...args.map((arg) => `        ${arg}`),
          '    )',
        ),
      )
    }
  }
  if (usesUow) imports.from('app.unit_of_work', 'UnitOfWork')
  if (usesPlain) imports.from('typing', 'Any')
  const helper = usesPlain
    ? [
        '',
        '',
        'def _plain(value: Any) -> Any:',
        '    """The value of an enum member, or the value itself."""',
        '    return getattr(value, "value", value)',
      ]
    : []
  const content = lines(
    `"""Conversions between the application models and the "${info.name}" table: what the service takes and returns."""`,
    '',
    imports.write('app'),
    ...helper,
    ...functions.flatMap((block) => ['', '', block]),
    '',
  )
  return { path: pathOf(conversionsModule(context, info)), content }
}

/**
 * The tests of the conversions: a row stored by the factories is read as the model, and each field taken from a
 * column holds its value; a model that goes both ways and leaves nothing to the user is written back, and every value
 * it gives is the row's (lookups and Mapper's lossless transformations included).
 */
export function conversionTestFile(context: Context, plans: ConversionPlan[]): GeneratedFile | null {
  const imports = new Imports()
  const fixture = context.settings.memoryRepositories ? 'memory_uow: MemoryUnitOfWork' : context.orm.databaseFixture
  const uow = fixture.split(':')[0]
  const blocks: string[] = []
  for (const plan of plans) {
    const info = findInfo(context, plan.table)
    const hasTodo = (items: { value: { kind: string } }[] | null) => (items ?? []).some((item) => item.value.kind === 'todo')
    if (!info || !plan.read || hasTodo(plan.read) || !canMake(context, info)) continue
    const names = conversionNames(context, plan)
    const reads = plan.read.some((item) => ['lookup', 'children'].includes(item.value.kind))
    const writes = plan.write !== null && !hasTodo(plan.write)
    const writeUow = writes && plan.write!.some((item) => item.value.kind === 'lookup')
    imports.from(conversionsModule(context, info), names.read, ...(writes ? [names.write] : []))
    imports.from('tests.factories', `add_${info.module}`)
    const a = (async: boolean) => (async && context.async ? 'await ' : '')
    const attr = (column: string) => info.columns.find((item) => item.column.name === column)?.attr ?? column
    const body = [
      `row = ${aw(context)}add_${info.module}(${uow})`,
      `model = ${a(reads)}${names.read}(row${reads ? `, ${uow}` : ''})`,
      ...plan.read.flatMap((item) =>
        item.value.kind === 'column' ? [`assert model.${fieldAttr(item.field)} == row.${attr(item.value.column)}`] : [],
      ),
      ...(writes
        ? [
            `values = ${a(writeUow)}${names.write}(model${writeUow ? `, ${uow}` : ''})`,
            ...plan.write!.map((item) => `assert values.${attr(item.column)} == row.${attr(item.column)}`),
          ]
        : []),
    ]
    blocks.push(
      lines(
        `${def(context)} test_${snakeName(plan.model)}_${writes ? 'goes_both_ways' : 'is_read'}(${fixture}) -> None:`,
        `    """${writes ? `A row read as ${article(plan.model).replace(/^A/, 'a')} and written back gives the same values.` : `A row is read as ${article(plan.model).replace(/^A/, 'a')}.`}"""`,
        ...body.map((line) => `    ${line}`),
      ),
    )
  }
  if (blocks.length === 0) return null
  imports.from('app.unit_of_work', fixture.split(': ')[1])
  const content = lines(
    `"""Tests of the conversions between the application models and the tables${context.async ? ' (asynchronous: pytest-asyncio runs every test function)' : ''}."""`,
    '',
    imports.write('app'),
    ...blocks.flatMap((block) => ['', '', block]),
    '',
  )
  return { path: 'tests/test_conversions.py', content }
}

/** The conversion files of a project and, when they are copied, the module of the models. */
export function conversionFiles(context: Context, schema: ModelSchema, plans: ConversionPlan[]): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const tables = [...new Set(plans.map((plan) => plan.table))]
  for (const table of tables) {
    const file = conversionFile(
      context,
      plans.filter((plan) => plan.table === table),
      schema,
    )
    if (file) files.push(file)
  }
  if (files.length === 0) return files
  if (context.settings.modelsSource === 'copy') files.push(modelsFile(schema, plans, pathOf(context.settings.modelsModule)))
  else if (context.settings.tests !== 'none') files.push(modelsFile(schema, plans, 'tests/application_models.py'))
  return files
}
