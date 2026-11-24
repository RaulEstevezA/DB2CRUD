/**
 * Reads Sequelize models into the physical schema, declared with `Model.init(attributes, options)` or
 * `sequelize.define(name, attributes, options)`: attributes with their `DataTypes`, `field`, keys, defaults and
 * `references`, the table options (`tableName`, `indexes`, `timestamps`, `paranoid`, `underscored`), and the
 * associations (`belongsTo`, `hasOne`, `hasMany`, `belongsToMany`) that place foreign keys. What Sequelize adds on
 * its own (an `id` when no attribute is the key, the timestamps, the names of foreign keys and of through tables)
 * follows its defaults. Sequelize keeps no CHECK constraints: the values a `validate` allows (`isIn`, `min`, `max`,
 * `len`) are read as CHECKs, as the rules need them, and a note says the database may have others. The engine is
 * the `dialect` of `new Sequelize(…)`, when the code names only one.
 */
import { pluralize, singularize } from '../../model/naming.ts'
import { checkOf } from '../../schema/checks.ts'
import type {
  DbCheck,
  DbColumn,
  DbEnum,
  DbForeignKey,
  DbNote,
  DbSchema,
  DbTable,
  DbType,
  Dialect,
  ReferentialAction,
} from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { TYPESCRIPT_LEXER } from '../code/typescript.ts'
import { booleanOf, literalOf, nameOf, numberOf, readArguments, stringOf, textOf, type Expr } from './expressions.ts'
import type { OrmReader, SourceFile } from './types.ts'
import { plainType, readTypeScript, SYNTAX, type EnumDef } from './typescript.ts'

// Reading the calls

interface ModelCall {
  /** The names the code uses for the model: its class, or the variable `define` is assigned to */
  keys: string[]
  /** The model name: the class, or the first argument of `define` */
  name: string
  attributes: Expr | undefined
  options: Map<string, Expr>
  line: number
}

interface Association {
  kind: 'belongsTo' | 'hasOne' | 'hasMany' | 'belongsToMany'
  source: string
  target: string
  options: Map<string, Expr>
}

const ASSOCIATIONS = new Set(['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'])

/** The entries of an object literal, by key. */
function entriesOf(expr: Expr | undefined): Map<string, Expr> {
  const entries = new Map<string, Expr>()
  if (expr?.kind === 'dict')
    for (const entry of expr.entries) {
      const key = nameOf(entry.key) ?? stringOf(entry.key)
      if (key) entries.set(key, entry.value)
    }
  return entries
}

const DIALECTS: Record<string, Dialect> = {
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  mssql: 'sqlserver',
  oracle: 'oracle',
}

function readCalls(files: SourceFile[]) {
  const models: ModelCall[] = []
  const associations: Association[] = []
  const removedIds = new Set<string>()
  const engines: string[] = []
  let defaults = new Map<string, Expr>()
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(file.text, TYPESCRIPT_LEXER)
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    const argumentsAt = (index: number) => {
      cursor.index = index
      return readArguments(cursor, file.text, SYNTAX, ')').args
    }
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (token.kind !== 'ident') continue
      if (token.value === 'new' && tokens[index + 1]?.value === 'Sequelize' && tokens[index + 2]?.value === '(') {
        const args = argumentsAt(index + 3)
        for (const arg of args) {
          const dialect = stringOf(entriesOf(arg).get('dialect')) ?? /^(\w+):/.exec(stringOf(arg) ?? '')?.[1]
          if (dialect) engines.push(dialect)
          const define = entriesOf(arg).get('define')
          if (define) defaults = entriesOf(define)
        }
        continue
      }
      if (tokens[index + 1]?.value !== '.' || tokens[index + 2]?.kind !== 'ident' || tokens[index + 3]?.value !== '(') continue
      const method = tokens[index + 2].value
      const receiver = token.value
      if (method === 'init') {
        const args = argumentsAt(index + 4)
        if (args[0]?.kind !== 'dict') continue
        const options = entriesOf(args[1])
        models.push({
          keys: [receiver],
          name: stringOf(options.get('modelName')) ?? receiver,
          attributes: args[0],
          options,
          line: token.line,
        })
      } else if (method === 'define') {
        const args = argumentsAt(index + 4)
        const name = stringOf(args[0])
        if (!name || args[1]?.kind !== 'dict') continue
        const variable = tokens[index - 1]?.value === '=' && tokens[index - 2]?.kind === 'ident' ? tokens[index - 2].value : undefined
        models.push({
          keys: [...(variable ? [variable] : []), name],
          name,
          attributes: args[1],
          options: entriesOf(args[2]),
          line: token.line,
        })
      } else if (ASSOCIATIONS.has(method)) {
        const args = argumentsAt(index + 4)
        const target = nameOf(args[0])
        if (target) associations.push({ kind: method as Association['kind'], source: receiver, target, options: entriesOf(args[1]) })
      } else if (method === 'removeAttribute') {
        if (stringOf(argumentsAt(index + 4)[0]) === 'id') removedIds.add(receiver)
      }
    }
  }
  return { models, associations, removedIds, engines, defaults }
}

