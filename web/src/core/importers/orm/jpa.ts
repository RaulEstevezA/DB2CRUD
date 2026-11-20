/**
 * Reads JPA entities (Jakarta Persistence, also with Hibernate's annotations, as Spring Data JPA uses them) into the
 * physical schema: classes marked `@Entity`, the fields of their `@MappedSuperclass` bases and of their
 * `@Embeddable` parts, `@Table` with its indexes, unique and check constraints, `@Column` and the type of each field
 * (or its `columnDefinition`, or Hibernate's `@JdbcTypeCode`), keys (`@Id`, `@IdClass`, `@EmbeddedId`), generated
 * values, Hibernate's `@ColumnDefault`, `@Check`, `@OnDelete` and `@Comment`, foreign keys of `@ManyToOne` and
 * `@OneToOne`, join tables of `@ManyToMany`, and Java enums with the values the database keeps (by name, by a
 * converter, or by position). Names nobody gave follow JPA's defaults: the class and the field as written. The
 * engine is the one the JDBC URLs in the code name, when they name only one.
 */
import { toSnakeCase } from '../../model/naming.ts'
import { checkOf } from '../../schema/checks.ts'
import type { DbColumn, DbEnum, DbNote, DbSchema, DbTable, DbType, Dialect, ReferentialAction } from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { JAVA_LEXER } from '../code/java.ts'
import { booleanOf, literalOf, nameOf, numberOf, readArguments, readExpression, stringOf, textOf, type Expr } from './expressions.ts'
import { sqlTypeOf } from './sqlTypes.ts'
import type { OrmReader, SourceFile } from './types.ts'

const SYNTAX = { named: '=' } as const

type Call = Expr & { kind: 'call' }

interface Field {
  name: string
  /** The Java type as written: `List<OrderLine>` */
  type: string
  annotations: Expr[]
  modifiers: Set<string>
  /** The value it starts with: `= true` */
  initializer?: Expr
  line: number
}

interface JavaClass {
  name: string
  kind: string
  annotations: Expr[]
  base?: string
  /** `implements …` as written */
  implements: string
  fields: Field[]
  /** The constants of an enum, with their arguments */
  constants: { name: string; args: Expr[] }[]
  line: number
}

// Reading the declarations

/** `@Name` or `@Name(args)`, after its `@`: a name or a call. */
function readAnnotation(cursor: Cursor, source: string): Expr {
  const path = [cursor.next().value]
  while (cursor.is('.') && cursor.isIdent(1)) {
    cursor.next()
    path.push(cursor.next().value)
  }
  const callee: Expr = { kind: 'name', path }
  if (!cursor.is('(')) return callee
  cursor.next()
  const { args, named } = readArguments(cursor, source, SYNTAX, ')')
  return { kind: 'call', callee, args, named }
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'final',
  'abstract',
  'transient',
  'volatile',
  'synchronized',
  'native',
  'strictfp',
  'default',
  'sealed',
])
const DECLARATIONS = new Set(['class', 'interface', 'enum', 'record'])

/** Skips a type as written: `java.util.List<Map<String, Integer>>[]`. */
function skipType(cursor: Cursor): void {
  if (cursor.isIdent()) cursor.next()
  while (cursor.is('.') && cursor.isIdent(1)) {
    cursor.next()
    cursor.next()
  }
  if (cursor.is('<')) {
    let depth = 0
    while (!cursor.done) {
      const value = cursor.next().value
      if (value === '<') depth++
      else if (value === '>') depth--
      if (depth === 0) break
    }
  }
  while (cursor.is('[') && cursor.is(']', 1)) {
    cursor.next()
    cursor.next()
  }
}

/** Moves past a method or constructor: its parameters, `throws` and body. */
function skipMethod(cursor: Cursor): void {
  cursor.skipGroup()
  while (!cursor.done && !cursor.is('{') && !cursor.is(';') && !cursor.is('}')) cursor.next()
  if (cursor.is('{')) cursor.skipGroup()
  else cursor.eat(';')
}

