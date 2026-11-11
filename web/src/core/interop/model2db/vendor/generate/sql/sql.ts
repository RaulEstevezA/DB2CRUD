import type { Literal } from '../../model/schema.ts'
import { orderTables } from '../../physical/order.ts'
import type { Column, ColumnType, Dialect, ForeignKey, PhysicalEnum, RelationalSchema } from '../../physical/types.ts'
import { todoText } from '../todos.ts'

/** Writes the DDL of a relational schema for one dialect: types, enums, tables, constraints and indexes,
 * in an order that every database accepts (a table after the tables it refers to). */

interface DialectRules {
  quote: (name: string) => string
  type: (type: ColumnType, enums: PhysicalEnum[]) => string
  identity: string
  uuidDefault: string
  boolean: (value: boolean) => string
  /** Foreign keys of a cycle are added afterwards with ALTER TABLE; SQLite cannot, and does not need to */
  alterForeignKeys: boolean
  /** Several rows in one INSERT; Oracle (before 23ai) takes one statement per row */
  multiRowInsert: boolean
}

// Words that would break the statement as names in at least one of the dialects
const RESERVED = new Set(
  (
    'add all alter and any as asc between by case cast check column constraint create cross current_date current_time ' +
    'current_timestamp current_user default delete desc distinct drop else end except exists false fetch for foreign from ' +
    'full grant group having in index inner insert intersect interval into is join key left like limit match natural not null ' +
    'offset on option or order outer primary range rank read references right row rows schema select session_user set some ' +
    'table then to true union unique update user using values when where window with'
  ).split(' '),
)

// Oracle reserves many more words, some of them usual field names (`level`, `number`, `comment`, `date`)
const ORACLE_RESERVED = new Set(
  (
    'access audit cluster column comment compress connect date decimal exclusive file float identified immediate increment ' +
    'initial integer level lock long maxextents minus mlslabel mode modify noaudit nocompress nowait number of offline online ' +
    'pctfree prior privileges public raw rename resource row rowid rownum rows session share size smallint start successful ' +
    'synonym sysdate trigger uid validate varchar varchar2 view whenever'
  ).split(' '),
)

// MySQL and MariaDB also reserve some usual table and column names (`lines`, `keys`, `groups`)
const MYSQL_RESERVED = new Set(
  (
    'accessible call change condition database databases delayed describe div dual each enclosed escaped exit explain ' +
    'groups high_priority infile keys kill lead lag leave lines load lock long loop low_priority mod modifies optimize ' +
    'outfile purge release rename repeat replace require restrict return revoke rlike separator show signal spatial ' +
    'sql ssl starting terminated trigger undo unlock unsigned usage use utc_date utc_time zerofill'
  ).split(' '),
)

const simpleName = /^[a-z_][a-z0-9_]*$/

function enumOf(type: ColumnType, enums: PhysicalEnum[]): PhysicalEnum | undefined {
  return type.kind === 'enum' ? enums.find((item) => item.name === type.name) : undefined
}

/** Width of a text column holding enum values: the next usual size above the longest value. */
function enumWidth(values: (string | number)[]): number {
  const longest = Math.max(1, ...values.map((value) => String(value).length))
  return longest <= 20 ? 20 : longest <= 50 ? 50 : 255
}

const numericEnum = (item: PhysicalEnum) => item.values.every((value) => typeof value === 'number')

function stringList(values: (string | number)[]): string {
  return values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)).join(', ')
}