// Types

/** The type without `.UNSIGNED`, `.ZEROFILL` and `.BINARY`. */
function baseType(expr: Expr): Expr {
  if (expr.kind === 'attribute' && ['UNSIGNED', 'ZEROFILL', 'BINARY'].includes(expr.name)) return baseType(expr.target)
  if (expr.kind === 'name' && expr.path.length > 1 && ['UNSIGNED', 'ZEROFILL', 'BINARY'].includes(expr.path.at(-1)!))
    return baseType({ kind: 'name', path: expr.path.slice(0, -1) })
  return expr
}

/** Whether the dates of the engine keep their zone: MySQL, MariaDB and SQLite keep none. */
const zoned = (dialect: Dialect | null) => dialect !== 'mysql' && dialect !== 'mariadb' && dialect !== 'sqlite'

interface TypeRead {
  type: DbType
  /** The values of an enum */
  values?: string[]
}

/** The database type of a Sequelize data type (`DataTypes.STRING(120)`). */
function typeOf(original: Expr, dialect: Dialect | null): TypeRead | null {
  const expr = baseType(original)
  const name = nameOf(expr)?.toUpperCase() ?? ''
  const args = expr.kind === 'call' ? expr.args : []
  const sql = textOf(original)
  const first = numberOf(args[0])
  switch (name) {
    case 'STRING':
      return { type: { sql, kind: 'text', length: first ?? 255 } }
    case 'CHAR':
      return { type: { sql, kind: 'text', length: first ?? 255, fixed: true } }
    case 'TEXT':
    case 'CITEXT':
      return { type: { sql, kind: 'text' } }
    case 'TINYINT':
    case 'SMALLINT':
      return { type: { sql, kind: 'integer', bits: 16 } }
    case 'MEDIUMINT':
    case 'INTEGER':
      return { type: { sql, kind: 'integer', bits: 32 } }
    case 'BIGINT':
      return { type: { sql, kind: 'integer', bits: 64 } }
    case 'FLOAT':
      return { type: { sql, kind: 'float', bits: dialect === 'postgresql' || dialect === 'sqlite' ? 64 : 32 } }
    case 'REAL':
      return { type: { sql, kind: 'float', bits: dialect === 'sqlite' ? 64 : 32 } }
    case 'DOUBLE':
      return { type: { sql, kind: 'float', bits: 64 } }
    case 'DECIMAL':
    case 'NUMERIC': {
      const scale = numberOf(args[1])
      return {
        type: { sql, kind: 'decimal', ...(first !== undefined ? { precision: first } : {}), ...(scale !== undefined ? { scale } : {}) },
      }
    }
    case 'BOOLEAN':
      return { type: { sql, kind: 'boolean' } }
    case 'DATE':
      // A Sequelize date is an instant: TIMESTAMP WITH TIME ZONE, except where the engine has no zone
      return { type: { sql, kind: 'datetime', timezone: zoned(dialect) } }
    case 'DATEONLY':
      return { type: { sql, kind: 'date' } }
    case 'TIME':
      return { type: { sql, kind: 'time', timezone: false } }
    case 'UUID':
      return { type: { sql, kind: 'uuid' } }
    case 'JSON':
    case 'JSONB':
      return { type: { sql, kind: 'json' } }
    case 'BLOB':
      return { type: { sql, kind: 'binary' } }
    case 'ENUM': {
      const list = args.length === 1 && args[0].kind === 'dict' ? entriesOf(args[0]).get('values') : undefined
      const items = list?.kind === 'list' ? list.items : args
      const values = items.map((item) => stringOf(item)).filter((item): item is string => item !== undefined)
      return { type: { sql, kind: 'text' }, values }
    }
    case 'ARRAY': {
      const items = args[0] ? typeOf(args[0], dialect) : null
      return items ? { type: { sql, kind: 'array', items: items.type } } : null
    }
    default:
      return null
  }
}

