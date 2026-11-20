/**
 * Reads EF Core models into the physical schema: the entity classes (the `DbSet<…>` of a context, or the types
 * `Entity<…>` configures) with their properties and data annotations (`[Table]`, `[Column]`, `[Key]`, `[Required]`,
 * `[MaxLength]`, `[Precision]`, `[Index]`, `[ForeignKey]`, `[NotMapped]`…), and the fluent API of `OnModelCreating`
 * or of `IEntityTypeConfiguration<…>` (`ToTable`, `HasKey`, `Property(…)` with its column, type, length, defaults and
 * generated values, `HasIndex`, `HasAlternateKey`, check constraints, `HasOne`/`HasMany` relations with their keys
 * and delete behaviour). What the code leaves out follows EF Core's conventions: the table is the `DbSet` name, the
 * key is `Id` (numbered when it is an integer), a required relation deletes in cascade. The engine is the provider the
 * code uses (`UseNpgsql`, `UseSqlite`…), when it uses only one.
 */
import { checkOf } from '../../schema/checks.ts'
import type { DbColumn, DbEnum, DbForeignKey, DbNote, DbSchema, DbTable, DbType, Dialect, ReferentialAction } from '../../schema/types.ts'
import { CSHARP_LEXER } from '../code/csharp.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { booleanOf, literalOf, nameOf, numberOf, readArguments, readExpression, stringOf, textOf, type Expr } from './expressions.ts'
import { sqlTypeOf } from './sqlTypes.ts'
import type { OrmReader, SourceFile } from './types.ts'

/** C# names its arguments with `name: value`, and the properties of an attribute with `Name = value`. */
const SYNTAX = { named: ':' } as const
const ATTRIBUTE_SYNTAX = { named: '=' } as const

type Call = Expr & { kind: 'call' }

interface Property {
  name: string
  /** The C# type as written: `string?`, `List<OrderLine>` */
  type: string
  attributes: Call[]
  /** It has a setter (`set` or `init`): EF Core maps only those */
  settable: boolean
  line: number
}

interface CsClass {
  name: string
  kind: string
  attributes: Call[]
  /** The base types after `:`, as written */
  bases: string
  properties: Property[]
  /** The members of an enum with their values */
  members: { name: string; value: number }[]
  line: number
}

// Reading the declarations

/** `[Key, MaxLength(20)]`, after its `[`: each attribute as a call. */
function readAttributes(cursor: Cursor, source: string): Call[] {
  const attributes: Call[] = []
  // `[return: …]`, `[assembly: …]`
  if (cursor.isIdent() && cursor.is(':', 1)) {
    cursor.next()
    cursor.next()
  }
  while (!cursor.done && !cursor.is(']')) {
    if (!cursor.isIdent()) {
      cursor.next()
      continue
    }
    const path = [cursor.next().value]
    while (cursor.is('.') && cursor.isIdent(1)) {
      cursor.next()
      path.push(cursor.next().value)
    }
    const name = path.at(-1)!.replace(/Attribute$/, '')
    let args: Expr[] = []
    let named: Record<string, Expr> = {}
    if (cursor.is('(')) {
      cursor.next()
      // `[Index(nameof(Name), IsUnique = true)]`: the properties of an attribute take `=`
      ;({ args, named } = readArguments(cursor, source, ATTRIBUTE_SYNTAX, ')'))
    }
    attributes.push({ kind: 'call', callee: { kind: 'name', path: [name] }, args, named })
    cursor.eat(',')
  }
  cursor.eat(']')
  return attributes
}

const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'readonly',
  'virtual',
  'override',
  'abstract',
  'sealed',
  'partial',
  'required',
  'new',
  'const',
  'unsafe',
  'extern',
  'async',
  'volatile',
  'file',
])
const DECLARATIONS = new Set(['class', 'record', 'struct', 'interface', 'enum'])

/** Skips a type as written: `Dictionary<string, List<int>>?[]`. */
function skipType(cursor: Cursor): void {
  if (cursor.is('(')) {
    // A tuple
    cursor.skipGroup()
  } else {
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
  }
  while (cursor.is('?') || (cursor.is('[') && cursor.is(']', 1))) {
    if (cursor.eat('?')) continue
    cursor.next()
    cursor.next()
  }
}

/** Moves past the rest of a member: up to its `;` or past its body. */
function skipMember(cursor: Cursor): void {
  while (!cursor.done && !cursor.is(';') && !cursor.is('{') && !cursor.is('}')) {
    if (cursor.is('(') || cursor.is('[')) cursor.skipGroup()
    else cursor.next()
  }
  if (cursor.is('{')) cursor.skipGroup()
  else cursor.eat(';')
}