const RULES: Record<Exclude<Dialect, 'mariadb'>, DialectRules> = {
  postgresql: {
    quote: (name) => (simpleName.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`),
    type: (type, enums) => {
      switch (type.kind) {
        case 'raw':
          return type.sql
        case 'json':
          return 'JSONB'
        case 'array':
          return `${RULES.postgresql.type(type.items, enums)}[]`
        case 'enum': {
          const item = enumOf(type, enums)
          if (!item) return 'TEXT'
          if (item.storage === 'native') return RULES.postgresql.quote(item.sqlName)
          return numericEnum(item) ? 'INTEGER' : `VARCHAR(${enumWidth(item.values)})`
        }
        case 'primitive':
          switch (type.name) {
            case 'string':
              return type.length ? `VARCHAR(${type.length})` : 'TEXT'
            case 'integer':
              return type.bits === 64 ? 'BIGINT' : type.bits === 8 || type.bits === 16 ? 'SMALLINT' : 'INTEGER'
            case 'float':
              return type.bits === 32 ? 'REAL' : 'DOUBLE PRECISION'
            case 'decimal':
              return `NUMERIC(${type.precision ?? 18}, ${type.scale ?? 2})`
            case 'boolean':
              return 'BOOLEAN'
            case 'date':
              return 'DATE'
            case 'datetime':
              return 'TIMESTAMPTZ'
            case 'time':
              return 'TIME'
            case 'duration':
              return 'INTERVAL'
            case 'uuid':
              return 'UUID'
            case 'binary':
              return 'BYTEA'
            case 'any':
              return 'JSONB'
          }
      }
    },
    identity: 'GENERATED BY DEFAULT AS IDENTITY',
    uuidDefault: 'DEFAULT gen_random_uuid()',
    boolean: (value) => (value ? 'TRUE' : 'FALSE'),
    alterForeignKeys: true,
    multiRowInsert: true,
  },
  mysql: {
    quote: (name) => (simpleName.test(name) && !RESERVED.has(name) && !MYSQL_RESERVED.has(name) ? name : `\`${name.replace(/`/g, '``')}\``),
    type: (type, enums) => {
      switch (type.kind) {
        case 'raw':
          return type.sql
        case 'json':
        case 'array':
          return 'JSON'
        case 'enum': {
          const item = enumOf(type, enums)
          if (!item) return 'VARCHAR(255)'
          if (item.storage === 'native') return `ENUM(${stringList(item.values.map(String))})`
          return numericEnum(item) ? 'INT' : `VARCHAR(${enumWidth(item.values)})`
        }
        case 'primitive':
          switch (type.name) {
            case 'string':
              return type.length ? `VARCHAR(${type.length})` : 'TEXT'
            case 'integer':
              return type.bits === 64 ? 'BIGINT' : type.bits === 8 ? 'TINYINT' : type.bits === 16 ? 'SMALLINT' : 'INT'
            case 'float':
              return type.bits === 32 ? 'FLOAT' : 'DOUBLE'
            case 'decimal':
              return `DECIMAL(${type.precision ?? 18}, ${type.scale ?? 2})`
            case 'boolean':
              return 'BOOLEAN'
            case 'date':
              return 'DATE'
            case 'datetime':
              return 'DATETIME(6)'
            case 'time':
              return 'TIME'
            case 'duration':
              return 'VARCHAR(50)'
            case 'uuid':
              return 'CHAR(36)'
            case 'binary':
              return 'BLOB'
            case 'any':
              return 'JSON'
          }
      }
    },
    identity: 'AUTO_INCREMENT',
    uuidDefault: 'DEFAULT (UUID())',
    boolean: (value) => (value ? 'TRUE' : 'FALSE'),
    alterForeignKeys: true,
    multiRowInsert: true,
  },
  sqlite: {
    quote: (name) => (simpleName.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`),
    type: (type, enums) => {
      switch (type.kind) {
        case 'raw':
          return type.sql
        case 'json':
        case 'array':
          return 'TEXT'
        case 'enum': {
          const item = enumOf(type, enums)
          return item && numericEnum(item) ? 'INTEGER' : 'TEXT'
        }
        case 'primitive':
          switch (type.name) {
            case 'integer':
            case 'boolean':
              return 'INTEGER'
            case 'float':
              return 'REAL'
            case 'decimal':
              return 'NUMERIC'
            case 'binary':
              return 'BLOB'
            default:
              return 'TEXT'
          }
      }
    },
    identity: '',
    uuidDefault: '',
    boolean: (value) => (value ? '1' : '0'),
    alterForeignKeys: false,
    multiRowInsert: true,
  },
  sqlserver: {
    quote: (name) => (simpleName.test(name) && !RESERVED.has(name) ? name : `[${name.replace(/]/g, ']]')}]`),
    type: (type, enums) => {
      switch (type.kind) {
        case 'raw':
          return type.sql
        case 'json':
        case 'array':
          return 'NVARCHAR(MAX)'
        case 'enum': {
          const item = enumOf(type, enums)
          return item && numericEnum(item) ? 'INT' : `NVARCHAR(${item ? enumWidth(item.values) : 255})`
        }
        case 'primitive':
          switch (type.name) {
            case 'string':
              return type.length ? `NVARCHAR(${type.length})` : 'NVARCHAR(MAX)'
            case 'integer':
              return type.bits === 64 ? 'BIGINT' : type.bits === 8 ? 'TINYINT' : type.bits === 16 ? 'SMALLINT' : 'INT'
            case 'float':
              return type.bits === 32 ? 'REAL' : 'FLOAT'
            case 'decimal':
              return `DECIMAL(${type.precision ?? 18}, ${type.scale ?? 2})`
            case 'boolean':
              return 'BIT'
            case 'date':
              return 'DATE'
            case 'datetime':
              return 'DATETIMEOFFSET'
            case 'time':
              return 'TIME'
            case 'duration':
              return 'NVARCHAR(50)'
            case 'uuid':
              return 'UNIQUEIDENTIFIER'
            case 'binary':
              return 'VARBINARY(MAX)'
            case 'any':
              return 'NVARCHAR(MAX)'
          }
      }
    },
    identity: 'IDENTITY(1, 1)',
    uuidDefault: 'DEFAULT NEWID()',
    boolean: (value) => (value ? '1' : '0'),
    alterForeignKeys: true,
    multiRowInsert: true,
  },
  oracle: {
    quote: (name) => (simpleName.test(name) && !RESERVED.has(name) && !ORACLE_RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`),
    type: (type, enums) => {
      switch (type.kind) {
        case 'raw':
          return type.sql
        case 'json':
        case 'array':
          return 'JSON'
        case 'enum': {
          const item = enumOf(type, enums)
          return item && numericEnum(item) ? 'NUMBER(10)' : `VARCHAR2(${item ? enumWidth(item.values) : 255} CHAR)`
        }
        case 'primitive':
          switch (type.name) {
            case 'string':
              return type.length && type.length <= 4000 ? `VARCHAR2(${type.length} CHAR)` : 'CLOB'
            case 'integer':
              return type.bits === 64 ? 'NUMBER(19)' : type.bits === 8 ? 'NUMBER(3)' : type.bits === 16 ? 'NUMBER(5)' : 'NUMBER(10)'
            case 'float':
              return type.bits === 32 ? 'BINARY_FLOAT' : 'BINARY_DOUBLE'
            case 'decimal':
              return `NUMBER(${type.precision ?? 18}, ${type.scale ?? 2})`
            case 'boolean':
              return 'NUMBER(1)'
            case 'date':
              return 'DATE'
            case 'datetime':
              return 'TIMESTAMP WITH TIME ZONE'
            case 'time':
              return 'VARCHAR2(15 CHAR)'
            case 'duration':
              return 'INTERVAL DAY TO SECOND'
            case 'uuid':
              return 'RAW(16)'
            case 'binary':
              return 'BLOB'
            case 'any':
              return 'JSON'
          }
      }
    },
    identity: 'GENERATED BY DEFAULT AS IDENTITY',
    uuidDefault: 'DEFAULT SYS_GUID()',
    boolean: (value) => (value ? '1' : '0'),
    alterForeignKeys: true,
    multiRowInsert: false,
  },
}