const NOW_SQL = /^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp|datetime\('now'\))$/i
const UUID_SQL = /^(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)$/i

/** A default: a literal, an enum member, SQL (`literal('…')`), the time (`DataTypes.NOW`, `fn('now')`) or a new UUID. */
function applyDefault(expr: Expr, column: DbColumn, enums: Map<string, EnumDef>): void {
  const name = nameOf(expr)
  if (expr.kind === 'call' && name === 'literal') {
    const sql = stringOf(expr.args[0]) ?? ''
    if (NOW_SQL.test(sql.trim())) column.generated = 'now'
    else if (UUID_SQL.test(sql.trim())) column.generated = 'uuid'
    else if (sql) column.default = { kind: 'expression', sql }
    return
  }
  if (expr.kind === 'call' && name === 'fn') {
    const fn = stringOf(expr.args[0]) ?? ''
    if (NOW_SQL.test(`${fn}()`)) column.generated = 'now'
    else if (UUID_SQL.test(`${fn}()`)) column.generated = 'uuid'
    else if (fn) column.default = { kind: 'expression', sql: `${fn}()` }
    return
  }
  if (expr.kind === 'name') {
    if (expr.path.length > 1 && name === 'NOW') column.generated = 'now'
    else if (expr.path.length > 1 && (name === 'UUIDV4' || name === 'UUIDV1')) column.generated = 'uuid'
    else if (expr.path.length === 1 && name === 'null') column.default = { kind: 'literal', value: null }
    else if (expr.path.length === 2 && enums.has(expr.path[0])) {
      const value = enums.get(expr.path[0])!.get(expr.path[1])
      if (value !== undefined) column.default = { kind: 'literal', value }
    } else {
      const value = literalOf(expr)
      if (value !== undefined) column.default = { kind: 'literal', value }
    }
    return
  }
  const value = literalOf(expr)
  if (value !== undefined) column.default = { kind: 'literal', value }
  else if (expr.kind === 'list' || expr.kind === 'dict') column.default = { kind: 'literal', value: toJson(expr) }
}

/** An array or object literal as JSON, for the default of a JSON column. */
function toJson(expr: Expr): string {
  if (expr.kind === 'list') return `[${expr.items.map(toJson).join(',')}]`
  if (expr.kind === 'dict')
    return `{${expr.entries.map((entry) => `${JSON.stringify(nameOf(entry.key) ?? stringOf(entry.key) ?? '')}:${toJson(entry.value)}`).join(',')}}`
  const value = literalOf(expr)
  return value === undefined ? 'null' : JSON.stringify(value)
}

const quoted = (values: (string | number)[]) =>
  values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)).join(', ')