function readDeclaration(cursor: Cursor, source: string, kind: string, attributes: Call[], classes: CsClass[]): void {
  const line = cursor.peek()?.line ?? 1
  const declaration: CsClass = { name: cursor.next().value, kind, attributes, bases: '', properties: [], members: [], line }
  while (!cursor.done && !cursor.is('{') && !cursor.is(';')) {
    if (cursor.is(':')) {
      const start = cursor.index + 1
      while (!cursor.done && !cursor.is('{') && !cursor.is(';') && !cursor.is('where')) {
        if (cursor.is('(')) cursor.skipGroup()
        else cursor.next()
      }
      declaration.bases = cursor.textBetween(source, start, cursor.index)
    } else if (cursor.is('(')) cursor.skipGroup()
    else cursor.next()
  }
  classes.push(declaration)
  if (!cursor.eat('{')) {
    cursor.eat(';')
    return
  }
  if (kind === 'enum') {
    let next = 0
    while (!cursor.done && !cursor.is('}')) {
      if (cursor.is('[')) {
        cursor.skipGroup()
        continue
      }
      if (!cursor.isIdent()) {
        cursor.next()
        continue
      }
      const name = cursor.next().value
      if (cursor.eat('=')) {
        const value = numberOf(readExpression(cursor, source, SYNTAX))
        if (value !== undefined) next = value
      }
      declaration.members.push({ name, value: next })
      next++
      cursor.eat(',')
    }
    cursor.eat('}')
    return
  }
  readBody(cursor, source, declaration, classes)
  cursor.eat('}')
}

function readBody(cursor: Cursor, source: string, declaration: CsClass, classes: CsClass[]): void {
  let attributes: Call[] = []
  while (!cursor.done && !cursor.is('}')) {
    if (cursor.is('[')) {
      cursor.next()
      attributes.push(...readAttributes(cursor, source))
      continue
    }
    if (MODIFIERS.has(cursor.value()) && cursor.isIdent()) {
      cursor.next()
      continue
    }
    if (DECLARATIONS.has(cursor.value()) && cursor.isIdent(1)) {
      const kind = cursor.next().value
      readDeclaration(cursor, source, kind, attributes, classes)
      attributes = []
      continue
    }
    if (!cursor.isIdent() && !cursor.is('(')) {
      if (cursor.is('{')) cursor.skipGroup()
      else cursor.next()
      attributes = []
      continue
    }
    const typeStart = cursor.index
    skipType(cursor)
    const type = cursor.textBetween(source, typeStart, cursor.index).replace(/\s+/g, '')
    if (!cursor.isIdent()) {
      // A constructor (`Name(…)`) or an operator
      skipMember(cursor)
      attributes = []
      continue
    }
    const name = cursor.next()
    if (cursor.is('{')) {
      // A property with accessors: `{ get; set; }`, maybe followed by `= value;`
      const start = cursor.index
      cursor.skipGroup()
      const accessors = cursor.textBetween(source, start, cursor.index)
      if (cursor.eat('=')) cursor.skipUntil([';'])
      cursor.eat(';')
      declaration.properties.push({ name: name.value, type, attributes, settable: /\b(set|init)\b/.test(accessors), line: name.line })
    } else skipMember(cursor)
    attributes = []
  }
}

function readClasses(files: SourceFile[]): CsClass[] {
  const classes: CsClass[] = []
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(file.text, CSHARP_LEXER)
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    let attributes: Call[] = []
    while (!cursor.done) {
      if (cursor.is('[')) {
        cursor.next()
        attributes.push(...readAttributes(cursor, file.text))
      } else if (DECLARATIONS.has(cursor.value()) && cursor.isIdent() && cursor.isIdent(1)) {
        const kind = cursor.next().value
        readDeclaration(cursor, file.text, kind, attributes, classes)
        attributes = []
      } else if (cursor.is('using') || cursor.is('namespace')) {
        cursor.skipUntil([';', '{'])
        cursor.eat(';')
        cursor.eat('{')
      } else if (MODIFIERS.has(cursor.value())) cursor.next()
      else {
        cursor.next()
        if (!cursor.is('[')) attributes = []
      }
    }
  }
  return classes
}

// Reading the fluent API

/** A call of a fluent chain: `HasOne<Category>()`, `HasColumnName("id")`. */
interface Step {
  name: string
  /** The type between `<>`: `Category` */
  generic?: string
  args: Expr[]
  named: Record<string, Expr>
}

/** The chain after `builder.`: each call with its type argument and arguments, up to the end of the statement. */
function readChain(cursor: Cursor, source: string): Step[] {
  const steps: Step[] = []
  while (cursor.isIdent()) {
    const name = cursor.next().value
    let generic: string | undefined
    if (cursor.is('<')) {
      const start = cursor.index + 1
      let depth = 0
      while (!cursor.done) {
        const value = cursor.next().value
        if (value === '<') depth++
        else if (value === '>') depth--
        if (depth === 0) break
      }
      generic = cursor.textBetween(source, start, cursor.index - 1).trim()
    }
    let args: Expr[] = []
    let named: Record<string, Expr> = {}
    if (cursor.is('(')) {
      cursor.next()
      ;({ args, named } = readArguments(cursor, source, SYNTAX, ')'))
    }
    steps.push({ name, ...(generic ? { generic } : {}), args, named })
    if (!cursor.eat('.')) break
  }
  return steps
}

/** The statements of a lambda's block that start with its parameter: `entity.Property(…)…;`. */
function readBlock(cursor: Cursor, source: string, parameter: string): Step[][] {
  const chains: Step[][] = []
  cursor.next()
  while (!cursor.done && !cursor.is('}')) {
    if (cursor.is(parameter) && cursor.is('.', 1) && cursor.isIdent(2)) {
      cursor.next()
      cursor.next()
      chains.push(readChain(cursor, source))
      cursor.skipUntil([';'])
      cursor.eat(';')
    } else if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
    else cursor.next()
  }
  cursor.eat('}')
  return chains
}

