/**
 * Reads SQL DDL into the physical schema: `CREATE TABLE` (columns with their types, `NOT NULL`, defaults, identity
 * and computed columns, comments, and the constraints of a column or of the table), `CREATE INDEX`, `CREATE TYPE … AS
 * ENUM`, `ALTER TABLE` (constraints, columns, defaults and identities added or dropped, renames), `DROP TABLE` and
 * `COMMENT ON`, as PostgreSQL, MySQL, MariaDB and SQLite write them, also in the dumps of `pg_dump --schema-only` and
 * `mysqldump --no-data`. Anything else (functions, triggers, views, grants, settings) is left out. The engine is the
 * one the text is written for, when it shows (`SERIAL`, `AUTO_INCREMENT`, `AUTOINCREMENT`…), or the one given.
 */
import { checkOf } from '../../schema/checks.ts'
import type {
  DbColumn,
  DbDefault,
  DbEnum,
  DbForeignKey,
  DbGenerated,
  DbNote,
  DbSchema,
  DbTable,
  DbType,
  Dialect,
  ReferentialAction,
} from '../../schema/types.ts'
import { tokenize, type LexerConfig, type Token } from '../code/lexer.ts'
import { sqlTypeOf } from '../orm/sqlTypes.ts'

const SQL: LexerConfig = {
  lineComments: ['--', '#'],
  blockComments: [['/*', '*/']],
  strings: [
    { open: "'", close: "'", escapes: false, multiline: true },
    { open: '"', close: '"', escapes: false, multiline: false },
    { open: '`', close: '`', escapes: false, multiline: false },
    { open: '[', close: ']', escapes: false, multiline: false },
  ],
}

/** The text with what the lexer does not need blanked out, keeping every position: dollar-quoted bodies (PostgreSQL
 * functions), `DELIMITER` blocks (MySQL triggers) and `#` comments that are not MySQL's. */
function prepare(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ')
  return text
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, blank)
    .replace(/^[ \t]*DELIMITER[ \t]+(?!;)\S+[ \t]*$[\s\S]*?^[ \t]*DELIMITER[ \t]+;[ \t]*$/gim, blank)
    .replace(/^[ \t]*GO[ \t]*$/gim, (match) => `;${' '.repeat(Math.max(0, match.length - 1))}`)
}

// Statements as tokens

interface Statement {
  tokens: Token[]
  source: string
}

/** The statements of the text, split at each `;` outside brackets. */
function statementsOf(text: string): Statement[] {
  const source = prepare(text)
  let tokens: Token[]
  try {
    tokens = tokenize(source, SQL)
  } catch {
    return []
  }
  const statements: Statement[] = []
  let current: Token[] = []
  let depth = 0
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === '(') depth++
    if (token.kind === 'punct' && token.value === ')') depth = Math.max(0, depth - 1)
    if (token.kind === 'punct' && token.value === ';' && depth === 0) {
      if (current.length > 0) statements.push({ tokens: current, source })
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) statements.push({ tokens: current, source })
  return statements
}

/** A token that is a literal text: `'…'` (the other quotes name things). */
const isText = (token: Token | undefined, source: string) => token?.kind === 'string' && source[token.start] === "'"
/** A token that names something: a word, or a quoted name. */
const isName = (token: Token | undefined, source: string) =>
  !!token && (token.kind === 'ident' || (token.kind === 'string' && source[token.start] !== "'"))
const word = (token: Token | undefined) => (token?.kind === 'ident' ? token.value.toUpperCase() : '')

/** A cursor over the tokens of one statement. */
class Reader {
  index = 0
  readonly tokens: Token[]
  readonly source: string

  constructor(tokens: Token[], source: string) {
    this.tokens = tokens
    this.source = source
  }