/** The CHECKs a `validate` stands for: `isIn`, `min`, `max` and `len`. */
function validationChecks(column: string, validate: Map<string, Expr>): DbCheck[] {
  const checks: DbCheck[] = []
  const setting = (expr: Expr | undefined) => {
    // `{ args: …, msg: '…' }` gives the value with a message
    const args = entriesOf(expr).get('args')
    return args ?? expr
  }
  const isIn = setting(validate.get('isIn'))
  const list = isIn?.kind === 'list' && isIn.items[0]?.kind === 'list' ? isIn.items[0] : undefined
  if (list?.kind === 'list') {
    const values = list.items
      .map((item) => literalOf(item))
      .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    if (values.length > 0) checks.push(checkOf(`${column} IN (${quoted(values)})`))
  }
  const min = numberOf(setting(validate.get('min')))
  if (min !== undefined) checks.push(checkOf(`${column} >= ${min}`))
  const max = numberOf(setting(validate.get('max')))
  if (max !== undefined) checks.push(checkOf(`${column} <= ${max}`))
  const len = setting(validate.get('len'))
  if (len?.kind === 'list') {
    const [low, high] = len.items.map((item) => numberOf(item))
    if (low !== undefined && low > 0) checks.push(checkOf(`LENGTH(${column}) >= ${low}`))
    if (high !== undefined) checks.push(checkOf(`LENGTH(${column}) <= ${high}`))
  }
  return checks
}

const ACTIONS: Record<string, ReferentialAction> = {
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
  RESTRICT: 'restrict',
  'NO ACTION': 'no action',
}

const actionOf = (expr: Expr | undefined) => ACTIONS[(stringOf(expr) ?? '').toUpperCase()]

// Sequelize's names

/** `Utils.camelize`: `Customer_id` → `CustomerId`. */
const camelize = (text: string) =>
  text.trim().replace(/[-_\s]+(.)?/g, (_match, next: string | undefined) => (next ? next.toUpperCase() : ''))
/** `Utils.underscore`: `customerId` → `customer_id`. */
const underscore = (text: string) =>
  text
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()

// Building the tables

interface Model {
  call: ModelCall
  table: DbTable
  /** Column of each attribute */
  columns: Map<string, string>
  underscored: boolean
}