/** Every chain that configures an entity, by its class: `modelBuilder.Entity<X>(e => { … })`,
 * `modelBuilder.Entity<X>().…;` and `Configure(EntityTypeBuilder<X> builder) { … }`. */
function readFluent(files: SourceFile[]): Map<string, Step[][]> {
  const chains = new Map<string, Step[][]>()
  const add = (entity: string, found: Step[][]) => chains.set(entity, [...(chains.get(entity) ?? []), ...found])
  for (const file of files) {
    let tokens: Token[]
    try {
      tokens = tokenize(file.text, CSHARP_LEXER)
    } catch {
      continue
    }
    const cursor = new Cursor(tokens)
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      const genericEntity =
        tokens[index + 1]?.value === '<' && tokens[index + 2]?.kind === 'ident' && tokens[index + 3]?.value === '>'
          ? tokens[index + 2].value
          : undefined
      if (token.value === 'Entity' && tokens[index - 1]?.value === '.' && genericEntity && tokens[index + 4]?.value === '(') {
        cursor.index = index + 5
        if (cursor.isIdent() && cursor.is('=>', 1)) {
          // Entity<X>(entity => { … }) or Entity<X>(entity => entity.…)
          const parameter = cursor.next().value
          cursor.next()
          if (cursor.is('{')) add(genericEntity, readBlock(cursor, file.text, parameter))
          else if (cursor.is(parameter) && cursor.is('.', 1)) {
            cursor.next()
            cursor.next()
            add(genericEntity, [readChain(cursor, file.text)])
          }
        } else if (cursor.is(')') && cursor.is('.', 1)) {
          cursor.next()
          cursor.next()
          add(genericEntity, [readChain(cursor, file.text)])
        }
      } else if (token.value === 'EntityTypeBuilder' && genericEntity && tokens[index + 4]?.kind === 'ident') {
        // Configure(EntityTypeBuilder<X> builder) { … }
        const parameter = tokens[index + 4].value
        cursor.index = index + 5
        cursor.eat(')')
        if (cursor.is('{')) add(genericEntity, readBlock(cursor, file.text, parameter))
      }
    }
  }
  return chains
}

// The properties a lambda names

/** `e => e.Id` → [Id]; `e => new { e.OrderId, e.Line }` → [OrderId, Line]; `"Id"` → [Id]. */
function propertiesOf(args: Expr[]): string[] {
  const names: string[] = []
  for (const arg of args) {
    const text = stringOf(arg)
    if (text !== undefined) names.push(text)
    else if (arg.kind === 'other') {
      const body = arg.text.replace(/^[^=]*=>/, '')
      names.push(...[...body.matchAll(/\.\s*(\w+)/g)].map((match) => match[1]))
    } else if (arg.kind === 'call' && nameOf(arg) === 'nameof') names.push(nameOf(arg.args[0]) ?? '')
  }
  return names.filter(Boolean)
}

// Types

const CS_TYPES: Record<string, DbType> = {
  long: { sql: 'long', kind: 'integer', bits: 64 },
  Int64: { sql: 'long', kind: 'integer', bits: 64 },
  int: { sql: 'int', kind: 'integer', bits: 32 },
  Int32: { sql: 'int', kind: 'integer', bits: 32 },
  short: { sql: 'short', kind: 'integer', bits: 16 },
  Int16: { sql: 'short', kind: 'integer', bits: 16 },
  byte: { sql: 'byte', kind: 'integer', bits: 16 },
  sbyte: { sql: 'sbyte', kind: 'integer', bits: 16 },
  double: { sql: 'double', kind: 'float', bits: 64 },
  Double: { sql: 'double', kind: 'float', bits: 64 },
  float: { sql: 'float', kind: 'float', bits: 32 },
  Single: { sql: 'float', kind: 'float', bits: 32 },
  decimal: { sql: 'decimal', kind: 'decimal' },
  Decimal: { sql: 'decimal', kind: 'decimal' },
  bool: { sql: 'bool', kind: 'boolean' },
  Boolean: { sql: 'bool', kind: 'boolean' },
  string: { sql: 'string', kind: 'text' },
  String: { sql: 'string', kind: 'text' },
  DateTime: { sql: 'DateTime', kind: 'datetime', timezone: false },
  DateTimeOffset: { sql: 'DateTimeOffset', kind: 'datetime', timezone: true },
  DateOnly: { sql: 'DateOnly', kind: 'date' },
  TimeOnly: { sql: 'TimeOnly', kind: 'time', timezone: false },
  TimeSpan: { sql: 'TimeSpan', kind: 'time', timezone: false },
  Guid: { sql: 'Guid', kind: 'uuid' },
  'byte[]': { sql: 'byte[]', kind: 'binary' },
  char: { sql: 'char', kind: 'text', length: 1, fixed: true },
}

/** The type without `?` and namespaces: `System.DateTime?` → `DateTime`. */
const bareType = (type: string) => type.replace(/\?$/, '').replace(/^(global::)?([\w]+\.)+(?=\w)/, '')

/** The element type of a collection navigation: `List<OrderLine>` → `OrderLine`. */
const elementType = (type: string) =>
  /^(?:I?List|I?Collection|ICollection|IEnumerable|HashSet|ISet|IReadOnlyCollection|IReadOnlyList)<\s*([\w.]+)\s*>\??$/.exec(type)?.[1]