function readDeclaration(cursor: Cursor, source: string, kind: string, annotations: Expr[], classes: JavaClass[]): void {
  const line = cursor.peek()?.line ?? 1
  const declaration: JavaClass = { name: cursor.next().value, kind, annotations, implements: '', fields: [], constants: [], line }
  // The header: type parameters, record components, `extends`, `implements`
  while (!cursor.done && !cursor.is('{')) {
    if (cursor.is('extends') && cursor.isIdent(1)) {
      cursor.next()
      declaration.base = cursor.next().value
    } else if (cursor.is('implements')) {
      const start = cursor.index + 1
      while (!cursor.done && !cursor.is('{')) cursor.next()
      declaration.implements = cursor.textBetween(source, start, cursor.index)
    } else if (cursor.is('(')) cursor.skipGroup()
    else cursor.next()
  }
  classes.push(declaration)
  cursor.next()
  if (kind === 'enum') {
    // The constants, up to the `;` that ends them or the end of the body
    while (!cursor.done && !cursor.is(';') && !cursor.is('}')) {
      if (cursor.is('@') && cursor.isIdent(1)) {
        cursor.next()
        readAnnotation(cursor, source)
        continue
      }
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const name = cursor.next().value
      let args: Expr[] = []
      if (cursor.is('(')) {
        cursor.next()
        args = readArguments(cursor, source, SYNTAX, ')').args
      }
      if (cursor.is('{')) cursor.skipGroup()
      declaration.constants.push({ name, args })
      cursor.eat(',')
    }
    cursor.eat(';')
  }
  readBody(cursor, source, declaration, classes)
}

function readBody(cursor: Cursor, source: string, declaration: JavaClass, classes: JavaClass[]): void {
  let annotations: Expr[] = []
  const modifiers = new Set<string>()
  const reset = () => {
    annotations = []
    modifiers.clear()
  }
  while (!cursor.done && !cursor.is('}')) {
    if (cursor.is('@') && cursor.isIdent(1) && !cursor.is('interface', 1)) {
      cursor.next()
      annotations.push(readAnnotation(cursor, source))
      continue
    }
    if (cursor.is(';')) {
      cursor.next()
      reset()
      continue
    }
    if (cursor.is('{')) {
      // An initializer block
      cursor.skipGroup()
      reset()
      continue
    }
    if (MODIFIERS.has(cursor.value()) && cursor.isIdent()) {
      modifiers.add(cursor.next().value)
      continue
    }
    if (DECLARATIONS.has(cursor.value()) && cursor.isIdent(1)) {
      const kind = cursor.next().value
      readDeclaration(cursor, source, kind, annotations, classes)
      cursor.eat('}')
      reset()
      continue
    }
    if (cursor.is('<')) {
      // The type parameters of a generic method
      skipType(cursor)
      continue
    }
    if (!cursor.isIdent()) {
      cursor.next()
      reset()
      continue
    }
    const typeStart = cursor.index
    skipType(cursor)
    const type = cursor.textBetween(source, typeStart, cursor.index)
    if (cursor.is('(')) {
      skipMethod(cursor)
      reset()
      continue
    }
    if (!cursor.isIdent()) {
      reset()
      continue
    }
    const name = cursor.next()
    if (cursor.is('(')) {
      skipMethod(cursor)
      reset()
      continue
    }
    const initializer = cursor.eat('=') ? readExpression(cursor, source, SYNTAX) : undefined
    cursor.skipUntil([';'])
    cursor.eat(';')
    declaration.fields.push({
      name: name.value,
      type,
      annotations,
      modifiers: new Set(modifiers),
      ...(initializer ? { initializer } : {}),
      line: name.line,
    })
    reset()
  }
}

function readClasses(files: SourceFile[]): JavaClass[] {
  const classes: JavaClass[] = []
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(file.text, JAVA_LEXER)
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    let annotations: Expr[] = []
    while (!cursor.done) {
      if (cursor.is('@') && cursor.isIdent(1) && !cursor.is('interface', 1)) {
        cursor.next()
        annotations.push(readAnnotation(cursor, file.text))
      } else if (DECLARATIONS.has(cursor.value()) && cursor.isIdent() && cursor.isIdent(1)) {
        const kind = cursor.next().value
        readDeclaration(cursor, file.text, kind, annotations, classes)
        cursor.eat('}')
        annotations = []
      } else if (cursor.is('package') || cursor.is('import')) {
        cursor.skipUntil([';'])
        cursor.eat(';')
      } else cursor.next()
    }
  }
  return classes
}

// Reading the annotations

