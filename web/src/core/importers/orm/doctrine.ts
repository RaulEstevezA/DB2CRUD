/**
 * Reads Doctrine ORM entities, mapped with PHP attributes, into the physical schema: classes marked `#[ORM\Entity]`
 * with the fields of their `#[ORM\MappedSuperclass]` bases and of their `#[ORM\Embedded]` parts, `#[ORM\Table]`,
 * `#[ORM\Index]` and `#[ORM\UniqueConstraint]`, `#[ORM\Column]` (type, length, precision, nullable, unique, options,
 * `columnDefinition`, `enumType`) or the PHP type of the property, keys and generated values, foreign keys of
 * `#[ORM\ManyToOne]` and `#[ORM\OneToOne]` with their `#[ORM\JoinColumn]`, join tables of `#[ORM\ManyToMany]`, PHP
 * enums, and the types a project registers on top of DBAL's. Names nobody gave follow Doctrine's default naming
 * strategy. Doctrine keeps no CHECK constraints but those of enums: a note says so. The engine is the one the
 * connection names (a URL or a driver), when it names only one.
 */
import { checkOf } from '../../schema/checks.ts'
import type { DbColumn, DbEnum, DbNote, DbSchema, DbTable, DbType, Dialect, ReferentialAction } from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { PHP_LEXER } from '../code/php.ts'
import { booleanOf, literalOf, nameOf, numberOf, readExpression, stringOf, type Expr } from './expressions.ts'
import { sqlTypeOf } from './sqlTypes.ts'
import type { OrmReader, SourceFile } from './types.ts'

/** PHP names its arguments with `name: value`. */
const SYNTAX = { named: ':' } as const

type Call = Expr & { kind: 'call' }

interface Property {
  /** Without its `$` */
  name: string
  /** The PHP type as written: `?int`, `\DateTimeImmutable` */
  type: string
  attributes: Expr[]
  initializer?: Expr
  line: number
}

interface PhpClass {
  name: string
  kind: string
  attributes: Expr[]
  base?: string
  properties: Property[]
  /** The constants of the class: `const NAME = 'precise_datetime'` */
  constants: Map<string, Expr>
  /** The cases of an enum, with their values when it is backed */
  cases: { name: string; value?: string | number }[]
  line: number
}

// Reading the declarations

/** The attributes of a `#[…]` group, after its `#[`. */
function readAttributeGroup(cursor: Cursor, source: string): Expr[] {
  const attributes: Expr[] = []
  while (!cursor.done && !cursor.is(']')) {
    attributes.push(readExpression(cursor, source, SYNTAX))
    if (!cursor.eat(',')) break
  }
  cursor.eat(']')
  return attributes
}

const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'var', 'final', 'abstract'])
const DECLARATIONS = new Set(['class', 'interface', 'trait', 'enum'])