const NOW_SQL = /^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp|getdate\(\)|getutcdate\(\)|sysdatetime\(\)|datetime\('now'\))$/i
const UUID_SQL = /^(gen_random_uuid|uuid_generate_v4|uuid|newid|newsequentialid)\(\)$/i

const DELETE_BEHAVIOURS: Record<string, ReferentialAction | undefined> = {
  Cascade: 'cascade',
  Restrict: 'restrict',
  NoAction: 'no action',
  SetNull: 'set null',
  ClientSetNull: undefined,
  ClientCascade: undefined,
  ClientNoAction: undefined,
}

const PROVIDERS: [RegExp, Dialect][] = [
  [/\bUseNpgsql\b|\bNpgsql\.EntityFrameworkCore\b/, 'postgresql'],
  [/\bMariaDbServerVersion\b/, 'mariadb'],
  [/\bUseMySql\b|\bUseMySQL\b|\bPomelo\.EntityFrameworkCore\.MySql\b|\bMySql\.EntityFrameworkCore\b/, 'mysql'],
  [/\bUseSqlite\b|\bMicrosoft\.EntityFrameworkCore\.Sqlite\b/, 'sqlite'],
  [/\bUseSqlServer\b|\bMicrosoft\.EntityFrameworkCore\.SqlServer\b/, 'sqlserver'],
  [/\bUseOracle\b|\bOracle\.EntityFrameworkCore\b/, 'oracle'],
]

const quoted = (values: (string | number)[]) =>
  values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)).join(', ')

/** What the fluent API says about a property. */
interface PropertyConfig {
  steps: Step[]
}

const stepOf = (steps: Step[], ...names: string[]) => steps.find((step) => names.includes(step.name))
const attributeOf = (attributes: Call[], ...names: string[]) => attributes.find((item) => names.includes(nameOf(item) ?? ''))

// Building the tables

interface Model {
  cls: CsClass
  table: DbTable
  /** Column of each property */
  columns: Map<string, string>
  properties: Property[]
  chains: Step[][]
}