const annotationOf = (annotations: Expr[], ...names: string[]): Expr | undefined =>
  annotations.find((item) => names.includes(nameOf(item) ?? ''))

/** An argument of an annotation: named, or `value` (the first one without a name). */
function argumentOf(annotation: Expr | undefined, name: string): Expr | undefined {
  if (annotation?.kind !== 'call') return undefined
  return annotation.named[name] ?? (name === 'value' ? annotation.args[0] : undefined)
}

/** The annotations an argument holds: one, or a list of them. */
const callsOf = (expr: Expr | undefined): Call[] =>
  (expr?.kind === 'list' ? expr.items : expr ? [expr] : []).filter((item): item is Call => item.kind === 'call')

const stringsOf = (expr: Expr | undefined): string[] =>
  (expr?.kind === 'list' ? expr.items : expr ? [expr] : [])
    .map((item) => stringOf(item))
    .filter((item): item is string => item !== undefined)

/** The simple name of a Java type: `java.util.List<OrderLine>` → `List`. */
const simpleType = (type: string) =>
  type
    .replace(/<[\s\S]*$/, '')
    .split('.')
    .at(-1)!
    .trim()

// Types

const JAVA_TYPES: Record<string, DbType['kind'] | [DbType['kind'], number]> = {
  Long: ['integer', 64],
  long: ['integer', 64],
  Integer: ['integer', 32],
  int: ['integer', 32],
  Short: ['integer', 16],
  short: ['integer', 16],
  Byte: ['integer', 16],
  byte: ['integer', 16],
  Double: ['float', 64],
  double: ['float', 64],
  Float: ['float', 32],
  float: ['float', 32],
  BigDecimal: 'decimal',
  BigInteger: 'decimal',
  Boolean: 'boolean',
  boolean: 'boolean',
  LocalDate: 'date',
  UUID: 'uuid',
  Blob: 'binary',
  Clob: 'text',
}

const PRIMITIVES = new Set(['long', 'int', 'short', 'byte', 'double', 'float', 'boolean', 'char'])

/** The types `@JdbcTypeCode(SqlTypes.…)` names. */
const JDBC_TYPES: Record<string, string> = {
  TINYINT: 'tinyint',
  SMALLINT: 'smallint',
  INTEGER: 'integer',
  BIGINT: 'bigint',
  REAL: 'real',
  FLOAT: 'float',
  DOUBLE: 'double',
  NUMERIC: 'numeric',
  DECIMAL: 'decimal',
  CHAR: 'char',
  NCHAR: 'char',
  VARCHAR: 'varchar',
  NVARCHAR: 'varchar',
  LONGVARCHAR: 'text',
  LONG32VARCHAR: 'text',
  CLOB: 'text',
  BOOLEAN: 'boolean',
  BIT: 'boolean',
  DATE: 'date',
  TIME: 'time',
  TIMESTAMP: 'timestamp',
  TIMESTAMP_WITH_TIMEZONE: 'timestamptz',
  TIMESTAMP_UTC: 'timestamptz',
  UUID: 'uuid',
  JSON: 'json',
  JSON_ARRAY: 'json',
  BINARY: 'binary',
  VARBINARY: 'varbinary',
  LONGVARBINARY: 'blob',
  BLOB: 'blob',
}