// MariaDB writes like MySQL, with a UUID type of its own (10.7 and later)
const RULES_BY_DIALECT: Record<Dialect, DialectRules> = {
  ...RULES,
  mariadb: {
    ...RULES.mysql,
    type: (type, enums) => (type.kind === 'primitive' && type.name === 'uuid' ? 'UUID' : RULES.mysql.type(type, enums)),
  },
}

/** The database type of a column in a dialect (`VARCHAR(20)`), for writers that state it next to the code. */
export function sqlColumnType(type: ColumnType, dialect: Dialect, enums: PhysicalEnum[]): string {
  return RULES_BY_DIALECT[dialect].type(type, enums)
}

export const DIALECT_NAMES: Record<Dialect, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  oracle: 'Oracle Database',
}

function literal(value: Literal, column: Column, rules: DialectRules, enums: PhysicalEnum[]): string | null {
  if (value === null) return null
  if (typeof value === 'boolean') return rules.boolean(value)
  if (typeof value === 'number') return String(value)
  const item = enumOf(column.type, enums)
  // An enum default may be written with the member's name (`ACTIVE`) while the column stores its value
  const stored = item?.values.find((candidate) => String(candidate).toLowerCase() === value.toLowerCase()) ?? value
  return typeof stored === 'number' ? String(stored) : `'${stored.replace(/'/g, "''")}'`
}

export interface SqlOptions {
  /** Shown in the header comment: the model the schema comes from */
  title?: string
  /** Run by a migration tool (Flyway, Liquibase) inside a transaction, where SQLite's PRAGMA is not allowed */
  migration?: boolean
}