function readSequelize(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const { classes, enums } = readTypeScript(files)
  const { models: calls, associations, removedIds, engines, defaults } = readCalls(files)
  for (const engine of new Set(engines)) if (!DIALECTS[engine]) notes.push({ code: 'orm.unsupportedEngine', params: { engine } })
  const dialects = new Set(engines.map((engine) => DIALECTS[engine]).filter((item): item is Dialect => !!item))
  const dialect = dialects.size === 1 ? [...dialects][0] : null
  const dbEnums: DbEnum[] = []
  const addEnum = (name: string, values: (string | number)[], storage: DbEnum['storage']) => {
    if (!dbEnums.some((item) => item.name === name)) dbEnums.push({ name, values: values.map(String), storage })
  }

  const models: Model[] = []
  const byKey = new Map<string, Model>()
  for (const call of calls) {
    const { options } = call
    const option = (name: string) => options.get(name) ?? defaults.get(name)
    const underscored = booleanOf(option('underscored')) === true
    const freeze = booleanOf(option('freezeTableName')) === true
    const table: DbTable = {
      name: stringOf(options.get('tableName')) ?? (freeze ? call.name : pluralize(call.name)),
      columns: [],
      primaryKey: null,
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      entity: call.keys[0],
      origin: { line: call.line, column: 1 },
    }
    const schema = stringOf(options.get('schema'))
    if (schema) table.schema = schema
    const comment = stringOf(options.get('comment'))
    if (comment) table.comment = comment
    const model: Model = { call, table, columns: new Map(), underscored }
    const members = new Map((classes.get(call.keys[0])?.members ?? []).map((member) => [member.name, member]))
    const primary: string[] = []
    for (const entry of call.attributes?.kind === 'dict' ? call.attributes.entries : []) {
      const attribute = nameOf(entry.key) ?? stringOf(entry.key)
      if (!attribute) continue
      const settings = entry.value.kind === 'dict' ? entriesOf(entry.value) : new Map([['type', entry.value]])
      const typeExpr = settings.get('type')
      if (typeExpr && nameOf(baseType(typeExpr)) === 'VIRTUAL') continue
      const name = stringOf(settings.get('field')) ?? (underscored ? underscore(attribute) : attribute)
      const read = typeExpr ? typeOf(typeExpr, dialect) : null
      let type: DbType | null = read?.type ?? null
      if (read?.values) {
        // Sequelize names the type of an enum enum_<table>_<column> on PostgreSQL; SQLite keeps text
        const enumName = `enum_${table.name}_${name}`
        const native = dialect !== 'sqlite'
        addEnum(enumName, read.values, native ? 'native' : 'check')
        if (native) type = { sql: read.type.sql, kind: 'enum', name: enumName }
        else table.checks.push(checkOf(`${name} IN (${quoted(read.values)})`))
      }
      if (!type)
        notes.push({ code: 'orm.unknownType', params: { table: table.name, column: name, type: typeExpr ? textOf(typeExpr) : '' } })
      const isPrimary = booleanOf(settings.get('primaryKey')) === true
      const column: DbColumn = {
        name,
        type: type ?? { sql: typeExpr ? textOf(typeExpr) : '', kind: 'unknown' },
        nullable: !isPrimary && booleanOf(settings.get('allowNull')) !== false,
      }
      const value = settings.get('defaultValue')
      if (value) applyDefault(value, column, enums)
      if (booleanOf(settings.get('autoIncrement')) === true) column.generated = 'identity'
      const columnComment = stringOf(settings.get('comment'))
      if (columnComment) column.comment = columnComment
      if (name !== attribute) column.attribute = attribute
      table.columns.push(column)
      model.columns.set(attribute, name)
      if (isPrimary) primary.push(name)
      const unique = settings.get('unique')
      if (booleanOf(unique) === true || stringOf(unique)) {
        const uniqueName = stringOf(unique)
        const same = uniqueName ? table.uniques.find((item) => item.name === uniqueName) : undefined
        if (same) same.columns.push(name)
        else table.uniques.push({ ...(uniqueName ? { name: uniqueName } : {}), columns: [name] })
      }
      const validate = entriesOf(settings.get('validate'))
      const checks = validationChecks(name, validate)
      // A TypeScript enum on the attribute keeps its values in a text column: an enum checked by a CHECK
      const member = members.get(attribute)
      const tsEnum = member
        ? plainType(member)
            .replace(/^CreationOptional<(.*)>$/, '$1')
            .replace(/\|\s*null\b/g, '')
            .trim()
        : ''
      if (!read?.values && type?.kind === 'text' && enums.has(tsEnum)) {
        const values = [...enums.get(tsEnum)!.values()]
        addEnum(underscore(tsEnum), values, 'check')
        if (!checks.some((check) => check.parsed?.kind === 'in')) checks.push(checkOf(`${name} IN (${quoted(values)})`))
      }
      table.checks.push(...checks)
      const references = settings.get('references')
      if (references) {
        const target = entriesOf(references)
        // A model, the name of a table, or a table with its schema: `{ tableName: 'orders', schema: 'sales' }`
        const model = target.get('model')
        const named = model?.kind === 'dict' ? entriesOf(model).get('tableName') : model
        table.foreignKeys.push({
          columns: [name],
          // Resolved below: a model, or the name of a table
          references: { table: nameOf(named) ?? stringOf(named) ?? '', columns: [stringOf(target.get('key')) ?? 'id'] },
          ...(actionOf(settings.get('onDelete')) ? { onDelete: actionOf(settings.get('onDelete')) } : {}),
          ...(actionOf(settings.get('onUpdate')) ? { onUpdate: actionOf(settings.get('onUpdate')) } : {}),
        })
      }
    }
    // Sequelize adds an integer key `id` to a model with no key, unless the code removes it
    if (primary.length === 0 && !call.keys.some((key) => removedIds.has(key))) {
      table.columns.unshift({ name: 'id', type: { sql: 'INTEGER', kind: 'integer', bits: 32 }, nullable: false, generated: 'identity' })
      model.columns.set('id', 'id')
      primary.push('id')
    }
    if (primary.length > 0) table.primaryKey = primary
    // The timestamps Sequelize keeps (and the time of a soft delete, with `paranoid`)
    if (booleanOf(option('timestamps')) !== false) {
      const stamps = [
        ['createdAt', 'now', false],
        ['updatedAt', 'onUpdateNow', false],
        ...(booleanOf(option('paranoid')) === true ? [['deletedAt', undefined, true] as const] : []),
      ] as const
      for (const [attribute, generated, nullable] of stamps) {
        const setting = options.get(attribute) ?? defaults.get(attribute)
        if (booleanOf(setting) === false || model.columns.has(attribute)) continue
        const name = stringOf(setting) ?? (underscored ? underscore(attribute) : attribute)
        if (table.columns.some((item) => item.name === name)) continue
        const column: DbColumn = { name, type: { sql: 'DATE', kind: 'datetime', timezone: zoned(dialect) }, nullable }
        if (generated) column.generated = generated
        if (name !== attribute) column.attribute = attribute
        table.columns.push(column)
        model.columns.set(attribute, name)
      }
    }
    const indexes = options.get('indexes')
    for (const index of indexes?.kind === 'list' ? indexes.items : []) {
      const settings = entriesOf(index)
      const fields = settings.get('fields')
      const columns = (fields?.kind === 'list' ? fields.items : [])
        .map((item) => stringOf(item) ?? stringOf(entriesOf(item).get('name')) ?? stringOf(entriesOf(item).get('attribute')))
        .filter((item): item is string => item !== undefined)
        .map((item) => model.columns.get(item) ?? item)
      if (columns.length === 0) continue
      const indexName = stringOf(settings.get('name'))
      const target = booleanOf(settings.get('unique')) === true ? table.uniques : table.indexes
      target.push({ ...(indexName ? { name: indexName } : {}), columns })
    }
    models.push(model)
    for (const key of call.keys) byKey.set(key, model)
  }
  const byTable = (name: string) => byKey.get(name) ?? models.find((model) => model.table.name === name)

  // References: to the table of the model they name
  for (const model of models)
    for (const key of model.table.foreignKeys) {
      const target = byTable(key.references.table)
      if (!target) continue
      key.references = {
        table: target.table.name,
        ...(target.table.schema ? { schema: target.table.schema } : {}),
        columns: key.references.columns.map((column) => target.columns.get(column) ?? column),
      }
    }

  const joins: DbTable[] = []
  for (const association of associations) {
    const source = byKey.get(association.source)
    const target = byKey.get(association.target)
    if (!source || !target) continue
    const { options } = association
    const as = stringOf(options.get('as'))
    if (association.kind === 'belongsToMany') {
      const join = throughTable(source, target, options, byTable)
      if (join && !joins.some((item) => item.name === join.name)) joins.push(join)
      continue
    }
    // belongsTo puts the key on the source; hasOne and hasMany on the target
    const owner = association.kind === 'belongsTo' ? source : target
    const parent = association.kind === 'belongsTo' ? target : source
    const parentKey = stringOf(options.get(association.kind === 'belongsTo' ? 'targetKey' : 'sourceKey'))
    const referenced = parentKey ? (parent.columns.get(parentKey) ?? parentKey) : parent.table.primaryKey?.[0]
    const parentColumn = parent.table.columns.find((item) => item.name === referenced)
    if (!parentColumn) continue
    const foreignKey = options.get('foreignKey')
    const keySettings = entriesOf(foreignKey)
    const parentAttribute = [...parent.columns].find(([, column]) => column === parentColumn.name)?.[0] ?? parentColumn.name
    const defaultName =
      association.kind === 'belongsTo'
        ? camelize(`${as ?? singularize(parent.call.name)}_${parentAttribute}`)
        : camelize(`${singularize(parent.call.name)}_${parentAttribute}`)
    const attribute = stringOf(foreignKey) ?? stringOf(keySettings.get('name')) ?? defaultName
    const column =
      owner.columns.get(attribute) ?? stringOf(keySettings.get('field')) ?? (owner.underscored ? underscore(attribute) : attribute)
    if (!owner.table.columns.some((item) => item.name === column)) {
      owner.table.columns.push({
        name: column,
        type: parentColumn.type,
        nullable: booleanOf(keySettings.get('allowNull')) !== false,
        ...(column !== attribute ? { attribute } : {}),
      })
      owner.columns.set(attribute, column)
    }
    const onDelete = actionOf(options.get('onDelete'))
    const onUpdate = actionOf(options.get('onUpdate'))
    let key = owner.table.foreignKeys.find((item) => item.columns.length === 1 && item.columns[0] === column)
    if (!key) {
      key = {
        columns: [column],
        references: {
          table: parent.table.name,
          ...(parent.table.schema ? { schema: parent.table.schema } : {}),
          columns: [parentColumn.name],
        },
      }
      owner.table.foreignKeys.push(key)
    }
    if (onDelete && !key.onDelete) key.onDelete = onDelete
    if (onUpdate && !key.onUpdate) key.onUpdate = onUpdate
    if (association.kind === 'belongsTo' && as && !key.attribute) key.attribute = as
    if (association.kind !== 'belongsTo' && as && !key.inverse) key.inverse = as
    // hasOne: one row of the owner for each parent
    if (association.kind === 'hasOne' && !owner.table.uniques.some((item) => item.columns.length === 1 && item.columns[0] === column))
      owner.table.uniques.push({ columns: [column] })
  }
  for (const model of models) model.table.foreignKeys = model.table.foreignKeys.map(orderedKey)

  if (models.length > 0) notes.push({ code: 'orm.checksNotKept' })
  return {
    format: 'db-schema',
    version: 1,
    dialect,
    source: { kind: 'orm', format: 'sequelize' },
    tables: [...models.map((model) => model.table), ...joins],
    enums: dbEnums,
    notes,
  }
}