/** The type of a field from its Java type and its `@Column`. */
function javaTypeOf(field: Field, column: Expr | undefined, dialect: Dialect | null): DbType | null {
  const type = field.type.replace(/\s+/g, '')
  const name = simpleType(type)
  const sql = type
  const length = numberOf(argumentOf(column, 'length'))
  if (type === 'byte[]' || type === 'Byte[]') return { sql, kind: 'binary', ...(length !== undefined ? { length } : {}) }
  if (name === 'String') {
    if (annotationOf(field.annotations, 'Lob')) return { sql, kind: 'text' }
    return { sql, kind: 'text', length: length ?? 255 }
  }
  if (name === 'char' || name === 'Character') return { sql, kind: 'text', length: 1, fixed: true }
  if (name === 'LocalTime' || name === 'OffsetTime') return { sql, kind: 'time', timezone: name === 'OffsetTime' }
  if (name === 'LocalDateTime') return { sql, kind: 'datetime', timezone: false }
  if (name === 'OffsetDateTime' || name === 'ZonedDateTime' || name === 'Instant') return { sql, kind: 'datetime', timezone: true }
  if (name === 'Date' || name === 'Calendar' || name === 'Timestamp') {
    const temporal = nameOf(argumentOf(annotationOf(field.annotations, 'Temporal'), 'value'))
    if (temporal === 'DATE' || type === 'java.sql.Date') return { sql, kind: 'date' }
    if (temporal === 'TIME') return { sql, kind: 'time', timezone: false }
    return { sql, kind: 'datetime', timezone: false }
  }
  const known = JAVA_TYPES[name]
  if (!known) return null
  if (Array.isArray(known)) {
    const [kind, bits] = known
    if (kind === 'integer') return { sql, kind, bits: (dialect === 'sqlite' ? Math.max(bits, 32) : bits) as 16 | 32 | 64 }
    return { sql, kind: 'float', bits: bits as 32 | 64 }
  }
  if (known === 'decimal') {
    const precision = numberOf(argumentOf(column, 'precision'))
    const scale = numberOf(argumentOf(column, 'scale'))
    return { sql, kind: 'decimal', ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) }
  }
  return { sql, kind: known } as DbType
}

const NOW_SQL = /^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp|datetime\('now'\))$/i
const UUID_SQL = /^(gen_random_uuid|uuid_generate_v4|uuid|newid)\(\)$/i

/** A default written in SQL (`@ColumnDefault("1")`): a literal when it is one. */
function applyDefault(sql: string, column: DbColumn): void {
  const text = sql.trim()
  if (NOW_SQL.test(text)) column.generated = 'now'
  else if (UUID_SQL.test(text)) column.generated = 'uuid'
  else if (/^-?\d+(\.\d+)?$/.test(text)) column.default = { kind: 'literal', value: Number(text) }
  else if (/^'(?:[^']|'')*'$/.test(text)) column.default = { kind: 'literal', value: text.slice(1, -1).replace(/''/g, "'") }
  else if (/^(true|false)$/i.test(text)) column.default = { kind: 'literal', value: text.toLowerCase() === 'true' }
  else if (/^null$/i.test(text)) column.default = { kind: 'literal', value: null }
  else column.default = { kind: 'expression', sql: text }
}

const ACTIONS: Record<string, ReferentialAction> = {
  CASCADE: 'cascade',
  SET_NULL: 'set null',
  SET_DEFAULT: 'set default',
  RESTRICT: 'restrict',
  NO_ACTION: 'no action',
}

const DIALECTS: Record<string, Dialect> = {
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  sqlserver: 'sqlserver',
  oracle: 'oracle',
}

const quoted = (values: (string | number)[]) =>
  values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)).join(', ')

// Building the tables

interface Model {
  cls: JavaClass
  table: DbTable
  /** Column of each field */
  columns: Map<string, string>
  fields: Field[]
}

const RELATIONS = ['ManyToOne', 'OneToOne', 'OneToMany', 'ManyToMany', 'ElementCollection']