export function generateSql(schema: RelationalSchema, dialect: Dialect, options: SqlOptions = {}): string {
  const rules = RULES_BY_DIALECT[dialect]
  const q = rules.quote
  const out: string[] = []
  const header = `-- ${DIALECT_NAMES[dialect]} schema written by Model2DB${options.title ? ` from ${options.title}` : ''}.`
  out.push(header, '-- Review it before running it: nothing here has been run.')
  if (dialect === 'sqlite')
    out.push(
      '',
      options.migration ? '-- SQLite checks foreign keys on connections that run PRAGMA foreign_keys = ON.' : 'PRAGMA foreign_keys = ON;',
    )

  for (const item of schema.enums) {
    if (item.storage !== 'native' || dialect !== 'postgresql') continue
    out.push('', `CREATE TYPE ${q(item.sqlName)} AS ENUM (${stringList(item.values.map(String))});`)
  }

  const { tables, deferred } = orderTables(schema.tables)
  const later: string[] = []
  for (const table of tables) {
    const lines: string[] = []
    const inlineKey =
      dialect === 'sqlite' &&
      table.primaryKey.length === 1 &&
      table.columns.find((column) => column.name === table.primaryKey[0])?.generated === 'identity'
    for (const column of table.columns) {
      const parts = [q(column.name), rules.type(column.type, schema.enums)]
      if (inlineKey && column.name === table.primaryKey[0]) {
        lines.push(`${q(column.name)} INTEGER PRIMARY KEY`)
        continue
      }
      // Default and identity before NOT NULL: Oracle requires that order and the others accept it
      if (column.generated === 'identity' && rules.identity) parts.push(rules.identity)
      if (column.generated === 'uuid' && rules.uuidDefault) parts.push(rules.uuidDefault)
      // MySQL wants the default of a DATETIME(6) with the same precision
      if (column.generated === 'now')
        parts.push(dialect === 'mysql' || dialect === 'mariadb' ? 'DEFAULT CURRENT_TIMESTAMP(6)' : 'DEFAULT CURRENT_TIMESTAMP')
      if (column.defaultValue !== undefined) {
        const value = literal(column.defaultValue, column, rules, schema.enums)
        if (value !== null) parts.push(`DEFAULT ${value}`)
      }
      if (!column.nullable) parts.push('NOT NULL')
      lines.push(parts.join(' '))
    }
    if (table.primaryKey.length > 0 && !inlineKey)
      lines.push(`CONSTRAINT ${q(`pk_${table.name}`)} PRIMARY KEY (${table.primaryKey.map(q).join(', ')})`)
    for (const unique of table.uniques) lines.push(`CONSTRAINT ${q(unique.name)} UNIQUE (${unique.columns.map(q).join(', ')})`)
    const postponed = rules.alterForeignKeys ? (deferred.get(table.name) ?? []) : []
    for (const fk of table.foreignKeys) {
      if (postponed.includes(fk)) continue
      lines.push(foreignKeyClause(fk, q))
    }
    for (const check of table.checks) lines.push(`CONSTRAINT ${q(check.name)} CHECK (${q(check.column)} IN (${stringList(check.values)}))`)

    out.push('')
    for (const todo of table.todos) out.push(`-- ${todoText(todo, table.model, 'table')}`)
    out.push(`CREATE TABLE ${q(table.name)} (`, lines.map((line, i) => `  ${line}${i < lines.length - 1 ? ',' : ''}`).join('\n'), ');')
    if (table.kind === 'lookup') {
      const enumItem = schema.enums.find((item) => item.sqlName === table.name)
      const insert = `INSERT INTO ${q(table.name)} (${q(table.columns[0].name)}) VALUES`
      if (enumItem && rules.multiRowInsert) out.push(`${insert} ${enumItem.values.map((value) => `(${stringList([value])})`).join(', ')};`)
      else if (enumItem) for (const value of enumItem.values) out.push(`${insert} (${stringList([value])});`)
    }
    for (const index of table.indexes)
      out.push(`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(index.name)} ON ${q(table.name)} (${index.columns.map(q).join(', ')});`)
    for (const fk of postponed) later.push(`ALTER TABLE ${q(table.name)} ADD ${foreignKeyClause(fk, q)};`)
  }
  if (later.length > 0) out.push('', '-- References between tables that refer to each other', ...later)
  return out.join('\n') + '\n'
}

function foreignKeyClause(fk: ForeignKey, q: (name: string) => string): string {
  const action = fk.onDelete ? ` ON DELETE ${fk.onDelete.toUpperCase()}` : ''
  return `CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(fk.table)} (${fk.references.map(q).join(', ')})${action}`
}