function readDeclaration(cursor: Cursor, source: string, kind: string, attributes: Expr[], classes: PhpClass[]): void {
  const line = cursor.peek()?.line ?? 1
  const declaration: PhpClass = { name: cursor.next().value, kind, attributes, properties: [], constants: new Map(), cases: [], line }
  while (!cursor.done && !cursor.is('{')) {
    if (cursor.is('extends') && cursor.isIdent(1)) {
      cursor.next()
      while (cursor.is('\\')) cursor.next()
      let base = cursor.next().value
      while (cursor.is('\\') && cursor.isIdent(1)) {
        cursor.next()
        base = cursor.next().value
      }
      declaration.base = base
    } else cursor.next()
  }
  classes.push(declaration)
  cursor.next()
  let pending: Expr[] = []
  while (!cursor.done && !cursor.is('}')) {
    if (cursor.is('#[')) {
      cursor.next()
      pending.push(...readAttributeGroup(cursor, source))
      continue
    }
    if (MODIFIERS.has(cursor.value()) && cursor.isIdent()) {
      cursor.next()
      continue
    }
    if (cursor.is('case') && cursor.isIdent(1)) {
      cursor.next()
      const name = cursor.next().value
      const value = cursor.eat('=') ? literalOf(readExpression(cursor, source, SYNTAX)) : undefined
      declaration.cases.push({ name, ...(typeof value === 'string' || typeof value === 'number' ? { value } : {}) })
      cursor.skipUntil([';'])
      cursor.eat(';')
      pending = []
      continue
    }
    if (cursor.is('const')) {
      cursor.next()
      // `const string NAME = …` (PHP 8.3 typed constants)
      if (cursor.isIdent(1) && !cursor.is('=', 1)) cursor.next()
      const name = cursor.next().value
      if (cursor.eat('=')) declaration.constants.set(name, readExpression(cursor, source, SYNTAX))
      cursor.skipUntil([';'])
      cursor.eat(';')
      pending = []
      continue
    }
    if (cursor.is('function')) {
      // A method: its parameters, its return type and its body
      while (!cursor.done && !cursor.is('(')) cursor.next()
      cursor.skipGroup()
      while (!cursor.done && !cursor.is('{') && !cursor.is(';') && !cursor.is('}')) cursor.next()
      if (cursor.is('{')) cursor.skipGroup()
      else cursor.eat(';')
      pending = []
      continue
    }
    if (cursor.is('use')) {
      cursor.skipUntil([';'])
      cursor.eat(';')
      continue
    }
    // A property: an optional type, then `$name`
    const typeStart = cursor.index
    while (!cursor.done && !(cursor.isIdent() && cursor.value().startsWith('$')) && !cursor.is(';') && !cursor.is('}')) cursor.next()
    if (!cursor.isIdent() || !cursor.value().startsWith('$')) {
      cursor.eat(';')
      pending = []
      continue
    }
    const type = cursor.textBetween(source, typeStart, cursor.index).replace(/\s+/g, '')
    const name = cursor.next()
    const initializer = cursor.eat('=') ? readExpression(cursor, source, SYNTAX) : undefined
    cursor.skipUntil([';'])
    cursor.eat(';')
    declaration.properties.push({
      name: name.value.slice(1),
      type,
      attributes: pending,
      ...(initializer ? { initializer } : {}),
      line: name.line,
    })
    pending = []
  }
  cursor.eat('}')
}

function readClasses(files: SourceFile[]): PhpClass[] {
  const classes: PhpClass[] = []
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(
        file.text.replace(/^\s*<\?php/, (match) => ' '.repeat(match.length)),
        PHP_LEXER,
      )
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    let attributes: Expr[] = []
    while (!cursor.done) {
      if (cursor.is('#[')) {
        cursor.next()
        attributes.push(...readAttributeGroup(cursor, file.text))
      } else if (DECLARATIONS.has(cursor.value()) && cursor.isIdent() && cursor.isIdent(1)) {
        const kind = cursor.next().value
        readDeclaration(cursor, file.text, kind, attributes, classes)
        attributes = []
      } else if (MODIFIERS.has(cursor.value()) && cursor.isIdent()) cursor.next()
      else {
        cursor.next()
        attributes = []
      }
    }
  }
  return classes
}

// Reading the attributes

const attributeOf = (attributes: Expr[], ...names: string[]): Expr | undefined =>
  attributes.find((item) => names.includes(nameOf(item) ?? ''))

function argumentOf(attribute: Expr | undefined, name: string, position?: number): Expr | undefined {
  if (attribute?.kind !== 'call') return undefined
  return attribute.named[name] ?? (position !== undefined ? attribute.args[position] : undefined)
}

/** `Order::class` or `'App\Entity\Order'`: the class it names, without its namespace. */
function classOf(expr: Expr | undefined): string | undefined {
  if (!expr) return undefined
  if (expr.kind === 'name' && expr.path.at(-1) === 'class') return expr.path.at(-2)
  const text = stringOf(expr)
  return text?.split('\\').at(-1)
}

/** The entries of a PHP array with keys: `['default' => 1]`. */
function entriesOf(expr: Expr | undefined): Map<string, Expr> {
  const entries = new Map<string, Expr>()
  if (expr?.kind === 'dict')
    for (const entry of expr.entries) {
      const key = stringOf(entry.key) ?? nameOf(entry.key)
      if (key) entries.set(key, entry.value)
    }
  return entries
}

const stringsOf = (expr: Expr | undefined): string[] =>
  (expr?.kind === 'list' ? expr.items : []).map((item) => stringOf(item)).filter((item): item is string => item !== undefined)