  get done() {
    return this.index >= this.tokens.length
  }
  peek(offset = 0) {
    return this.tokens[this.index + offset]
  }
  /** The word at the cursor (upper case), or '' */
  word(offset = 0) {
    return word(this.peek(offset))
  }
  isWord(...words: string[]) {
    return words.includes(this.word())
  }
  is(punct: string, offset = 0) {
    const token = this.peek(offset)
    return token?.kind === 'punct' && token.value === punct
  }
  next() {
    return this.tokens[this.index++]
  }
  /** Moves past these words, in order, when they all come next. */
  eat(...words: string[]) {
    if (!words.every((item, position) => this.word(position) === item)) return false
    this.index += words.length
    return true
  }
  eatPunct(punct: string) {
    if (!this.is(punct)) return false
    this.index++
    return true
  }
  /** A name, maybe qualified (`public.orders`): its parts. */
  qualifiedName(): string[] {
    const parts: string[] = []
    if (!isName(this.peek(), this.source)) return parts
    parts.push(this.next().value)
    while (this.is('.') && isName(this.peek(1), this.source)) {
      this.next()
      parts.push(this.next().value)
    }
    return parts
  }
  /** The tokens of a group in brackets at the cursor, without them; the cursor moves past it. */
  group(): Token[] {
    if (!this.is('(')) return []
    const start = ++this.index
    let depth = 1
    while (!this.done) {
      const token = this.next()
      if (token.kind === 'punct' && token.value === '(') depth++
      if (token.kind === 'punct' && token.value === ')' && --depth === 0) return this.tokens.slice(start, this.index - 1)
    }
    return this.tokens.slice(start)
  }
  /** The source text of some tokens. */
  text(tokens: Token[]) {
    return tokens.length > 0 ? this.source.slice(tokens[0].start, tokens.at(-1)!.end) : ''
  }
}

/** The items of a list in brackets, split at each `,` outside brackets. */
function itemsOf(tokens: Token[]): Token[][] {
  const items: Token[][] = [[]]
  let depth = 0
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === '(') depth++
    if (token.kind === 'punct' && token.value === ')') depth--
    if (token.kind === 'punct' && token.value === ',' && depth === 0) items.push([])
    else items.at(-1)!.push(token)
  }
  return items.filter((item) => item.length > 0)
}

/** The columns a list names: `(a, "b" DESC, c(10))`; null when one is an expression. */
function columnsOf(tokens: Token[], source: string): string[] | null {
  const columns: string[] = []
  for (const item of itemsOf(tokens)) {
    if (!isName(item[0], source)) return null
    // A length (`c(10)`, MySQL), then an order, a collation or an operator class may follow the name
    let rest = item.slice(1)
    if (rest[0]?.kind === 'punct' && rest[0].value === '(') {
      if (rest[1]?.kind !== 'number' || rest[2]?.kind !== 'punct' || rest[2].value !== ')') return null
      rest = rest.slice(3)
    }
    if (!rest.every((token) => token.kind === 'ident' || isName(token, source))) return null
    columns.push(item[0].value)
  }
  return columns
}

// Types

const DEFAULT_SCHEMAS = new Set(['public', 'dbo', 'main', 'pg_catalog'])