function readJpa(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const classes = readClasses(files)
  const byName = new Map(classes.map((cls) => [cls.name, cls]))
  const engines = new Set<string>()
  for (const file of files) for (const match of file.text.matchAll(/jdbc:(\w+):/g)) engines.add(match[1])
  const dialects = new Set([...engines].map((engine) => DIALECTS[engine]).filter((item): item is Dialect => !!item))
  const dialect = dialects.size === 1 ? [...dialects][0] : null
  const dbEnums: DbEnum[] = []

  // Converters that apply to every field of a type: `@Converter(autoApply = true) … AttributeConverter<Status, String>`
  const converters = new Map<string, JavaClass>()
  for (const cls of classes) {
    const match = /AttributeConverter\s*<\s*([\w.]+)\s*,/.exec(cls.implements)
    if (match) converters.set(cls.name, cls)
    if (match && booleanOf(argumentOf(annotationOf(cls.annotations, 'Converter'), 'autoApply')) === true)
      converters.set(`auto:${simpleType(match[1])}`, cls)
  }

  /** The fields of a class and of the `@MappedSuperclass` classes it extends. */
  const fieldsOf = (cls: JavaClass, seen = new Set<string>()): Field[] => {
    seen.add(cls.name)
    const base = cls.base ? byName.get(cls.base) : undefined
    const inherited = base && !seen.has(base.name) && annotationOf(base.annotations, 'MappedSuperclass') ? fieldsOf(base, seen) : []
    return [...inherited, ...cls.fields].filter(
      (field) => !field.modifiers.has('static') && !field.modifiers.has('transient') && !annotationOf(field.annotations, 'Transient'),
    )
  }

  /** The values the database keeps for a field typed with a Java enum, and how. */
  const enumOf = (field: Field, enumClass: JavaClass) => {
    const enumerated = nameOf(argumentOf(annotationOf(field.annotations, 'Enumerated'), 'value'))
    const convert = annotationOf(field.annotations, 'Convert')
    const converterName = simpleType(textOf(argumentOf(convert, 'converter') ?? { kind: 'other', text: '' }).replace(/\.class$/, ''))
    const converter = converters.get(converterName) ?? (enumerated ? undefined : converters.get(`auto:${enumClass.name}`))
    if (converter) {
      // A converter usually keeps the text each constant is built with
      const values = enumClass.constants.map((constant) => stringOf(constant.args[0]))
      return {
        values: values.every((value) => value !== undefined) ? (values as string[]) : enumClass.constants.map((item) => item.name),
        ordinal: false,
      }
    }
    if (enumerated === 'STRING') return { values: enumClass.constants.map((item) => item.name), ordinal: false }
    return { values: enumClass.constants.map((_item, index) => index), ordinal: true }
  }

  const models: Model[] = []
  const byClass = new Map<string, Model>()
  for (const cls of classes) {
    const entity = annotationOf(cls.annotations, 'Entity')
    if (!entity) continue
    const tableAnnotation = annotationOf(cls.annotations, 'Table')
    const table: DbTable = {
      name: stringOf(argumentOf(tableAnnotation, 'name')) ?? stringOf(argumentOf(entity, 'name')) ?? cls.name,
      columns: [],
      primaryKey: null,
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      entity: cls.name,
      origin: { line: cls.line, column: 1 },
    }
    const schema = stringOf(argumentOf(tableAnnotation, 'schema'))
    if (schema) table.schema = schema
    const comment = stringOf(argumentOf(annotationOf(cls.annotations, 'Comment'), 'value'))
    if (comment) table.comment = comment
    const model: Model = { cls, table, columns: new Map(), fields: fieldsOf(cls) }
    const primary: string[] = []
    const enumChecks: { column: string; values: (string | number)[] }[] = []

    const addColumn = (field: Field, overrides: Map<string, Expr>, key: boolean, prefix = ''): void => {
      const embeddable = byName.get(simpleType(field.type))
      if (
        (annotationOf(field.annotations, 'Embedded', 'EmbeddedId') || (embeddable && annotationOf(embeddable.annotations, 'Embeddable'))) &&
        embeddable
      ) {
        // The fields of an embedded part are columns of the table, renamed by @AttributeOverride
        const own = new Map(overrides)
        for (const override of callsOf(argumentOf(annotationOf(field.annotations, 'AttributeOverrides'), 'value')).concat(
          field.annotations.filter((item): item is Call => item.kind === 'call' && nameOf(item) === 'AttributeOverride'),
        )) {
          const name = stringOf(argumentOf(override, 'name'))
          const column = argumentOf(override, 'column')
          if (name && column) own.set(`${prefix}${field.name}.${name}`, column)
        }
        const isKey = key || !!annotationOf(field.annotations, 'EmbeddedId')
        for (const part of fieldsOf(embeddable)) addColumn(part, own, isKey, `${prefix}${field.name}.`)
        return
      }
      const columnAnnotation = overrides.get(`${prefix}${field.name}`) ?? annotationOf(field.annotations, 'Column')
      const name = stringOf(argumentOf(columnAnnotation, 'name')) ?? field.name
      const definition = stringOf(argumentOf(columnAnnotation, 'columnDefinition'))
      const jdbc = nameOf(argumentOf(annotationOf(field.annotations, 'JdbcTypeCode'), 'value'))
      const enumClass = byName.get(simpleType(field.type))
      let type: DbType | null = null
      if (definition) type = sqlTypeOf(definition.replace(/\s+(not\s+null|null|default\b.*|primary\s+key.*|unique.*)$/i, ''), dialect)
      else if (jdbc && JDBC_TYPES[jdbc]) {
        const base = sqlTypeOf(JDBC_TYPES[jdbc], dialect)
        const length = numberOf(argumentOf(columnAnnotation, 'length'))
        type = base?.kind === 'text' && JDBC_TYPES[jdbc] !== 'text' && length !== undefined ? { ...base, length } : base
        if (base?.kind === 'decimal') {
          const precision = numberOf(argumentOf(columnAnnotation, 'precision'))
          const scale = numberOf(argumentOf(columnAnnotation, 'scale'))
          type = { ...base, ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) }
        }
      } else if (enumClass?.kind === 'enum') {
        const { values, ordinal } = enumOf(field, enumClass)
        if (ordinal) type = { sql: field.type, kind: 'integer', bits: 16 }
        else {
          const length = numberOf(argumentOf(columnAnnotation, 'length'))
          type = { sql: field.type, kind: 'text', length: length ?? 255 }
          const enumName = toSnakeCase(enumClass.name)
          if (!dbEnums.some((item) => item.name === enumName))
            dbEnums.push({ name: enumName, values: values.map(String), storage: 'check' })
        }
        enumChecks.push({ column: name, values })
      } else type = javaTypeOf(field, columnAnnotation, dialect)
      if (definition && type) type = { ...type, sql: definition }
      if (!type) notes.push({ code: 'orm.unknownType', params: { table: table.name, column: name, type: definition ?? field.type } })
      const isKey = key || !!annotationOf(field.annotations, 'Id')
      const required =
        isKey ||
        PRIMITIVES.has(field.type.trim()) ||
        /\bnot\s+null\b/i.test(definition ?? '') ||
        booleanOf(argumentOf(columnAnnotation, 'nullable')) === false ||
        booleanOf(argumentOf(annotationOf(field.annotations, 'Basic'), 'optional')) === false ||
        !!annotationOf(field.annotations, 'NotNull', 'NonNull')
      const column: DbColumn = { name, type: type ?? { sql: definition ?? field.type, kind: 'unknown' }, nullable: !required }
      const columnDefault = stringOf(argumentOf(annotationOf(field.annotations, 'ColumnDefault'), 'value'))
      if (columnDefault !== undefined) applyDefault(columnDefault, column)
      else if (field.initializer) {
        // The value a new row starts with: a literal, or a constant of its enum
        const initializer = field.initializer
        const value = literalOf(initializer)
        const constant =
          initializer.kind === 'name' &&
          initializer.path.length === 2 &&
          enumClass?.kind === 'enum' &&
          initializer.path[0] === enumClass.name
            ? enumClass.constants.findIndex((item) => item.name === initializer.path[1])
            : -1
        if (value !== undefined) column.default = { kind: 'literal', value }
        else if (constant >= 0 && enumClass) column.default = { kind: 'literal', value: enumOf(field, enumClass).values[constant] }
      }
      const generatedValue = annotationOf(field.annotations, 'GeneratedValue')
      if (generatedValue) {
        const strategy = nameOf(argumentOf(generatedValue, 'strategy'))
        column.generated = strategy === 'UUID' || column.type.kind === 'uuid' ? 'uuid' : 'identity'
      }
      if (annotationOf(field.annotations, 'UuidGenerator')) column.generated = 'uuid'
      if (annotationOf(field.annotations, 'CreationTimestamp')) column.generated = 'now'
      if (annotationOf(field.annotations, 'UpdateTimestamp')) column.generated = 'onUpdateNow'
      const computed = stringOf(argumentOf(annotationOf(field.annotations, 'GeneratedColumn'), 'value'))
      if (computed) column.generated = { computed }
      if (column.generated === 'now' || column.generated === 'onUpdateNow' || column.generated === 'uuid') delete column.default
      const columnComment = stringOf(argumentOf(annotationOf(field.annotations, 'Comment'), 'value'))
      if (columnComment) column.comment = columnComment
      const attribute = `${prefix}${field.name}`
      if (name !== attribute) column.attribute = attribute
      table.columns.push(column)
      model.columns.set(attribute, name)
      if (isKey) primary.push(name)
      if (booleanOf(argumentOf(columnAnnotation, 'unique')) === true) table.uniques.push({ columns: [name] })
      const check = stringOf(argumentOf(annotationOf(field.annotations, 'Check'), 'constraints'))
      if (check) table.checks.push(checkOf(check))
    }

    for (const field of model.fields) {
      if (annotationOf(field.annotations, ...RELATIONS)) continue
      addColumn(field, new Map(), false)
    }
    if (primary.length > 0) table.primaryKey = primary

    // The constraints of @Table, and Hibernate's @Check
    for (const index of callsOf(argumentOf(tableAnnotation, 'indexes'))) {
      const columns = (stringOf(argumentOf(index, 'columnList')) ?? '')
        .split(',')
        .map((item) => item.trim().replace(/\s+(asc|desc)$/i, ''))
        .filter(Boolean)
      if (columns.length === 0) continue
      const name = stringOf(argumentOf(index, 'name'))
      const target = booleanOf(argumentOf(index, 'unique')) === true ? table.uniques : table.indexes
      target.push({ ...(name ? { name } : {}), columns })
    }
    for (const unique of callsOf(argumentOf(tableAnnotation, 'uniqueConstraints'))) {
      const columns = stringsOf(argumentOf(unique, 'columnNames'))
      const name = stringOf(argumentOf(unique, 'name'))
      if (columns.length > 0) table.uniques.push({ ...(name ? { name } : {}), columns })
    }
    for (const check of callsOf(argumentOf(tableAnnotation, 'check'))) {
      const sql = stringOf(argumentOf(check, 'constraint'))
      const name = stringOf(argumentOf(check, 'name'))
      if (sql) table.checks.push(checkOf(sql, name))
    }
    for (const check of cls.annotations.filter((item) => nameOf(item) === 'Check')) {
      const sql = stringOf(argumentOf(check, 'constraints'))
      const name = stringOf(argumentOf(check, 'name'))
      if (sql) table.checks.push(checkOf(sql, name))
    }
    // Hibernate checks the values of an enum: the CHECK of a column with none declared
    for (const { column, values } of enumChecks) {
      if (table.checks.some((check) => check.parsed?.kind === 'in' && check.parsed.column === column)) continue
      table.checks.push(checkOf(`${column} IN (${quoted(values)})`))
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
    for (const field of model.fields) {
      const relation = annotationOf(field.annotations, 'ManyToOne', 'OneToOne', 'ManyToMany')
      if (!relation) continue
      const kind = nameOf(relation)
      const generic = /<\s*([\w.]+)\s*>/.exec(field.type)?.[1]
      const target = byClass.get(simpleType(stringOf(argumentOf(relation, 'targetEntity')) ?? generic ?? field.type))
      if (!target || argumentOf(relation, 'mappedBy')) continue
      if (kind === 'ManyToMany') {
        joins.push(joinTableOf(model, target, field, annotationOf(field.annotations, 'JoinTable'), keyColumn))
        continue
      }
      const joinColumns = annotationOf(field.annotations, 'JoinColumns')
      const given = joinColumns ? callsOf(argumentOf(joinColumns, 'value')) : callsOf(annotationOf(field.annotations, 'JoinColumn'))
      const joinList: (Call | undefined)[] = given.length > 0 ? given : (target.table.primaryKey ?? []).map(() => undefined)
      const columns: string[] = []
      const references: string[] = []
      joinList.forEach((join, position) => {
        const parent = keyColumn(target, stringOf(argumentOf(join, 'referencedColumnName')), position)
        if (!parent) return
        const name = stringOf(argumentOf(join, 'name')) ?? `${field.name}_${parent.name}`
        if (!table.columns.some((item) => item.name === name)) {
          const optional = booleanOf(argumentOf(relation, 'optional')) !== false
          const nullable = booleanOf(argumentOf(join, 'nullable')) ?? optional
          table.columns.push({ name, type: parent.type, nullable: nullable && !annotationOf(field.annotations, 'Id') })
          if (annotationOf(field.annotations, 'Id')) table.primaryKey = [...(table.primaryKey ?? []), name]
        }
        columns.push(name)
        references.push(parent.name)
      })
      if (columns.length === 0) continue
      const foreignKey = argumentOf(given[0], 'foreignKey')
      const constraint = stringOf(argumentOf(foreignKey, 'name'))
      const action = nameOf(argumentOf(annotationOf(field.annotations, 'OnDelete'), 'action'))
      const onDelete = ACTIONS[action ?? '']
      table.foreignKeys.push({
        ...(constraint ? { name: constraint } : {}),
        columns,
        references: { table: target.table.name, ...(target.table.schema ? { schema: target.table.schema } : {}), columns: references },
        ...(onDelete ? { onDelete } : {}),
        attribute: field.name,
      })
      // The columns of a one-to-one relation are unique
      const same = (items: string[]) => items.length === columns.length && items.every((item) => columns.includes(item))
      if (kind === 'OneToOne' && !table.uniques.some((item) => same(item.columns)) && !same(table.primaryKey ?? []))
        table.uniques.push({ columns })
    }
  }
  // The other side of each relation: `@OneToMany(mappedBy = "order")` names the foreign key of Order.order
  for (const model of models)
    for (const field of model.fields) {
      const relation = annotationOf(field.annotations, 'OneToMany', 'OneToOne')
      const mappedBy = stringOf(argumentOf(relation, 'mappedBy'))
      if (!relation || !mappedBy) continue
      const generic = /<\s*([\w.]+)\s*>/.exec(field.type)?.[1]
      const target = byClass.get(simpleType(stringOf(argumentOf(relation, 'targetEntity')) ?? generic ?? field.type))
      const key = target?.table.foreignKeys.find((item) => item.attribute === mappedBy)
      if (!key) continue
      if (!key.inverse) key.inverse = field.name
      // Rows the parent removes with it (cascade = ALL or REMOVE, orphanRemoval): deleted with their parent
      const cascade = argumentOf(relation, 'cascade')
      const cascades = (cascade?.kind === 'list' ? cascade.items : cascade ? [cascade] : []).map((item) => nameOf(item))
      if (
        !key.onDelete &&
        (cascades.includes('ALL') || cascades.includes('REMOVE') || booleanOf(argumentOf(relation, 'orphanRemoval')) === true)
      )
        key.onDelete = 'cascade'
    }
  return {
    format: 'db-schema',
    version: 1,
    dialect,
    source: { kind: 'orm', format: 'jpa' },
    tables: [...models.map((model) => model.table), ...joins],
    enums: dbEnums,
    notes,
  }
}