/** The keys of a foreign key in the order every reader writes them. */
function orderedKey(key: DbForeignKey): DbForeignKey {
  const { name, columns, references, onDelete, onUpdate, attribute, inverse } = key
  return {
    ...(name ? { name } : {}),
    columns,
    references,
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    ...(attribute ? { attribute } : {}),
    ...(inverse ? { inverse } : {}),
  }
}

/** The table of a `belongsToMany`: the model `through` names gets the two foreign keys it lacks; a name that is no
 * model is a table Sequelize creates, keyed by both columns and deleted with either row. */
function throughTable(
  source: Model,
  target: Model,
  options: Map<string, Expr>,
  byTable: (name: string) => Model | undefined,
): DbTable | null {
  const through = options.get('through')
  const throughName =
    stringOf(through) ?? stringOf(entriesOf(through).get('model')) ?? nameOf(entriesOf(through).get('model')) ?? nameOf(through)
  if (!throughName) return null
  const existing = byTable(throughName)
  const sides = [
    [source, stringOf(options.get('foreignKey')) ?? stringOf(entriesOf(options.get('foreignKey')).get('name'))],
    [target, stringOf(options.get('otherKey')) ?? stringOf(entriesOf(options.get('otherKey')).get('name'))],
  ] as const
  const table: DbTable = existing?.table ?? {
    name: throughName,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    indexes: [],
    checks: [],
  }
  for (const [side, given] of sides) {
    const keyColumn = side.table.columns.find((item) => item.name === side.table.primaryKey?.[0])
    if (!keyColumn) continue
    const attribute =
      given ??
      camelize(`${singularize(side.call.name)}_${[...side.columns].find(([, column]) => column === keyColumn.name)?.[0] ?? keyColumn.name}`)
    const column = existing?.columns.get(attribute) ?? attribute
    if (!table.columns.some((item) => item.name === column)) {
      table.columns.push({ name: column, type: keyColumn.type, nullable: false })
      if (!existing) table.primaryKey!.push(column)
    }
    if (table.foreignKeys.some((item) => item.columns.length === 1 && item.columns[0] === column)) continue
    table.foreignKeys.push({
      columns: [column],
      references: { table: side.table.name, ...(side.table.schema ? { schema: side.table.schema } : {}), columns: [keyColumn.name] },
      onDelete: 'cascade',
      onUpdate: 'cascade',
    })
  }
  return existing ? null : table
}

export const sequelizeReader: OrmReader = {
  id: 'sequelize',
  label: 'Sequelize',
  language: 'typescript',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\bfrom\s+['"]sequelize['"]|\brequire\(\s*['"]sequelize['"]\s*\)/.test(text) && /\.(init|define)\s*\(/.test(text) ? 1 : 0
  },
  read: readSequelize,
}