function readEfCore(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const classes = readClasses(files)
  const byName = new Map(classes.map((cls) => [cls.name, cls]))
  const fluent = readFluent(files)
  const text = files.map((file) => file.text).join('\n')
  const dialects = PROVIDERS.filter(([pattern]) => pattern.test(text)).map(([, dialect]) => dialect)
  // MariaDB is used through the MySQL provider
  const engines = new Set(dialects.includes('mariadb') ? dialects.filter((item) => item !== 'mysql') : dialects)
  const dialect = engines.size === 1 ? [...engines][0] : null
  const dbEnums: DbEnum[] = []

  // The entities: the DbSet<…> of the contexts (named by their property) and the types the fluent API configures
  const setNames = new Map<string, string>()
  for (const match of text.matchAll(/\bDbSet<\s*(\w+)\s*>\??\s+(\w+)/g)) if (!setNames.has(match[1])) setNames.set(match[1], match[2])
  const entityNames = [...new Set([...setNames.keys(), ...fluent.keys()])].filter((name) => byName.get(name)?.kind !== 'enum')
  const entityClasses = classes.filter((cls) => entityNames.includes(cls.name) && cls.kind !== 'enum')
  const isEntity = (type: string) => entityNames.includes(bareType(type))

  /** The properties of a class and of the classes it extends that are not entities. */
  const allProperties = (cls: CsClass, seen = new Set<string>()): Property[] => {
    seen.add(cls.name)
    const base = byName.get(cls.bases.split(',')[0]?.trim().replace(/<.*$/, '') ?? '')
    const inherited = base && !seen.has(base.name) && base.kind !== 'interface' ? allProperties(base, seen) : []
    return [...inherited, ...cls.properties]
  }

  /** The values the database keeps for a property typed with a C# enum, from its conversion. */
  const enumValues = (enumClass: CsClass, steps: Step[]): { values: (string | number)[]; text: boolean } => {
    const conversion = stepOf(steps, 'HasConversion')
    if (conversion?.generic === 'string') return { values: enumClass.members.map((item) => item.name), text: true }
    if (conversion) {
      // A conversion through a method: the text each member is written as (`OrderStatus.Paid => "paid"`)
      const arms = new Map(
        [...text.matchAll(new RegExp(String.raw`\b${enumClass.name}\.(\w+)\s*=>\s*"((?:[^"\\]|\\.)*)"`, 'g'))].map((match) => [
          match[1],
          match[2],
        ]),
      )
      if (enumClass.members.every((item) => arms.has(item.name)))
        return { values: enumClass.members.map((item) => arms.get(item.name)!), text: true }
    }
    return { values: enumClass.members.map((item) => item.value), text: false }
  }

  const models: Model[] = []
  const byClass = new Map<string, Model>()
  const neverGenerated = new Set<DbColumn>()
  for (const cls of entityClasses) {
    const chains = fluent.get(cls.name) ?? []
    const tableStep = chains.map((chain) => chain[0]).find((step) => step.name === 'ToTable')
    const tableAttribute = attributeOf(cls.attributes, 'Table')
    const table: DbTable = {
      name: stringOf(tableStep?.args[0]) ?? stringOf(tableAttribute?.args[0]) ?? setNames.get(cls.name) ?? cls.name,
      columns: [],
      primaryKey: null,
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      entity: cls.name,
      origin: { line: cls.line, column: 1 },
    }
    const schema = stringOf(tableStep?.named.schema) ?? stringOf(tableStep?.args[1]) ?? stringOf(tableAttribute?.named.Schema)
    if (schema) table.schema = schema
    const tableLambdas = (tableStep?.args ?? []).filter((arg) => arg.kind === 'other').map((arg) => textOf(arg))
    const lambdaComment = tableLambdas
      .map((item) => /HasComment\(\s*"((?:[^"\\]|\\.)*)"/.exec(item)?.[1])
      .find((item) => item !== undefined)
    const comment =
      stringOf(chains.find((chain) => chain[0].name === 'HasComment')?.[0].args[0]) ??
      (lambdaComment !== undefined ? (JSON.parse(`"${lambdaComment}"`) as string) : undefined) ??
      stringOf(attributeOf(cls.attributes, 'Comment')?.args[0])
    if (comment) table.comment = comment
    // Check constraints of ToTable(…, t => t.HasCheckConstraint(…)) and of the entity
    const checkTexts = [
      ...tableLambdas,
      ...chains
        .filter((chain) => chain[0].name === 'HasCheckConstraint')
        .map((chain) => `HasCheckConstraint(${chain[0].args.map(textOf).join(', ')})`),
    ]
    for (const source of checkTexts)
      for (const match of source.matchAll(/HasCheckConstraint\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g))
        table.checks.push(checkOf(JSON.parse(`"${match[2]}"`), JSON.parse(`"${match[1]}"`)))

    const ignored = new Set(chains.filter((chain) => chain[0].name === 'Ignore').flatMap((chain) => propertiesOf(chain[0].args)))
    const configs = new Map<string, PropertyConfig>()
    for (const chain of chains)
      if (chain[0].name === 'Property')
        for (const property of propertiesOf(chain[0].args)) {
          const config = configs.get(property) ?? { steps: [] }
          config.steps.push(...chain.slice(1))
          configs.set(property, config)
        }
    const all = allProperties(cls)
    const properties = all.filter(
      (property) =>
        property.settable &&
        !ignored.has(property.name) &&
        !attributeOf(property.attributes, 'NotMapped') &&
        !isEntity(property.type) &&
        !(elementType(property.type) && isEntity(elementType(property.type)!)),
    )
    const model: Model = { cls, table, columns: new Map(), properties, chains }

    // The key: HasKey, [Key], or the convention (Id, <Class>Id); HasNoKey or [Keyless] say there is none
    const keyChain = chains.find((chain) => chain[0].name === 'HasKey')
    const noKey = chains.some((chain) => chain[0].name === 'HasNoKey') || !!attributeOf(cls.attributes, 'Keyless')
    const keyProperties = noKey
      ? []
      : keyChain
        ? propertiesOf(keyChain[0].args)
        : properties.filter((property) => attributeOf(property.attributes, 'Key')).map((property) => property.name).length > 0
          ? properties.filter((property) => attributeOf(property.attributes, 'Key')).map((property) => property.name)
          : properties
              .filter((property) => property.name.toLowerCase() === 'id' || property.name.toLowerCase() === `${cls.name.toLowerCase()}id`)
              .slice(0, 1)
              .map((property) => property.name)

    for (const property of properties) {
      const steps = configs.get(property.name)?.steps ?? []
      const columnAttribute = attributeOf(property.attributes, 'Column')
      const name = stringOf(stepOf(steps, 'HasColumnName')?.args[0]) ?? stringOf(columnAttribute?.args[0]) ?? property.name
      const columnType = stringOf(stepOf(steps, 'HasColumnType')?.args[0]) ?? stringOf(columnAttribute?.named.TypeName)
      const maxLength =
        numberOf(stepOf(steps, 'HasMaxLength')?.args[0]) ?? numberOf(attributeOf(property.attributes, 'MaxLength', 'StringLength')?.args[0])
      const precisionStep = stepOf(steps, 'HasPrecision')
      const precisionAttribute = attributeOf(property.attributes, 'Precision')
      const precision = numberOf(precisionStep?.args[0]) ?? numberOf(precisionAttribute?.args[0])
      const scale = numberOf(precisionStep?.args[1]) ?? numberOf(precisionAttribute?.args[1])
      const bare = bareType(property.type)
      const enumClass = byName.get(bare)
      let type: DbType | null = null
      if (columnType) {
        type = sqlTypeOf(columnType, dialect)
        if (type?.kind === 'text' && type.length === undefined && maxLength !== undefined) type = { ...type, length: maxLength }
        if (type) type = { ...type, sql: columnType }
      } else if (enumClass?.kind === 'enum') {
        const { values, text: asText } = enumValues(enumClass, steps)
        type = asText
          ? { sql: property.type, kind: 'text', ...(maxLength !== undefined ? { length: maxLength } : {}) }
          : { sql: property.type, kind: 'integer', bits: 32 }
        if (asText) {
          const enumName = toSnake(enumClass.name)
          if (!dbEnums.some((item) => item.name === enumName))
            dbEnums.push({ name: enumName, values: values.map(String), storage: 'check' })
        }
        if (!table.checks.some((check) => check.parsed?.kind === 'in' && check.parsed.column === name))
          table.checks.push(checkOf(`${name} IN (${quoted(values)})`))
      } else if (CS_TYPES[bare]) {
        const base = CS_TYPES[bare]
        type = { ...base, sql: property.type }
        if (type.kind === 'text' && maxLength !== undefined) type = { ...type, length: maxLength }
        if (type.kind === 'text' && stepOf(steps, 'IsFixedLength')) type = { ...type, fixed: true }
        if (type.kind === 'binary' && maxLength !== undefined) type = { ...type, length: maxLength }
        if (type.kind === 'decimal')
          type = { ...type, ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) }
      }
      if (!type) notes.push({ code: 'orm.unknownType', params: { table: table.name, column: name, type: columnType ?? property.type } })
      const isKey = keyProperties.includes(property.name)
      const requiredStep = stepOf(steps, 'IsRequired')
      const required = requiredStep ? booleanOf(requiredStep.args[0]) !== false : undefined
      const optionalType = property.type.endsWith('?')
      const nullable = isKey
        ? false
        : required !== undefined
          ? !required
          : attributeOf(property.attributes, 'Required')
            ? false
            : optionalType
      const column: DbColumn = { name, type: type ?? { sql: columnType ?? property.type, kind: 'unknown' }, nullable }
      const defaultValue = stepOf(steps, 'HasDefaultValue')?.args[0]
      if (defaultValue) {
        const value = literalOf(defaultValue)
        if (defaultValue.kind === 'name' && defaultValue.path.length === 2 && enumClass?.kind === 'enum') {
          const { values } = enumValues(enumClass, steps)
          const index = enumClass.members.findIndex((item) => item.name === defaultValue.path[1])
          if (index >= 0) column.default = { kind: 'literal', value: values[index] }
        } else if (defaultValue.kind === 'name' && defaultValue.path.length === 1 && defaultValue.path[0] === 'null')
          column.default = { kind: 'literal', value: null }
        else if (value !== undefined) column.default = { kind: 'literal', value }
      }
      const defaultSql = stringOf(stepOf(steps, 'HasDefaultValueSql')?.args[0])
      if (defaultSql !== undefined) {
        if (NOW_SQL.test(defaultSql.trim())) column.generated = 'now'
        else if (UUID_SQL.test(defaultSql.trim())) column.generated = 'uuid'
        else column.default = { kind: 'expression', sql: defaultSql }
      }
      const computed = stringOf(stepOf(steps, 'HasComputedColumnSql')?.args[0])
      if (computed) column.generated = { computed }
      const generatedAttribute = nameOf(attributeOf(property.attributes, 'DatabaseGenerated')?.args[0])
      if (
        stepOf(steps, 'UseIdentityColumn', 'UseIdentityAlwaysColumn', 'UseIdentityByDefaultColumn', 'UseSerialColumn') ||
        generatedAttribute === 'Identity'
      )
        column.generated = 'identity'
      if (stepOf(steps, 'ValueGeneratedOnAdd') && !column.generated)
        column.generated = column.type.kind === 'uuid' ? 'uuid' : column.type.kind === 'integer' ? 'identity' : undefined
      if (!column.generated) delete column.generated
      if (stepOf(steps, 'ValueGeneratedNever') || generatedAttribute === 'None') neverGenerated.add(column)
      const columnComment = stringOf(stepOf(steps, 'HasComment')?.args[0]) ?? stringOf(attributeOf(property.attributes, 'Comment')?.args[0])
      if (columnComment) column.comment = columnComment
      if (name !== property.name) column.attribute = property.name
      table.columns.push(column)
      model.columns.set(property.name, name)
    }
    if (keyProperties.length > 0) table.primaryKey = keyProperties.map((property) => model.columns.get(property) ?? property)
    models.push(model)
    byClass.set(cls.name, model)
  }

  // Indexes and alternate keys
  for (const model of models) {
    const { table, chains, cls } = model
    const columnsOf = (names: string[]) => names.map((name) => model.columns.get(name) ?? name)
    for (const chain of chains) {
      const [first, ...rest] = chain
      if (first.name !== 'HasIndex' && first.name !== 'HasAlternateKey') continue
      const columns = columnsOf(propertiesOf(first.args))
      if (columns.length === 0) continue
      const name = stringOf(stepOf(rest, 'HasDatabaseName', 'HasName')?.args[0])
      const unique =
        first.name === 'HasAlternateKey' || (!!stepOf(rest, 'IsUnique') && booleanOf(stepOf(rest, 'IsUnique')!.args[0]) !== false)
      ;(unique ? table.uniques : table.indexes).push({ ...(name ? { name } : {}), columns })
    }
    for (const attribute of cls.attributes.filter((item) => nameOf(item) === 'Index')) {
      const columns = columnsOf(propertiesOf(attribute.args))
      if (columns.length === 0) continue
      const name = stringOf(attribute.named.Name)
      const target = booleanOf(attribute.named.IsUnique) === true ? table.uniques : table.indexes
      target.push({ ...(name ? { name } : {}), columns })
    }
  }

  // Relations: the fluent API first, then the navigations it does not configure
  const configured = new Set<string>()
  const joins: DbTable[] = []
  const addKey = (
    dependent: Model,
    principal: Model,
    keyProperties: string[],
    principalProperties: string[],
    options: {
      name?: string
      onDelete?: ReferentialAction | null
      attribute?: string
      inverse?: string
      required?: boolean
      unique?: boolean
    },
  ) => {
    const principalColumns =
      principalProperties.length > 0
        ? principalProperties.map((name) => principal.columns.get(name) ?? name)
        : (principal.table.primaryKey ?? [])
    const columns: string[] = []
    keyProperties.forEach((property, position) => {
      let column = dependent.columns.get(property)
      if (!column) {
        // A shadow property: the column exists in the database but not in the class
        const parent = principal.table.columns.find((item) => item.name === principalColumns[position])
        column = property
        if (!dependent.table.columns.some((item) => item.name === column))
          dependent.table.columns.push({
            name: column,
            type: parent?.type ?? { sql: '', kind: 'unknown' },
            nullable: options.required === false || options.required === undefined,
          })
        dependent.columns.set(property, column)
      }
      columns.push(column)
    })
    if (columns.length === 0) return
    if (dependent.table.foreignKeys.some((item) => item.columns.join(',') === columns.join(','))) return
    const nullable = columns.some((column) => dependent.table.columns.find((item) => item.name === column)?.nullable)
    const required = options.required ?? !nullable
    // EF Core deletes the rows of a required relation with their parent unless told otherwise
    const onDelete = options.onDelete === null ? undefined : (options.onDelete ?? (required ? 'cascade' : undefined))
    const key: DbForeignKey = {
      ...(options.name ? { name: options.name } : {}),
      columns,
      references: {
        table: principal.table.name,
        ...(principal.table.schema ? { schema: principal.table.schema } : {}),
        columns: principalColumns,
      },
      ...(onDelete ? { onDelete } : {}),
      ...(options.attribute ? { attribute: options.attribute } : {}),
      ...(options.inverse ? { inverse: options.inverse } : {}),
    }
    dependent.table.foreignKeys.push(key)
    const same = (items: string[]) => items.length === columns.length && items.every((item) => columns.includes(item))
    if (options.unique && !dependent.table.uniques.some((item) => same(item.columns)) && !same(dependent.table.primaryKey ?? []))
      dependent.table.uniques.push({ columns })
  }
  const navigationTarget = (model: Model, navigation: string | undefined) => {
    const property = model.cls.properties.find((item) => item.name === navigation)
    return property ? (elementType(property.type) ?? bareType(property.type)) : undefined
  }
  const behaviour = (steps: Step[]): ReferentialAction | null | undefined => {
    const step = stepOf(steps, 'OnDelete')
    if (!step) return undefined
    const name = nameOf(step.args[0]) ?? ''
    return name in DELETE_BEHAVIOURS ? (DELETE_BEHAVIOURS[name] ?? null) : undefined
  }
  for (const model of models)
    for (const chain of model.chains) {
      const [first, ...rest] = chain
      if (first.name !== 'HasOne' && first.name !== 'HasMany') continue
      const navigation = propertiesOf(first.args)[0]
      const other = byClass.get(first.generic ?? navigationTarget(model, navigation) ?? '')
      if (!other) continue
      const withStep = stepOf(rest, 'WithMany', 'WithOne')
      const inverse = withStep ? propertiesOf(withStep.args)[0] : undefined
      const foreignKey = stepOf(rest, 'HasForeignKey')
      const principalKey = stepOf(rest, 'HasPrincipalKey')
      const name = stringOf(stepOf(rest, 'HasConstraintName')?.args[0])
      const requiredStep = stepOf(rest, 'IsRequired')
      const required = requiredStep ? booleanOf(requiredStep.args[0]) !== false : undefined
      if (first.name === 'HasMany' && withStep?.name === 'WithMany') {
        const using = stepOf(rest, 'UsingEntity')
        const usingText = using ? using.args.map(textOf).join(' ') : ''
        const joinName = stringOf(using?.args[0]) ?? /ToTable\(\s*"([^"]+)"/.exec(usingText)?.[1] ?? `${model.cls.name}${other.cls.name}`
        if (!joins.some((item) => item.name === joinName)) joins.push(joinTableOf(joinName, model, other, navigation, inverse))
        configured.add(`${model.cls.name}.${navigation}`)
        if (inverse) configured.add(`${other.cls.name}.${inverse}`)
        continue
      }
      // HasOne(…).WithMany(…): the key is on this entity; HasMany(…).WithOne(…): on the other one. A one-to-one
      // relation says where with HasForeignKey<Dependent>
      let dependent = first.name === 'HasOne' ? model : other
      let principal = first.name === 'HasOne' ? other : model
      if (first.name === 'HasOne' && withStep?.name === 'WithOne' && foreignKey?.generic) {
        dependent = byClass.get(foreignKey.generic) ?? model
        principal = dependent === model ? other : model
      }
      const dependentNavigation =
        dependent === model ? (first.name === 'HasOne' ? navigation : inverse) : first.name === 'HasOne' ? inverse : navigation
      const principalNavigation =
        dependent === model ? (first.name === 'HasOne' ? inverse : navigation) : first.name === 'HasOne' ? navigation : inverse
      const keyProperties = foreignKey ? propertiesOf(foreignKey.args) : conventionKey(dependent, principal, dependentNavigation)
      addKey(dependent, principal, keyProperties, principalKey ? propertiesOf(principalKey.args) : [], {
        ...(name ? { name } : {}),
        onDelete: behaviour(rest),
        ...(dependentNavigation ? { attribute: dependentNavigation } : {}),
        ...(principalNavigation ? { inverse: principalNavigation } : {}),
        ...(required !== undefined ? { required } : {}),
        unique: withStep?.name === 'WithOne',
      })
      if (dependentNavigation) configured.add(`${dependent.cls.name}.${dependentNavigation}`)
      if (principalNavigation) configured.add(`${principal.cls.name}.${principalNavigation}`)
    }
  // Navigations by convention: a reference to an entity has its key in this table; a collection, in the other one
  for (const model of models)
    for (const property of allProperties(model.cls)) {
      if (configured.has(`${model.cls.name}.${property.name}`) || attributeOf(property.attributes, 'NotMapped')) continue
      const collection = elementType(property.type)
      const target = byClass.get(collection ?? bareType(property.type))
      if (!target || !(collection || isEntity(property.type))) continue
      const inverse = target.cls.properties.find((item) => {
        const type = elementType(item.type) ?? bareType(item.type)
        return type === model.cls.name && !configured.has(`${target.cls.name}.${item.name}`)
      })
      if (collection) {
        // A collection with a reference on the other side is configured from that side
        if (inverse) continue
        addKey(target, model, conventionKey(target, model, undefined), [], { inverse: property.name, required: false })
      } else {
        const keyAttribute = stringOf(attributeOf(property.attributes, 'ForeignKey')?.args[0])
        const annotated = model.properties.find((item) => stringOf(attributeOf(item.attributes, 'ForeignKey')?.args[0]) === property.name)
        const keyProperties = keyAttribute
          ? keyAttribute.split(',').map((item) => item.trim())
          : annotated
            ? [annotated.name]
            : conventionKey(model, target, property.name)
        addKey(model, target, keyProperties, [], {
          attribute: property.name,
          ...(inverse ? { inverse: inverse.name } : {}),
        })
        if (inverse) configured.add(`${target.cls.name}.${inverse.name}`)
      }
      configured.add(`${model.cls.name}.${property.name}`)
    }
  // EF Core numbers a key of one integer column (and fills a Guid one) unless told not to, or it is a foreign key
  for (const { table } of models) {
    if (table.primaryKey?.length !== 1) continue
    const key = table.columns.find((item) => item.name === table.primaryKey![0])
    if (!key || key.generated || neverGenerated.has(key)) continue
    if (table.foreignKeys.some((item) => item.columns.includes(key.name))) continue
    if (key.type.kind === 'integer') key.generated = 'identity'
    else if (key.type.kind === 'uuid') key.generated = 'uuid'
  }
  return {
    format: 'db-schema',
    version: 1,
    dialect,
    source: { kind: 'orm', format: 'efcore' },
    tables: [...models.map((model) => model.table), ...joins],
    enums: dbEnums,
    notes,
  }
}