/** The type of a column as written: `character varying(120)`, `timestamp(3) with time zone`, `int unsigned`. */
function typeOf(
  text: string,
  dialect: Dialect | null,
  enums: Map<string, DbEnum>,
  table: string,
  column: string,
): { type: DbType; enumValues?: string[]; identity?: boolean } | null {
  const sql = text.trim()
  let lower = sql.toLowerCase().replace(/\s+/g, ' ')
  // Arrays: `text[]`, `integer ARRAY`
  const array = /(\[\s*\d*\s*\])+$|\sarray$/.exec(lower)
  if (array) {
    const items = typeOf(sql.slice(0, array.index), dialect, enums, table, column)
    return items ? { type: { sql, kind: 'array', items: items.type } } : null
  }
  // MySQL enums and sets: `enum('a','b')`
  const inline = /^(enum|set)\s*\(([\s\S]*)\)/i.exec(sql)
  if (inline) {
    const values = [...inline[2].matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1].replace(/''/g, "'"))
    if (inline[1].toLowerCase() === 'set') return { type: { sql, kind: 'text' } }
    return { type: { sql, kind: 'enum', name: `${table}_${column}` }, enumValues: values }
  }
  lower = lower
    .replace(/\s+(unsigned|signed|zerofill)\b/g, '')
    .replace(/\s+(character set|charset|collate)\s+\S+/g, '')
    .trim()
  // A type of the schema: an enum made with CREATE TYPE
  const named = enums.get(lower.split('.').at(-1)!.replace(/"/g, ''))
  if (named) return { type: { sql, kind: 'enum', name: named.name } }
  const serial = /^(small|big)?serial[248]?$/.exec(lower)
  if (serial) {
    const bits = serial[1] === 'small' || lower === 'serial2' ? 16 : serial[1] === 'big' || lower === 'serial8' ? 64 : 32
    return { type: { sql, kind: 'integer', bits }, identity: true }
  }
  if ((dialect === 'mysql' || dialect === 'mariadb') && /^tinyint\s*\(\s*1\s*\)$/.test(lower)) return { type: { sql, kind: 'boolean' } }
  if (/^bit(\s*\(\s*1\s*\))?$/.test(lower)) return { type: { sql, kind: 'boolean' } }
  if (lower === 'year') return { type: { sql, kind: 'integer', bits: 16 } }
  if (lower === 'money' || lower === 'smallmoney') return { type: { sql, kind: 'decimal' } }
  if (/^(n?varchar|varchar2|nvarchar2)\s*\(\s*max\s*\)$/.test(lower)) return { type: { sql, kind: 'text' } }
  if (/^(varbinary)\s*\(\s*max\s*\)$/.test(lower)) return { type: { sql, kind: 'binary' } }
  // The size may come before the words that end the name: `timestamp(3) with time zone`
  const sized = /^([a-z][a-z0-9_ ]*?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)\s*([a-z ]*)$/.exec(lower)
  const base = sized ? `${sized[1]} ${sized[4]}`.trim().replace(/\s+/g, ' ') : lower
  const args = sized ? `(${sized[2]}${sized[3] !== undefined ? `, ${sized[3]}` : ''})` : ''
  const ALIASES: Record<string, string> = {
    int2: 'smallint',
    int4: 'integer',
    int8: 'bigint',
    float4: 'real',
    float8: 'double precision',
    bool: 'boolean',
    'double precision': 'double precision',
    datetime2: 'datetime',
    smalldatetime: 'datetime',
    datetimeoffset: 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'time without time zone': 'time',
    'timestamp with time zone': 'timestamptz',
    'time with time zone': 'timetz',
    character: 'char',
    'character varying': 'varchar',
    'national character varying': 'nvarchar',
    'bit varying': 'varbinary',
    mediumblob: 'blob',
    tinyblob: 'blob',
    longblob: 'blob',
    binary: 'binary',
    tinytext: 'text',
    mediumtext: 'text',
    longtext: 'text',
    ntext: 'text',
    clob: 'text',
    string: 'text',
    number: 'numeric',
    dec: 'decimal',
    fixed: 'decimal',
    long: 'text',
  }
  const name = ALIASES[base] ?? base
  const found = sqlTypeOf(`${name}${args}`, dialect)
  // DATETIME and TIMESTAMP keep no time zone in MySQL, MariaDB and SQLite
  return found ? { type: { ...found, sql } } : null
}

const NOW_SQL =
  /^(now\(\)|current_timestamp(\s*\(\s*\d*\s*\))?|localtimestamp(\(\d*\))?|getdate\(\)|getutcdate\(\)|sysdatetime\(\)|datetime\('now'\)|\(datetime\('now'\)\)|\(?unixepoch\(\)\)?)$/i
const UUID_SQL = /^(gen_random_uuid\(\)|uuid_generate_v4\(\)|uuid\(\)|newid\(\)|newsequentialid\(\))$/i

/** A default as written: a literal, the time, a new UUID, a sequence (an identity) or an expression. */
function defaultOf(text: string, dialect: Dialect | null): { default?: DbDefault; generated?: DbGenerated } {
  let sql = text.trim()
  while (/^\((?:[^()]|\([^()]*\))*\)$/.test(sql)) sql = sql.slice(1, -1).trim()
  // PostgreSQL casts: `'draft'::status`, `'{}'::jsonb`
  const cast = /^('(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s*::\s*[\w ."[\]]+$/.exec(sql)
  if (cast) sql = cast[1]
  if (/^nextval\(/i.test(sql)) return { generated: 'identity' }
  if (NOW_SQL.test(sql)) return { generated: 'now' }
  if (UUID_SQL.test(sql)) return { generated: 'uuid' }
  if (/^null$/i.test(sql)) return { default: { kind: 'literal', value: null } }
  if (/^(true|false)$/i.test(sql)) return { default: { kind: 'literal', value: sql.toLowerCase() === 'true' } }
  if (/^b'[01]'$/i.test(sql)) return { default: { kind: 'literal', value: sql[2] === '1' } }
  if (/^[+-]?\d+(\.\d+)?$/.test(sql)) return { default: { kind: 'literal', value: Number(sql) } }
  if (/^[EN]?'(?:[^']|'')*'$/i.test(sql))
    return { default: { kind: 'literal', value: sql.replace(/^[EN]/i, '').slice(1, -1).replace(/''/g, "'") } }
  // MySQL writes texts in double quotes too
  if ((dialect === 'mysql' || dialect === 'mariadb') && /^"(?:[^"]|"")*"$/.test(sql))
    return { default: { kind: 'literal', value: sql.slice(1, -1).replace(/""/g, '"') } }
  return { default: { kind: 'expression', sql } }
}

const ACTIONS: Record<string, ReferentialAction> = {
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
  RESTRICT: 'restrict',
  'NO ACTION': 'no action',
}

// What the text is written for

const MARKS: [RegExp, Dialect][] = [
  [
    /\b(big|small)?serial\b|::\s*\w|\btimestamptz\b|\bjsonb\b|\bbytea\b|\bcreate\s+type\s+\S+\s+as\s+enum\b|\bnextval\s*\(|\bpg_catalog\b|\bowner\s+to\b/i,
    'postgresql',
  ],
  [/-- MariaDB dump|\/\*M!|\bmariadb\b/i, 'mariadb'],
  [/`\w+`|\bauto_increment\b|\bengine\s*=|\btinyint\s*\(\s*1\s*\)|\bunsigned\b|\/\*!\d{5}/i, 'mysql'],
  [/\bautoincrement\b|\bwithout\s+rowid\b|\bpragma\b|\bsqlite_sequence\b/i, 'sqlite'],
  [/\bidentity\s*\(\s*\d+\s*,\s*\d+\s*\)|\bnvarchar\b|^\s*go\s*$|\[\w+\]\.\[\w+\]/im, 'sqlserver'],
]

/** The engine the DDL is written for, when it shows: the first mark found, MariaDB before MySQL. */
export function ddlDialect(text: string): Dialect | null {
  const clean = prepare(text)
  return MARKS.find(([pattern]) => pattern.test(clean))?.[1] ?? null
}

// Reading the statements

interface Builder {
  dialect: Dialect | null
  tables: DbTable[]
  enums: Map<string, DbEnum>
  notes: DbNote[]
  /** Foreign keys whose referenced columns are the key of a table read later */
  pending: { key: DbForeignKey; table: string }[]
}

const findTable = (builder: Builder, parts: string[]) => {
  const name = parts.at(-1)
  return builder.tables.find((table) => table.name === name)
}

const schemaOf = (parts: string[]) => (parts.length > 1 && !DEFAULT_SCHEMAS.has(parts.at(-2)!.toLowerCase()) ? parts.at(-2) : undefined)

/** `REFERENCES parent (id) ON DELETE CASCADE`, at the cursor after REFERENCES. */
function readReference(reader: Reader, columns: string[], builder: Builder, name?: string): DbForeignKey {
  const target = reader.qualifiedName()
  const referenced = reader.is('(') ? (columnsOf(reader.group(), reader.source) ?? []) : []
  const key: DbForeignKey = {
    ...(name ? { name } : {}),
    columns,
    references: { table: target.at(-1) ?? '', ...(schemaOf(target) ? { schema: schemaOf(target) } : {}), columns: referenced },
  }
  while (!reader.done) {
    if (reader.eat('ON', 'DELETE') || reader.eat('ON', 'UPDATE')) {
      const which = word(reader.tokens[reader.index - 1]) === 'DELETE' ? 'onDelete' : 'onUpdate'
      let action: string
      if (reader.eat('SET', 'NULL')) action = 'SET NULL'
      else if (reader.eat('SET', 'DEFAULT')) action = 'SET DEFAULT'
      else if (reader.eat('NO', 'ACTION')) action = 'NO ACTION'
      else action = word(reader.next())
      if (ACTIONS[action]) key[which] = ACTIONS[action]
    } else if (reader.eat('MATCH')) reader.next()
    else if (reader.isWord('DEFERRABLE', 'NOT', 'INITIALLY', 'IMMEDIATE', 'DEFERRED', 'ENFORCED', 'VALID')) reader.next()
    else break
  }
  if (referenced.length === 0) builder.pending.push({ key, table: key.references.table })
  return key
}

const CONSTRAINT_WORDS = new Set([
  'NOT',
  'NULL',
  'DEFAULT',
  'PRIMARY',
  'UNIQUE',
  'REFERENCES',
  'CHECK',
  'CONSTRAINT',
  'GENERATED',
  'AUTO_INCREMENT',
  'AUTOINCREMENT',
  'IDENTITY',
  'COLLATE',
  'COMMENT',
  'ON',
  'AS',
  'VISIBLE',
  'INVISIBLE',
  'STORAGE',
  'COLUMN_FORMAT',
  'SRID',
  'KEY',
])

/** One column of CREATE TABLE or ALTER TABLE … ADD COLUMN: its name, type and constraints. */
function readColumn(tokens: Token[], source: string, table: DbTable, builder: Builder): void {
  const reader = new Reader(tokens, source)
  const name = reader.next().value
  const typeStart = reader.index
  let depth = 0
  while (!reader.done) {
    const token = reader.peek()!
    if (token.kind === 'punct' && token.value === '(') depth++
    if (token.kind === 'punct' && token.value === ')') depth--
    if (depth === 0 && token.kind === 'ident' && CONSTRAINT_WORDS.has(token.value.toUpperCase())) {
      // `CHARACTER SET x` and `WITH TIME ZONE` belong to the type; `ON UPDATE` does not
      break
    }
    reader.next()
  }
  const typeText = reader.text(tokens.slice(typeStart, reader.index))
  const read = typeText ? typeOf(typeText, builder.dialect, builder.enums, table.name, name) : null
  if (!read) builder.notes.push({ code: 'ddl.unknownType', params: { table: table.name, column: name, type: typeText } })
  const column: DbColumn = { name, type: read?.type ?? { sql: typeText, kind: 'unknown' }, nullable: true }
  if (read?.enumValues) {
    const enumName = (read.type as { name: string }).name
    if (!builder.enums.has(enumName)) builder.enums.set(enumName, { name: enumName, values: read.enumValues, storage: 'native' })
  }
  if (read?.identity) {
    column.generated = 'identity'
    column.nullable = false
  }
  let constraint: string | undefined
  while (!reader.done) {
    if (reader.eat('CONSTRAINT')) {
      constraint = reader.next()?.value
      continue
    }
    if (reader.eat('NOT', 'NULL')) column.nullable = false
    else if (reader.eat('NULL')) column.nullable = true
    else if (reader.eat('DEFAULT')) {
      const start = reader.index
      let level = 0
      while (!reader.done) {
        const token = reader.peek()!
        if (token.kind === 'punct' && token.value === '(') level++
        if (token.kind === 'punct' && token.value === ')') level--
        if (
          level === 0 &&
          reader.index > start &&
          token.kind === 'ident' &&
          CONSTRAINT_WORDS.has(token.value.toUpperCase()) &&
          token.value.toUpperCase() !== 'ON'
        )
          break
        if (level === 0 && reader.index > start && reader.eat('ON', 'UPDATE')) {
          reader.index -= 2
          break
        }
        reader.next()
      }
      const value = defaultOf(reader.text(tokens.slice(start, reader.index)), builder.dialect)
      if (value.generated) column.generated = value.generated
      else if (value.default && column.generated !== 'identity') column.default = value.default
    } else if (reader.eat('PRIMARY', 'KEY')) {
      column.nullable = false
      table.primaryKey = [name]
      if (!reader.eat('ASC')) reader.eat('DESC')
      // SQLite numbers an INTEGER PRIMARY KEY declared on its column (it is the rowid)
      if (reader.eat('AUTOINCREMENT') || (builder.dialect === 'sqlite' && /^integer$/i.test(typeText.trim()))) column.generated = 'identity'
    } else if (reader.eat('UNIQUE')) {
      reader.eat('KEY')
      table.uniques.push({ ...(constraint ? { name: constraint } : {}), columns: [name] })
    } else if (reader.eat('REFERENCES')) table.foreignKeys.push(readReference(reader, [name], builder, constraint))
    else if (reader.eat('CHECK')) {
      const sql = reader.text(reader.group())
      table.checks.push(checkOf(sql, constraint))
    } else if (reader.eat('GENERATED')) {
      if (
        reader.eat('ALWAYS', 'AS', 'IDENTITY') ||
        reader.eat('BY', 'DEFAULT', 'AS', 'IDENTITY') ||
        reader.eat('BY', 'DEFAULT', 'ON', 'NULL', 'AS', 'IDENTITY')
      ) {
        column.generated = 'identity'
        column.nullable = false
        if (reader.is('(')) reader.group()
      } else if (reader.eat('ALWAYS', 'AS')) {
        column.generated = { computed: reader.text(reader.group()).trim() }
        if (!reader.eat('STORED')) reader.eat('VIRTUAL')
      }
    } else if (reader.eat('AS')) {
      // MySQL and SQLite: `AS (expression) [STORED|VIRTUAL]`
      column.generated = { computed: reader.text(reader.group()).trim() }
      if (!reader.eat('STORED') && !reader.eat('VIRTUAL')) reader.eat('PERSISTENT')
    } else if (reader.eat('AUTO_INCREMENT') || reader.eat('AUTOINCREMENT')) column.generated = 'identity'
    else if (reader.eat('IDENTITY')) {
      column.generated = 'identity'
      if (reader.is('(')) reader.group()
    } else if (reader.eat('ON', 'UPDATE')) {
      const start = reader.index
      reader.next()
      if (reader.is('(')) reader.group()
      if (NOW_SQL.test(reader.text(tokens.slice(start, reader.index)))) column.generated = 'onUpdateNow'
    } else if (reader.eat('COMMENT')) {
      const token = reader.next()
      if (isText(token, source)) column.comment = token.value
    } else if (reader.eat('COLLATE')) reader.next()
    else reader.next()
    if (!reader.isWord('CONSTRAINT')) constraint = undefined
  }
  if (column.generated === 'now' || column.generated === 'onUpdateNow' || column.generated === 'uuid') delete column.default
  // MySQL dumps write numbers in quotes: `DEFAULT '0.00'`, and booleans as `'1'`
  const value = column.default?.kind === 'literal' ? column.default.value : undefined
  if (typeof value === 'string' && /^[+-]?\d+(\.\d+)?$/.test(value)) {
    const kind = column.type.kind
    if (kind === 'integer' || kind === 'decimal' || kind === 'float') column.default = { kind: 'literal', value: Number(value) }
    else if (kind === 'boolean' && (value === '0' || value === '1')) column.default = { kind: 'literal', value: value === '1' }
  }
  if (column.type.kind === 'boolean' && column.default?.kind === 'literal' && (column.default.value === 0 || column.default.value === 1))
    column.default = { kind: 'literal', value: column.default.value === 1 }
  table.columns.push(column)
}

/** A constraint of the table (CREATE TABLE or ALTER TABLE … ADD): PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK, or a
 * MySQL KEY/INDEX. Returns false when the item is not one. */
function readConstraint(reader: Reader, table: DbTable, builder: Builder): boolean {
  const start = reader.index
  let name: string | undefined
  if (reader.eat('CONSTRAINT'))
    name = isName(reader.peek(), reader.source) && !reader.isWord('PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK') ? reader.next().value : undefined
  if (reader.eat('PRIMARY', 'KEY')) {
    if (isName(reader.peek(), reader.source) && !reader.is('(')) reader.next()
    if (reader.eat('USING')) reader.next()
    const columns = columnsOf(reader.group(), reader.source)
    if (columns) {
      table.primaryKey = columns
      for (const column of table.columns) if (columns.includes(column.name)) column.nullable = false
    }
    return true
  }
  if (reader.isWord('UNIQUE')) {
    reader.next()
    if (!reader.eat('KEY')) reader.eat('INDEX')
    if (isName(reader.peek(), reader.source) && !reader.is('(')) name = reader.next().value
    if (reader.eat('USING')) reader.next()
    const columns = columnsOf(reader.group(), reader.source)
    if (columns) table.uniques.push({ ...(name ? { name } : {}), columns })
    return true
  }
  if (reader.eat('FOREIGN', 'KEY')) {
    if (isName(reader.peek(), reader.source) && !reader.is('(')) name = name ?? reader.next().value
    const columns = columnsOf(reader.group(), reader.source) ?? []
    if (reader.eat('REFERENCES')) table.foreignKeys.push(readReference(reader, columns, builder, name))
    return true
  }
  if (reader.eat('CHECK')) {
    table.checks.push(checkOf(reader.text(reader.group()), name))
    return true
  }
  if (!name && reader.isWord('KEY', 'INDEX')) {
    reader.next()
    if (isName(reader.peek(), reader.source) && !reader.is('(')) name = reader.next().value
    if (reader.eat('USING')) reader.next()
    const columns = columnsOf(reader.group(), reader.source)
    if (columns) table.indexes.push({ ...(name ? { name } : {}), columns })
    return true
  }
  if (!name && reader.isWord('FULLTEXT', 'SPATIAL', 'EXCLUDE', 'LIKE', 'PERIOD')) return true
  reader.index = start
  return false
}

function createTable(reader: Reader, builder: Builder): void {
  reader.eat('IF', 'NOT', 'EXISTS')
  const parts = reader.qualifiedName()
  if (parts.length === 0 || !reader.is('(')) return
  const table: DbTable = {
    name: parts.at(-1)!,
    ...(schemaOf(parts) ? { schema: schemaOf(parts) } : {}),
    columns: [],
    primaryKey: null,
    foreignKeys: [],
    uniques: [],
    indexes: [],
    checks: [],
    origin: { line: reader.tokens[0].line, column: reader.tokens[0].column },
  }
  for (const item of itemsOf(reader.group())) {
    const inner = new Reader(item, reader.source)
    if (!readConstraint(inner, table, builder)) readColumn(item, reader.source, table, builder)
  }
  // Table options: MySQL's COMMENT='…'
  while (!reader.done) {
    if (reader.eat('COMMENT')) {
      reader.eatPunct('=')
      const token = reader.next()
      if (isText(token, reader.source)) table.comment = token.value
    } else reader.next()
  }
  builder.tables = builder.tables.filter((item) => item.name !== table.name || item.schema !== table.schema)
  builder.tables.push(table)
}

function createIndex(reader: Reader, unique: boolean, builder: Builder): void {
  reader.eat('CONCURRENTLY')
  reader.eat('IF', 'NOT', 'EXISTS')
  const name = !reader.isWord('ON') ? reader.qualifiedName().at(-1) : undefined
  if (!reader.eat('ON')) return
  reader.eat('ONLY')
  const table = findTable(builder, reader.qualifiedName())
  if (reader.eat('USING')) reader.next()
  const columns = columnsOf(reader.group(), reader.source)
  if (!table) return
  if (!columns) {
    builder.notes.push({ code: 'ddl.expressionIndex', params: { table: table.name, ...(name ? { index: name } : {}) } })
    return
  }
  ;(unique ? table.uniques : table.indexes).push({ ...(name ? { name } : {}), columns })
}

function alterTable(reader: Reader, builder: Builder): void {
  reader.eat('IF', 'EXISTS')
  reader.eat('ONLY')
  const table = findTable(builder, reader.qualifiedName())
  if (!table) return
  for (const item of itemsOf(reader.tokens.slice(reader.index))) {
    const action = new Reader(item, reader.source)
    if (action.eat('ADD')) {
      if (readConstraint(action, table, builder)) continue
      if (action.isWord('INDEX', 'KEY')) continue
      action.eat('COLUMN')
      action.eat('IF', 'NOT', 'EXISTS')
      readColumn(item.slice(action.index), reader.source, table, builder)
    } else if (action.eat('ALTER')) {
      action.eat('COLUMN')
      const column = table.columns.find((entry) => entry.name === action.peek()?.value)
      action.next()
      if (!column) continue
      if (action.eat('SET', 'DEFAULT')) {
        const value = defaultOf(action.text(item.slice(action.index)), builder.dialect)
        delete column.default
        if (value.generated) column.generated = value.generated
        else if (value.default) column.default = value.default
      } else if (action.eat('DROP', 'DEFAULT')) delete column.default
      else if (action.eat('SET', 'NOT', 'NULL')) column.nullable = false
      else if (action.eat('DROP', 'NOT', 'NULL')) column.nullable = true
      else if (action.eat('ADD', 'GENERATED')) column.generated = 'identity'
    } else if (action.eat('DROP')) {
      if (action.eat('CONSTRAINT')) {
        action.eat('IF', 'EXISTS')
        const name = action.next()?.value
        table.checks = table.checks.filter((entry) => entry.name !== name)
        table.uniques = table.uniques.filter((entry) => entry.name !== name)
        table.foreignKeys = table.foreignKeys.filter((entry) => entry.name !== name)
      } else if (action.eat('PRIMARY', 'KEY')) table.primaryKey = null
      else {
        action.eat('COLUMN')
        action.eat('IF', 'EXISTS')
        const name = action.next()?.value
        table.columns = table.columns.filter((entry) => entry.name !== name)
      }
    } else if (action.eat('RENAME', 'TO')) {
      const parts = action.qualifiedName()
      if (parts.length > 0) table.name = parts.at(-1)!
    } else if (action.eat('MODIFY') || action.eat('CHANGE')) {
      // MySQL: the column again, whole (CHANGE names it twice)
      action.eat('COLUMN')
      const changed = word(item[0]) === 'CHANGE'
      const old = action.next()?.value
      const position = table.columns.findIndex((entry) => entry.name === old)
      if (position < 0) continue
      const rest = item.slice(changed ? action.index : action.index - 1)
      const scratch: DbTable = { ...table, columns: [] }
      readColumn(rest, reader.source, scratch, builder)
      if (scratch.columns[0]) table.columns[position] = scratch.columns[0]
    }
  }
}

/** `COMMENT ON TABLE t IS '…'`, `COMMENT ON COLUMN t.c IS '…'`. */
function commentOn(reader: Reader, builder: Builder): void {
  const kind = reader.word()
  reader.next()
  const parts = reader.qualifiedName()
  if (!reader.eat('IS')) return
  const token = reader.next()
  const text = isText(token, reader.source) ? token.value : undefined
  if (kind === 'TABLE') {
    const table = findTable(builder, parts)
    if (table && text) table.comment = text
  } else if (kind === 'COLUMN') {
    const table = findTable(builder, parts.slice(0, -1))
    const column = table?.columns.find((item) => item.name === parts.at(-1))
    if (column && text) column.comment = text
  }
}

/** The schema the DDL declares. `dialect` is the engine when the caller knows it. */
export function readDdl(text: string, dialect?: Dialect | null): DbSchema {
  const builder: Builder = { dialect: dialect ?? ddlDialect(text), tables: [], enums: new Map(), notes: [], pending: [] }
  for (const statement of statementsOf(text)) {
    const reader = new Reader(statement.tokens, statement.source)
    if (reader.eat('CREATE')) {
      reader.eat('OR', 'REPLACE')
      while (reader.isWord('TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'VIRTUAL')) reader.next()
      if (reader.eat('TABLE')) createTable(reader, builder)
      else if (reader.eat('UNIQUE')) {
        if (!reader.eat('CLUSTERED')) reader.eat('NONCLUSTERED')
        if (reader.eat('INDEX')) createIndex(reader, true, builder)
      } else if (reader.eat('CLUSTERED', 'INDEX') || reader.eat('NONCLUSTERED', 'INDEX') || reader.eat('INDEX'))
        createIndex(reader, false, builder)
      else if (reader.eat('TYPE')) {
        const parts = reader.qualifiedName()
        if (reader.eat('AS', 'ENUM') && parts.length > 0) {
          const values = reader
            .group()
            .filter((token) => isText(token, reader.source))
            .map((token) => token.value)
          builder.enums.set(parts.at(-1)!, { name: parts.at(-1)!, values, storage: 'native' })
        }
      }
    } else if (reader.eat('DROP', 'TABLE')) {
      reader.eat('IF', 'EXISTS')
      const parts = reader.qualifiedName()
      builder.tables = builder.tables.filter((table) => table.name !== parts.at(-1))
    } else if (reader.eat('ALTER', 'TABLE')) alterTable(reader, builder)
    else if (reader.eat('COMMENT', 'ON')) commentOn(reader, builder)
  }
  // References with no columns point to the key of their table
  for (const { key, table } of builder.pending) {
    const target = builder.tables.find((item) => item.name === table)
    if (target?.primaryKey) key.references.columns = [...target.primaryKey]
  }
  // SQLite keeps enums as text with a CHECK; elsewhere a type of the schema
  return {
    format: 'db-schema',
    version: 1,
    dialect: builder.dialect,
    source: { kind: 'ddl', format: `${builder.dialect ?? 'sql'}-ddl` },
    tables: builder.tables,
    enums: [...builder.enums.values()],
    notes: builder.notes,
  }
}

/** How likely the text is SQL DDL: it creates a table. */
export const detectDdl = (text: string): number =>
  /\bcreate\s+(?:(?:global|local|temporary|temp|unlogged)\s+)*table\b/i.test(prepare(text)) ? 1 : 0