/** The simple name of a PHP type: `?\DateTimeImmutable` → `DateTimeImmutable`; `int|null` → `int`. */
const simpleType = (type: string) =>
  type
    .replace(/^\?/, '')
    .split('|')
    .filter((item) => item.toLowerCase() !== 'null')[0]
    ?.split('\\')
    .at(-1) ?? ''

// Types

/** The type a DBAL type name stands for: `datetimetz_immutable`, `string`. */
function typeOfName(name: string, column: Expr | undefined, dialect: Dialect | null): DbType | null {
  const type = name.toLowerCase().replace(/_(im)?mutable$/, '')
  const options = entriesOf(argumentOf(column, 'options'))
  const length = numberOf(argumentOf(column, 'length'))
  const sql = name
  switch (type) {
    case 'integer':
      return { sql, kind: 'integer', bits: dialect === 'sqlite' ? 64 : 32 }
    case 'smallint':
      return { sql, kind: 'integer', bits: 16 }
    case 'bigint':
      return { sql, kind: 'integer', bits: 64 }
    case 'boolean':
      return { sql, kind: 'boolean' }
    case 'decimal': {
      const precision = numberOf(argumentOf(column, 'precision'))
      const scale = numberOf(argumentOf(column, 'scale'))
      return { sql, kind: 'decimal', ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) }
    }
    case 'float':
      return { sql, kind: 'float', bits: 64 }
    case 'smallfloat':
      return { sql, kind: 'float', bits: 32 }
    case 'string':
    case 'ascii_string':
      return booleanOf(options.get('fixed')) === true
        ? { sql, kind: 'text', length: length ?? 255, fixed: true }
        : { sql, kind: 'text', length: length ?? 255 }
    case 'text':
    case 'simple_array':
      return { sql, kind: 'text' }
    case 'guid':
      return { sql, kind: 'uuid' }
    case 'json':
      return { sql, kind: 'json' }
    case 'date':
      return { sql, kind: 'date' }
    case 'time':
      return { sql, kind: 'time', timezone: false }
    case 'datetime':
      return { sql, kind: 'datetime', timezone: false }
    case 'datetimetz':
      return { sql, kind: 'datetime', timezone: true }
    case 'binary':
      return length !== undefined ? { sql, kind: 'binary', length } : { sql, kind: 'binary' }
    case 'blob':
      return { sql, kind: 'binary' }
    default:
      return null
  }
}

/** The DBAL types a project's own types extend: `PreciseDateTimeTzType extends DateTimeTzImmutableType`. */
const BASE_TYPES: Record<string, string> = {
  IntegerType: 'integer',
  SmallIntType: 'smallint',
  BigIntType: 'bigint',
  BooleanType: 'boolean',
  DecimalType: 'decimal',
  FloatType: 'float',
  SmallFloatType: 'smallfloat',
  StringType: 'string',
  AsciiStringType: 'ascii_string',
  TextType: 'text',
  GuidType: 'guid',
  JsonType: 'json',
  DateType: 'date',
  DateImmutableType: 'date',
  TimeType: 'time',
  TimeImmutableType: 'time',
  DateTimeType: 'datetime',
  DateTimeImmutableType: 'datetime',
  DateTimeTzType: 'datetimetz',
  DateTimeTzImmutableType: 'datetimetz',
  BinaryType: 'binary',
  BlobType: 'blob',
}

/** The DBAL type of a PHP type, when the column names none. */
const PHP_TYPES: Record<string, string> = {
  int: 'integer',
  string: 'string',
  bool: 'boolean',
  float: 'float',
  DateTime: 'datetime',
  DateTimeImmutable: 'datetime_immutable',
  DateTimeInterface: 'datetime',
  array: 'json',
}

const NOW_SQL = /^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp|datetime\('now'\))$/i
const UUID_SQL = /^(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)$/i

const ACTIONS: Record<string, ReferentialAction> = {
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
  RESTRICT: 'restrict',
  'NO ACTION': 'no action',
}