/** The key EF Core finds by convention: `<navigation><key>`, `<navigation>Id`, `<principal><key>` or
 * `<principal>Id`, a shadow `<navigation><key>` when the class has none of them. */
function conventionKey(dependent: Model, principal: Model, navigation: string | undefined): string[] {
  const keys = principal.table.primaryKey ?? []
  const keyProperty = (column: string) => [...principal.columns].find(([, name]) => name === column)?.[0] ?? column
  const names = dependent.properties.map((item) => item.name.toLowerCase())
  return keys.map((column) => {
    const key = keyProperty(column)
    const candidates = [
      ...(navigation ? [`${navigation}${key}`, `${navigation}Id`] : []),
      `${principal.cls.name}${key}`,
      `${principal.cls.name}Id`,
    ]
    const found = candidates.find((item) => names.includes(item.toLowerCase()))
    return found ? dependent.properties.find((item) => item.name.toLowerCase() === found.toLowerCase())!.name : candidates[0]
  })
}

/** The join table of a many-to-many relation: `<Entity><Entity>` (or as `UsingEntity` names it), with a column
 * `<navigation><key>` to each side, keyed by both and deleted with either row. */
function joinTableOf(
  name: string,
  left: Model,
  right: Model,
  leftNavigation: string | undefined,
  rightNavigation: string | undefined,
): DbTable {
  const table: DbTable = { name, columns: [], primaryKey: [], foreignKeys: [], uniques: [], indexes: [], checks: [] }
  const sides = [
    [left, rightNavigation ?? left.cls.name],
    [right, leftNavigation ?? right.cls.name],
  ] as const
  for (const [side, prefix] of sides) {
    const key = side.table.primaryKey?.[0]
    const parent = side.table.columns.find((item) => item.name === key)
    if (!parent) continue
    const property = [...side.columns].find(([, column]) => column === parent.name)?.[0] ?? parent.name
    const column = `${prefix}${property}`
    table.columns.push({ name: column, type: parent.type, nullable: false })
    table.primaryKey!.push(column)
    table.foreignKeys.push({
      columns: [column],
      references: { table: side.table.name, ...(side.table.schema ? { schema: side.table.schema } : {}), columns: [parent.name] },
      onDelete: 'cascade',
    })
  }
  table.indexes.push(...table.columns.slice(1).map((column) => ({ columns: [column.name] })))
  return table
}

/** `OrderStatus` → `order_status`. */
const toSnake = (name: string) => name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()

export const efcoreReader: OrmReader = {
  id: 'efcore',
  label: 'EF Core',
  language: 'csharp',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\bMicrosoft\.EntityFrameworkCore\b/.test(text) && /\b(DbContext|DbSet<|IEntityTypeConfiguration<)/.test(text) ? 1 : 0
  },
  read: readEfCore,
}