/** The join table of a `@ManyToMany`: as `@JoinTable` names it, or as JPA does (`<owner table>_<target table>`, with
 * columns `<side>_<key>`), keyed by both columns. */
function joinTableOf(
  model: Model,
  target: Model,
  field: Field,
  joinTable: Expr | undefined,
  keyColumn: (target: Model, name: string | undefined, position: number) => DbColumn | undefined,
): DbTable {
  const table: DbTable = {
    name: stringOf(argumentOf(joinTable, 'name')) ?? `${model.table.name}_${target.table.name}`,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    indexes: [],
    checks: [],
    origin: { line: field.line, column: 1 },
  }
  const schema = stringOf(argumentOf(joinTable, 'schema'))
  if (schema) table.schema = schema
  // The field on the other side that maps this relation names the owner's columns
  const inverse = target.fields.find(
    (item) => stringOf(argumentOf(annotationOf(item.annotations, 'ManyToMany'), 'mappedBy')) === field.name,
  )
  const sides = [
    [callsOf(argumentOf(joinTable, 'joinColumns')), model, inverse?.name ?? model.cls.name],
    [callsOf(argumentOf(joinTable, 'inverseJoinColumns')), target, field.name],
  ] as const
  for (const [given, side, prefix] of sides) {
    const count = given.length > 0 ? given.length : (side.table.primaryKey?.length ?? 0)
    for (let position = 0; position < count; position++) {
      const join = given[position]
      const parent = keyColumn(side, stringOf(argumentOf(join, 'referencedColumnName')), position)
      if (!parent) continue
      const name = stringOf(argumentOf(join, 'name')) ?? `${prefix}_${parent.name}`
      table.columns.push({ name, type: parent.type, nullable: false })
      table.primaryKey!.push(name)
      table.foreignKeys.push({
        columns: [name],
        references: { table: side.table.name, ...(side.table.schema ? { schema: side.table.schema } : {}), columns: [parent.name] },
      })
    }
  }
  return table
}

export const jpaReader: OrmReader = {
  id: 'jpa',
  label: 'JPA / Hibernate',
  language: 'java',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\b(jakarta|javax)\.persistence\b/.test(text) && /@Entity\b/.test(text) ? 1 : 0
  },
  read: readJpa,
}