const DRIVERS: [RegExp, Dialect][] = [
  [/['"](?:pdo_)?pgsql['"]|['"](?:postgres(?:ql)?|pgsql):\/\//, 'postgresql'],
  [/['"]mariadb:\/\//, 'mariadb'],
  [/['"](?:pdo_)?mysqli?['"]|['"]mysql:\/\//, 'mysql'],
  [/['"](?:pdo_)?sqlite3?['"]|['"]sqlite3?:\/\//, 'sqlite'],
  [/['"](?:pdo_)?sqlsrv['"]|['"](?:sqlsrv|mssql):\/\//, 'sqlserver'],
  [/['"](?:pdo_)?oci8?['"]|['"]oci8?:\/\//, 'oracle'],
]

const quoted = (values: (string | number)[]) =>
  values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)).join(', ')

/** `OrderStatus` → `order_status`. */
const toSnake = (name: string) => name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()

// Building the tables

interface Model {
  cls: PhpClass
  table: DbTable
  /** Column of each property */
  columns: Map<string, string>
  properties: Property[]
}

const RELATIONS = ['ManyToOne', 'OneToOne', 'OneToMany', 'ManyToMany']

function readDoctrine(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const classes = readClasses(files)
  const byName = new Map(classes.map((cls) => [cls.name, cls]))
  const text = files.map((file) => file.text).join('\n')
  const found = DRIVERS.filter(([pattern]) => pattern.test(text)).map(([, dialect]) => dialect)
  const dialect = new Set(found).size === 1 ? found[0] : null
  const dbEnums: DbEnum[] = []

  // The project's own types: `const NAME = 'precise_datetimetz'` in a class that extends a DBAL type
  const customTypes = new Map<string, string>()
  for (const cls of classes) {
    const name = stringOf(cls.constants.get('NAME'))
    const base = cls.base ? BASE_TYPES[cls.base] : undefined
    if (name && base) customTypes.set(name, base)
  }

  /** The properties of a class and of the `#[ORM\MappedSuperclass]` classes it extends. */
  const propertiesOf = (cls: PhpClass, seen = new Set<string>()): Property[] => {
    seen.add(cls.name)
    const base = cls.base ? byName.get(cls.base) : undefined
    const inherited = base && !seen.has(base.name) && attributeOf(base.attributes, 'MappedSuperclass') ? propertiesOf(base, seen) : []
    return [...inherited, ...cls.properties]
  }

  const models: Model[] = []
  const byClass = new Map<string, Model>()
  for (const cls of classes) {
    if (!attributeOf(cls.attributes, 'Entity')) continue
    const tableAttribute = attributeOf(cls.attributes, 'Table')
    const table: DbTable = {
      name: stringOf(argumentOf(tableAttribute, 'name', 0)) ?? cls.name,
      columns: [],
      primaryKey: null,
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      entity: cls.name,
      origin: { line: cls.line, column: 1 },
    }
    const schema = stringOf(argumentOf(tableAttribute, 'schema'))
    if (schema) table.schema = schema
    const comment = stringOf(entriesOf(argumentOf(tableAttribute, 'options')).get('comment'))
    if (comment) table.comment = comment
    const model: Model = { cls, table, columns: new Map(), properties: propertiesOf(cls) }
    const primary: string[] = []

    const addColumn = (property: Property, prefix: string, attributePrefix: string): void => {
      const embedded = attributeOf(property.attributes, 'Embedded')
      if (embedded) {
        const part = byName.get(classOf(argumentOf(embedded, 'class', 0)) ?? simpleType(property.type))
        if (!part) return
        const given = argumentOf(embedded, 'columnPrefix')
        const own = booleanOf(given) === false ? '' : (stringOf(given) ?? `${property.name}_`)
        for (const inner of propertiesOf(part)) addColumn(inner, `${prefix}${own}`, `${attributePrefix}${property.name}.`)
        return
      }
      const column = attributeOf(property.attributes, 'Column')
      if (!column) return
      const name = `${prefix}${stringOf(argumentOf(column, 'name')) ?? property.name}`
      const options = entriesOf(argumentOf(column, 'options'))
      const definition = stringOf(argumentOf(column, 'columnDefinition'))
      const typeExpr = argumentOf(column, 'type', 0)
      const enumClass =
        byName.get(classOf(argumentOf(column, 'enumType')) ?? '') ??
        (byName.get(simpleType(property.type))?.kind === 'enum' ? byName.get(simpleType(property.type)) : undefined)
      // `Types::BIGINT`, `'bigint'`, or the PHP type of the property
      const typeName =
        stringOf(typeExpr) ??
        (typeExpr?.kind === 'name'
          ? typeExpr.path
              .at(-1)!
              .toLowerCase()
              .replace(/_mutable$/, '')
          : undefined) ??
        (enumClass
          ? enumClass.cases.some((item) => typeof item.value === 'number')
            ? 'integer'
            : 'string'
          : PHP_TYPES[simpleType(property.type)])
      let type: DbType | null = null
      if (definition) {
        const sql = definition.replace(/\s+(not\s+null|null|default\b.*|generated\b.*|primary\s+key.*|unique.*)$/i, '')
        type = sqlTypeOf(sql, dialect)
        if (type) type = { ...type, sql: definition }
      } else if (typeName) type = typeOfName(customTypes.get(typeName) ?? typeName, column, dialect)
      if (type && customTypes.has(typeName ?? '')) type = { ...type, sql: typeName! }
      if (!type)
        notes.push({ code: 'orm.unknownType', params: { table: table.name, column: name, type: definition ?? typeName ?? property.type } })
      const isKey = !!attributeOf(property.attributes, 'Id')
      const dbColumn: DbColumn = {
        name,
        type: type ?? { sql: definition ?? typeName ?? property.type, kind: 'unknown' },
        nullable: !isKey && booleanOf(argumentOf(column, 'nullable')) === true,
      }
      if (enumClass) {
        const values = enumClass.cases.map((item) => item.value ?? item.name)
        const enumName = toSnake(enumClass.name)
        if (!dbEnums.some((item) => item.name === enumName)) dbEnums.push({ name: enumName, values: values.map(String), storage: 'check' })
        if (!table.checks.some((check) => check.parsed?.kind === 'in' && check.parsed.column === name))
          table.checks.push(checkOf(`${name} IN (${quoted(values)})`))
      }
      const defaultValue = options.get('default')
      if (defaultValue) {
        const value = literalOf(defaultValue)
        const sql = typeof value === 'string' ? value.trim() : undefined
        if (sql !== undefined && NOW_SQL.test(sql)) dbColumn.generated = 'now'
        else if (sql !== undefined && UUID_SQL.test(sql)) dbColumn.generated = 'uuid'
        else if (value !== undefined) dbColumn.default = { kind: 'literal', value }
        else if (defaultValue.kind === 'name' && defaultValue.path.length === 1 && defaultValue.path[0].toLowerCase() === 'null')
          dbColumn.default = { kind: 'literal', value: null }
      } else if (property.initializer) {
        // The value a new object starts with: a literal, or a case of its enum
        const value = literalOf(property.initializer)
        const initializer = property.initializer
        const enumCase =
          initializer.kind === 'name' && initializer.path.length === 2 && enumClass && initializer.path[0] === enumClass.name
            ? enumClass.cases.find((item) => item.name === initializer.path[1])
            : undefined
        if (value !== undefined) dbColumn.default = { kind: 'literal', value }
        else if (enumCase) dbColumn.default = { kind: 'literal', value: enumCase.value ?? enumCase.name }
      }
      const generatedValue = attributeOf(property.attributes, 'GeneratedValue')
      if (isKey && generatedValue) {
        const strategy = (stringOf(argumentOf(generatedValue, 'strategy', 0)) ?? 'AUTO').toUpperCase()
        if (strategy !== 'NONE' && strategy !== 'CUSTOM') dbColumn.generated = dbColumn.type.kind === 'uuid' ? 'uuid' : 'identity'
      }
      const generated = stringOf(argumentOf(column, 'generated'))
      const computed = definition ? /\bgenerated\s+always\s+as\s*\(([\s\S]*)\)\s*(stored|virtual)?\s*$/i.exec(definition)?.[1] : undefined
      if (generated?.toUpperCase() === 'ALWAYS' && computed) dbColumn.generated = { computed: computed.trim() }
      const columnComment = stringOf(options.get('comment'))
      if (columnComment) dbColumn.comment = columnComment
      const attribute = `${attributePrefix}${property.name}`
      if (name !== attribute) dbColumn.attribute = attribute
      table.columns.push(dbColumn)
      model.columns.set(attribute, name)
      if (isKey) primary.push(name)
      if (booleanOf(argumentOf(column, 'unique')) === true) table.uniques.push({ columns: [name] })
    }

    for (const property of model.properties) {
      if (attributeOf(property.attributes, ...RELATIONS)) continue
      addColumn(property, '', '')
    }
    if (primary.length > 0) table.primaryKey = primary

    // Indexes and unique constraints: on the class, or inside #[ORM\Table]
    const columnsOf = (attribute: Expr) => {
      const columns = stringsOf(argumentOf(attribute, 'columns'))
      return columns.length > 0 ? columns : stringsOf(argumentOf(attribute, 'fields')).map((field) => model.columns.get(field) ?? field)
    }
    const nested = (name: string) =>
      argumentOf(tableAttribute, name)?.kind === 'list' ? (argumentOf(tableAttribute, name) as Expr & { kind: 'list' }).items : []
    for (const index of [...cls.attributes.filter((item) => nameOf(item) === 'Index'), ...nested('indexes')]) {
      const columns = columnsOf(index)
      const name = stringOf(argumentOf(index, 'name'))
      const unique = stringsOf(argumentOf(index, 'flags')).includes('unique')
      if (columns.length > 0) (unique ? table.uniques : table.indexes).push({ ...(name ? { name } : {}), columns })
    }
    for (const unique of [...cls.attributes.filter((item) => nameOf(item) === 'UniqueConstraint'), ...nested('uniqueConstraints')]) {
      const columns = columnsOf(unique)
      const name = stringOf(argumentOf(unique, 'name'))
      if (columns.length > 0) table.uniques.push({ ...(name ? { name } : {}), columns })
    }
    models.push(model)
    byClass.set(cls.name, model)
  }

  const joins: DbTable[] = []
  const keyColumn = (target: Model, name: string | undefined, position: number) => {
    const column = name ?? target.table.primaryKey?.[position]
    return target.table.columns.find((item) => item.name === column)
  }
  for (const model of models) {
    const { table } = model
    for (const property of model.properties) {
      const relation = attributeOf(property.attributes, 'ManyToOne', 'OneToOne', 'ManyToMany')
      if (!relation || argumentOf(relation, 'mappedBy')) continue
      const target = byClass.get(classOf(argumentOf(relation, 'targetEntity', 0)) ?? simpleType(property.type))
      if (!target) continue
      const kind = nameOf(relation)
      const joinColumns = property.attributes.filter((item): item is Call => item.kind === 'call' && nameOf(item) === 'JoinColumn')
      if (kind === 'ManyToMany') {
        joins.push(joinTableOf(model, target, property, keyColumn))
        continue
      }
      const joinList: (Call | undefined)[] = joinColumns.length > 0 ? joinColumns : (target.table.primaryKey ?? []).map(() => undefined)
      const columns: string[] = []
      const references: string[] = []
      joinList.forEach((join, position) => {
        const parent = keyColumn(target, stringOf(argumentOf(join, 'referencedColumnName')), position)
        if (!parent) return
        const name = stringOf(argumentOf(join, 'name')) ?? `${property.name}_${parent.name}`
        const isKey = !!attributeOf(property.attributes, 'Id')
        if (!table.columns.some((item) => item.name === name)) {
          table.columns.push({ name, type: parent.type, nullable: !isKey && booleanOf(argumentOf(join, 'nullable')) !== false })
          if (isKey) table.primaryKey = [...(table.primaryKey ?? []), name]
        }
        if (booleanOf(argumentOf(join, 'unique')) === true) table.uniques.push({ columns: [name] })
        columns.push(name)
        references.push(parent.name)
      })
      if (columns.length === 0) continue
      const onDelete = ACTIONS[(stringOf(argumentOf(joinColumns[0], 'onDelete')) ?? '').toUpperCase()]
      const inverse = stringOf(argumentOf(relation, 'inversedBy'))
      table.foreignKeys.push({
        columns,
        references: { table: target.table.name, ...(target.table.schema ? { schema: target.table.schema } : {}), columns: references },
        ...(onDelete ? { onDelete } : {}),
        attribute: property.name,
        ...(inverse ? { inverse } : {}),
      })
      // The columns of a one-to-one relation are unique
      const same = (items: string[]) => items.length === columns.length && items.every((item) => columns.includes(item))
      if (kind === 'OneToOne' && !table.uniques.some((item) => same(item.columns)) && !same(table.primaryKey ?? []))
        table.uniques.push({ columns })
    }
  }
  // The other side of each relation: `#[ORM\OneToMany(mappedBy: 'order', …)]`
  for (const model of models)
    for (const property of model.properties) {
      const relation = attributeOf(property.attributes, 'OneToMany', 'OneToOne')
      const mappedBy = stringOf(argumentOf(relation, 'mappedBy'))
      if (!relation || !mappedBy) continue
      const target = byClass.get(classOf(argumentOf(relation, 'targetEntity', 0)) ?? simpleType(property.type))
      const key = target?.table.foreignKeys.find((item) => item.attribute === mappedBy)
      if (!key) continue
      if (!key.inverse) key.inverse = property.name
      // Rows the parent removes with it (cascade: ['remove'], orphanRemoval): deleted with their parent
      const cascades = stringsOf(argumentOf(relation, 'cascade'))
      if (
        !key.onDelete &&
        (cascades.includes('remove') || cascades.includes('all') || booleanOf(argumentOf(relation, 'orphanRemoval')) === true)
      )
        key.onDelete = 'cascade'
    }
  if (models.length > 0) notes.push({ code: 'orm.checksNotKept' })
  return {
    format: 'db-schema',
    version: 1,
    dialect,
    source: { kind: 'orm', format: 'doctrine' },
    tables: [...models.map((model) => model.table), ...joins],
    enums: dbEnums,
    notes,
  }
}

/** The join table of a `#[ORM\ManyToMany]`: as `#[ORM\JoinTable]` names it, or as Doctrine does
 * (`<source>_<target>` in lower case, with columns `<class>_<key>`), keyed by both and deleted with either row. */
function joinTableOf(
  model: Model,
  target: Model,
  property: Property,
  keyColumn: (target: Model, name: string | undefined, position: number) => DbColumn | undefined,
): DbTable {
  const joinTable = attributeOf(property.attributes, 'JoinTable')
  const table: DbTable = {
    name: stringOf(argumentOf(joinTable, 'name', 0)) ?? `${model.cls.name}_${target.cls.name}`.toLowerCase(),
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    indexes: [],
    checks: [],
    origin: { line: property.line, column: 1 },
  }
  const schema = stringOf(argumentOf(joinTable, 'schema'))
  if (schema) table.schema = schema
  const calls = (name: string) => property.attributes.filter((item): item is Call => item.kind === 'call' && nameOf(item) === name)
  const sides = [
    [calls('JoinColumn'), model],
    [calls('InverseJoinColumn'), target],
  ] as const
  for (const [given, side] of sides) {
    const count = given.length > 0 ? given.length : (side.table.primaryKey?.length ?? 0)
    for (let position = 0; position < count; position++) {
      const join = given[position]
      const parent = keyColumn(side, stringOf(argumentOf(join, 'referencedColumnName')), position)
      if (!parent) continue
      const name = stringOf(argumentOf(join, 'name')) ?? `${side.cls.name.toLowerCase()}_${parent.name}`
      table.columns.push({ name, type: parent.type, nullable: false })
      table.primaryKey!.push(name)
      table.indexes.push({ columns: [name] })
      const onDelete = ACTIONS[(stringOf(argumentOf(join, 'onDelete')) ?? 'CASCADE').toUpperCase()]
      table.foreignKeys.push({
        columns: [name],
        references: { table: side.table.name, ...(side.table.schema ? { schema: side.table.schema } : {}), columns: [parent.name] },
        ...(onDelete ? { onDelete } : {}),
      })
    }
  }
  return table
}

export const doctrineReader: OrmReader = {
  id: 'doctrine',
  label: 'Doctrine',
  language: 'php',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\bDoctrine\\ORM\\Mapping\b/.test(text) && /#\[(ORM\\)?Entity\b/.test(text) ? 1 : 0
  },
  read: readDoctrine,
}
