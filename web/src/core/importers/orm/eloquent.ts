/**
 * Reads Eloquent (Laravel) into the physical schema. The columns are in the migrations, not in the models: each
 * `Schema::create`, `Schema::table`, `Schema::drop` and `Schema::rename` with its `Blueprint` (`$table->string('email',
 * 120)->unique()`) is written as the DDL it stands for, the SQL of `DB::statement(…)` is taken as it is, and the whole,
 * in the order of the migrations, is read by the DDL reader. The models then give each table its class, the values of
 * the enums they cast to, and the names of their relations. The engine is the connection the configuration names
 * (`DB_CONNECTION`), or the one the SQL of the migrations shows.
 */
import { pluralize } from '../../model/naming.ts'
import { checkOf } from '../../schema/checks.ts'
import type { DbNote, DbSchema, Dialect } from '../../schema/types.ts'
import { Cursor, tokenize, type Token } from '../code/lexer.ts'
import { PHP_LEXER } from '../code/php.ts'
import { ddlDialect, readDdl } from '../ddl/ddl.ts'
import { booleanOf, literalOf, nameOf, numberOf, readArguments, readExpression, stringOf, textOf, type Expr } from './expressions.ts'
import { classOf, entriesOf, readClasses, SYNTAX, type PhpClass } from './php.ts'
import type { OrmReader, SourceFile } from './types.ts'

// Reading the migrations

/** A call of a Blueprint chain: `string('email', 120)`, `nullable()`. */
interface Step {
  name: string
  args: Expr[]
  named: Record<string, Expr>
}

/** Laravel's `Str::snake`: `OrderLine` → `order_line`. */
const snake = (text: string) => text.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()

/** The statements of a migration's closure that start with its Blueprint: `$table->…->…;`. */
function readBlueprint(cursor: Cursor, source: string, variable: string): Step[][] {
  const chains: Step[][] = []
  cursor.next()
  while (!cursor.done && !cursor.is('}')) {
    if (cursor.is(variable) && cursor.is('->', 1) && cursor.isIdent(2)) {
      cursor.next()
      const steps: Step[] = []
      while (cursor.eat('->') && cursor.isIdent()) {
        const name = cursor.next().value
        if (!cursor.is('(')) break
        cursor.next()
        const { args, named } = readArguments(cursor, source, SYNTAX, ')')
        steps.push({ name, args, named })
      }
      if (steps.length > 0) chains.push(steps)
      cursor.skipUntil([';'])
      cursor.eat(';')
    } else if (cursor.is('{') || cursor.is('(')) cursor.skipGroup()
    else cursor.next()
  }
  cursor.eat('}')
  return chains
}

/** What a migration does, in order: SQL of its own, or a Schema call with its table and Blueprint. */
type Operation =
  | { kind: 'sql'; sql: string }
  | { kind: 'create' | 'table'; table: string; chains: Step[][] }
  | { kind: 'drop'; table: string }
  | { kind: 'rename'; from: string; to: string }

const HEREDOC = /<<<[ \t]*(['"]?)(\w+)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2\b/g

function readMigration(text: string): Operation[] {
  // Heredocs and nowdocs (`<<<'SQL' … SQL`) become texts the lexer reads: their bodies are kept aside
  const bodies: string[] = []
  const prepared = text
    .replace(/^\s*<\?php/, (match) => ' '.repeat(match.length))
    .replace(HEREDOC, (_match, _quote, _tag, body: string) => {
      bodies.push(body)
      return `'\u0000${bodies.length - 1}'`
    })
  const textOfArg = (expr: Expr | undefined) => {
    const value = stringOf(expr)
    const heredoc = value !== undefined ? /^\u0000(\d+)$/.exec(value) : null
    return heredoc ? bodies[Number(heredoc[1])] : value
  }
  let tokens: Token[]
  try {
    tokens = tokenize(prepared, PHP_LEXER)
  } catch {
    return []
  }
  const cursor = new Cursor(tokens)
  // Only what up() does: down() undoes it
  const undo: [number, number][] = []
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== 'function' || tokens[index + 1]?.value !== 'down') continue
    cursor.index = index + 2
    while (!cursor.done && !cursor.is('{')) cursor.next()
    const start = cursor.index
    cursor.skipGroup()
    undo.push([start, cursor.index])
  }
  const operations: Operation[] = []
  for (let index = 0; index < tokens.length; index++) {
    if (undo.some(([start, end]) => index >= start && index < end)) continue
    const owner = tokens[index].value
    if ((owner !== 'Schema' && owner !== 'DB') || tokens[index + 1]?.value !== '::' || tokens[index + 3]?.value !== '(') continue
    const method = tokens[index + 2].value
    cursor.index = index + 4
    if (owner === 'DB') {
      if (method !== 'statement' && method !== 'unprepared') continue
      const sql = textOfArg(readArguments(cursor, prepared, SYNTAX, ')').args[0])
      if (sql) operations.push({ kind: 'sql', sql })
      continue
    }
    if (method === 'create' || method === 'table') {
      const table = textOfArg(readExpression(cursor, prepared, SYNTAX))
      if (!table || !cursor.eat(',')) continue
      // function (Blueprint $table) { … } or fn (Blueprint $table) => …
      if (!cursor.is('function') && !cursor.is('fn')) continue
      cursor.next()
      const parameters = cursor.index
      cursor.skipGroup()
      const variable = tokens.slice(parameters, cursor.index).find((token) => token.kind === 'ident' && token.value.startsWith('$'))?.value
      if (cursor.is('use')) {
        cursor.next()
        cursor.skipGroup()
      }
      while (!cursor.done && !cursor.is('{') && !cursor.is(')')) cursor.next()
      if (!variable || !cursor.is('{')) continue
      operations.push({ kind: method, table, chains: readBlueprint(cursor, prepared, variable) })
      index = cursor.index - 1
    } else if (method === 'drop' || method === 'dropIfExists') {
      const table = textOfArg(readArguments(cursor, prepared, SYNTAX, ')').args[0])
      if (table) operations.push({ kind: 'drop', table })
    } else if (method === 'rename') {
      const [from, to] = readArguments(cursor, prepared, SYNTAX, ')').args.map(textOfArg)
      if (from && to) operations.push({ kind: 'rename', from, to })
    }
  }
  return operations
}

// From the Blueprint to DDL

const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`
const quoteText = (text: string) => `'${text.replace(/'/g, "''")}'`
const names = (columns: string[]) => columns.map(quoteName).join(', ')

/** The columns an index call names: `'email'` or `['a', 'b']`. */
function columnsOf(expr: Expr | undefined): string[] {
  if (expr?.kind === 'list') return expr.items.map((item) => stringOf(item)).filter((item): item is string => item !== undefined)
  const one = stringOf(expr)
  return one !== undefined ? [one] : []
}

/** Laravel's name of an index: `<table>_<columns>_<kind>`. */
const indexName = (table: string, columns: string[], kind: string) =>
  `${table}_${columns.join('_')}_${kind}`.toLowerCase().replace(/[-.]/g, '_')

/** A PHP value as SQL: `'draft'`, `0`, `TRUE`, `NULL`, or `DB::raw('…')` as it is. */
function sqlValue(expr: Expr): string | undefined {
  if (expr.kind === 'call' && (nameOf(expr) === 'raw' || nameOf(expr) === 'Expression')) return stringOf(expr.args[0])
  if (expr.kind === 'name' && expr.path.length === 1 && expr.path[0].toLowerCase() === 'null') return 'NULL'
  const value = literalOf(expr)
  if (typeof value === 'string') return quoteText(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return undefined
}

const ACTIONS: Record<string, string> = {
  cascade: 'CASCADE',
  'set null': 'SET NULL',
  null: 'SET NULL',
  restrict: 'RESTRICT',
  'no action': 'NO ACTION',
  noaction: 'NO ACTION',
  'set default': 'SET DEFAULT',
}

/** The SQL type of a Blueprint column method, with what it adds: an identity key, the values of an enum. */
function columnType(step: Step, dialect: Dialect | null): { sql: string; identity?: boolean; values?: string[] } | null {
  const number = (position: number, fallback: number) => numberOf(step.args[position]) ?? fallback
  switch (step.name) {
    case 'id':
    case 'bigIncrements':
      return { sql: 'BIGINT', identity: true }
    case 'increments':
    case 'mediumIncrements':
      return { sql: 'INTEGER', identity: true }
    case 'smallIncrements':
    case 'tinyIncrements':
      return { sql: 'SMALLINT', identity: true }
    case 'bigInteger':
    case 'unsignedBigInteger':
    case 'foreignId':
    case 'foreignIdFor':
      return { sql: 'BIGINT' }
    case 'integer':
    case 'unsignedInteger':
    case 'mediumInteger':
    case 'unsignedMediumInteger':
      return { sql: 'INTEGER' }
    case 'smallInteger':
    case 'unsignedSmallInteger':
    case 'tinyInteger':
    case 'unsignedTinyInteger':
      return { sql: 'SMALLINT' }
    case 'boolean':
      return { sql: 'BOOLEAN' }
    case 'string':
      return { sql: `VARCHAR(${number(1, 255)})` }
    case 'char':
      return { sql: `CHAR(${number(1, 255)})` }
    case 'text':
    case 'tinyText':
    case 'mediumText':
    case 'longText':
    case 'set':
      return { sql: 'TEXT' }
    case 'decimal':
    case 'unsignedDecimal':
      return { sql: `DECIMAL(${number(1, 8)}, ${number(2, 2)})` }
    case 'float':
      return { sql: number(1, 53) > 24 ? 'DOUBLE PRECISION' : 'REAL' }
    case 'double':
      return { sql: 'DOUBLE PRECISION' }
    case 'date':
      return { sql: 'DATE' }
    case 'dateTime':
    case 'timestamp':
      return { sql: 'TIMESTAMP' }
    case 'dateTimeTz':
    case 'timestampTz':
      return { sql: 'TIMESTAMPTZ' }
    case 'time':
      return { sql: 'TIME' }
    case 'timeTz':
      return { sql: 'TIMETZ' }
    case 'year':
      return { sql: 'YEAR' }
    case 'uuid':
    case 'foreignUuid':
      return { sql: 'UUID' }
    case 'ulid':
    case 'foreignUlid':
      return { sql: 'CHAR(26)' }
    case 'json':
      return { sql: 'JSON' }
    case 'jsonb':
      return { sql: 'JSONB' }
    case 'binary':
      return { sql: 'BLOB' }
    case 'ipAddress':
      return { sql: 'VARCHAR(45)' }
    case 'macAddress':
      return { sql: 'VARCHAR(17)' }
    case 'enum': {
      const values = columnsOf(step.args[1])
      // MySQL keeps an enum as a type of the column; PostgreSQL and SQLite as text with a CHECK
      if (dialect === 'postgresql' || dialect === 'sqlite') return { sql: 'VARCHAR(255)', values }
      return { sql: `ENUM(${values.map(quoteText).join(', ')})` }
    }
    default:
      return null
  }
}

/** The columns a method adds on its own: `timestamps()`, `softDeletes()`, `rememberToken()`, `morphs('owner')`. */
function shorthand(step: Step): { name: string; sql: string; nullable: boolean }[] | null {
  const name = stringOf(step.args[0])
  switch (step.name) {
    case 'timestamps':
    case 'nullableTimestamps':
      return ['created_at', 'updated_at'].map((column) => ({ name: column, sql: 'TIMESTAMP', nullable: true }))
    case 'timestampsTz':
      return ['created_at', 'updated_at'].map((column) => ({ name: column, sql: 'TIMESTAMPTZ', nullable: true }))
    case 'softDeletes':
      return [{ name: name ?? 'deleted_at', sql: 'TIMESTAMP', nullable: true }]
    case 'softDeletesTz':
      return [{ name: name ?? 'deleted_at', sql: 'TIMESTAMPTZ', nullable: true }]
    case 'rememberToken':
      return [{ name: 'remember_token', sql: 'VARCHAR(100)', nullable: true }]
    case 'morphs':
    case 'nullableMorphs':
    case 'uuidMorphs':
    case 'nullableUuidMorphs':
      if (!name) return null
      return [
        { name: `${name}_type`, sql: 'VARCHAR(255)', nullable: step.name.startsWith('nullable') },
        { name: `${name}_id`, sql: step.name.includes('Uuid') ? 'UUID' : 'BIGINT', nullable: step.name.startsWith('nullable') },
      ]
    default:
      return null
  }
}

/** The DDL of one Schema::create or Schema::table. */
function blueprintSql(
  operation: Operation & { kind: 'create' | 'table' },
  dialect: Dialect | null,
  tableOf: (model: string) => string,
): string[] {
  const { table } = operation
  const columns: string[] = []
  const constraints: string[] = []
  const after: string[] = []
  const alter = operation.kind === 'table'
  const add = (definition: string, changed = false) =>
    alter
      ? after.push(`ALTER TABLE ${quoteName(table)} ${changed ? 'MODIFY COLUMN' : 'ADD COLUMN'} ${definition}`)
      : columns.push(definition)
  const constraint = (definition: string) =>
    alter ? after.push(`ALTER TABLE ${quoteName(table)} ADD ${definition}`) : constraints.push(definition)
  const index = (columnList: string[], given: string | undefined) =>
    after.push(`CREATE INDEX ${quoteName(given ?? indexName(table, columnList, 'index'))} ON ${quoteName(table)} (${names(columnList)})`)
  const drop = (name: string) => after.push(`ALTER TABLE ${quoteName(table)} DROP CONSTRAINT ${quoteName(name)}`)
  const foreign = (columnList: string[], steps: Step[], given: string | undefined, target?: { table: string; column: string }) => {
    const references = steps.find((step) => step.name === 'references')
    const on = steps.find((step) => step.name === 'on')
    const parent = target?.table ?? stringOf(on?.args[0])
    if (!parent) return
    const referenced = target ? [target.column] : columnsOf(references?.args[0])
    let sql = `CONSTRAINT ${quoteName(given ?? indexName(table, columnList, 'foreign'))} FOREIGN KEY (${names(columnList)}) REFERENCES ${quoteName(parent)} (${names(referenced.length > 0 ? referenced : ['id'])})`
    for (const step of steps) {
      const which = /OnDelete$|^onDelete$/.test(step.name) ? 'DELETE' : /OnUpdate$|^onUpdate$/.test(step.name) ? 'UPDATE' : undefined
      if (!which) continue
      const action =
        step.name === 'onDelete' || step.name === 'onUpdate'
          ? ACTIONS[(stringOf(step.args[0]) ?? '').toLowerCase()]
          : ACTIONS[step.name.replace(/On(Delete|Update)$/, '').toLowerCase()]
      if (action) sql += ` ON ${which} ${action}`
    }
    constraint(sql)
  }

  for (const chain of operation.chains) {
    const [first, ...modifiers] = chain
    const name = stringOf(first.args[0])
    // Constraints of the table: primary(['a', 'b']), unique('email'), index([...]), foreign('user_id')->…
    if (first.name === 'primary' || first.name === 'unique' || first.name === 'index' || first.name === 'foreign') {
      const columnList = columnsOf(first.args[0])
      const given = stringOf(first.args[1])
      if (columnList.length === 0) continue
      if (first.name === 'primary')
        constraint(`CONSTRAINT ${quoteName(given ?? indexName(table, columnList, 'primary'))} PRIMARY KEY (${names(columnList)})`)
      else if (first.name === 'unique')
        constraint(`CONSTRAINT ${quoteName(given ?? indexName(table, columnList, 'unique'))} UNIQUE (${names(columnList)})`)
      else if (first.name === 'index') index(columnList, given)
      else foreign(columnList, modifiers, given)
      continue
    }
    if (first.name === 'dropColumn') {
      const dropped = first.args.flatMap(columnsOf)
      for (const column of dropped) after.push(`ALTER TABLE ${quoteName(table)} DROP COLUMN ${quoteName(column)}`)
      continue
    }
    if (first.name === 'dropTimestamps' || first.name === 'dropTimestampsTz') {
      for (const column of ['created_at', 'updated_at']) after.push(`ALTER TABLE ${quoteName(table)} DROP COLUMN ${quoteName(column)}`)
      continue
    }
    if (first.name === 'dropSoftDeletes' || first.name === 'dropSoftDeletesTz') {
      after.push(`ALTER TABLE ${quoteName(table)} DROP COLUMN ${quoteName(name ?? 'deleted_at')}`)
      continue
    }
    if (first.name === 'dropUnique' || first.name === 'dropForeign' || first.name === 'dropPrimary') {
      const kind = first.name.slice(4).toLowerCase()
      const columnList = first.args[0]?.kind === 'list' ? columnsOf(first.args[0]) : []
      drop(columnList.length > 0 ? indexName(table, columnList, kind) : (name ?? indexName(table, [], kind)))
      continue
    }
    if (first.name === 'comment') continue
    const many = shorthand(first)
    if (many) {
      for (const column of many) add(`${quoteName(column.name)} ${column.sql} ${column.nullable ? 'NULL' : 'NOT NULL'}`)
      if (first.name.endsWith('orphs') && name) index([`${name}_type`, `${name}_id`], undefined)
      continue
    }
    const type = columnType(first, dialect)
    // id() is named `id`; foreignIdFor(User::class) `user_id`
    const model = first.name === 'foreignIdFor' ? classOf(first.args[0]) : undefined
    const column = first.name === 'id' ? (name ?? 'id') : model ? (stringOf(first.args[1]) ?? `${snake(model)}_id`) : name
    if (!type || !column) continue
    const has = (method: string) => modifiers.find((step) => step.name === method)
    const nullable = has('nullable') ? booleanOf(has('nullable')!.args[0]) !== false : false
    let definition = `${quoteName(column)} ${type.sql} ${nullable ? 'NULL' : 'NOT NULL'}`
    const defaultStep = has('default')
    const value = defaultStep?.args[0] ? sqlValue(defaultStep.args[0]) : undefined
    if (value !== undefined) definition += ` DEFAULT ${value}`
    if (has('useCurrent')) definition += ' DEFAULT CURRENT_TIMESTAMP'
    if (has('useCurrentOnUpdate')) definition += ' ON UPDATE CURRENT_TIMESTAMP'
    const stored = has('storedAs') ?? has('virtualAs')
    const expression = stored ? (stringOf(stored.args[0]) ?? textOf(stored.args[0])) : undefined
    if (expression) definition += ` GENERATED ALWAYS AS (${expression}) ${stored!.name === 'storedAs' ? 'STORED' : 'VIRTUAL'}`
    if (type.identity || has('autoIncrement') || has('generatedAs')) definition += ' GENERATED BY DEFAULT AS IDENTITY'
    if (type.identity || has('primary')) definition += ' PRIMARY KEY'
    const comment = stringOf(has('comment')?.args[0])
    if (comment) definition += ` COMMENT ${quoteText(comment)}`
    if (type.values) definition += ` CHECK (${quoteName(column)} IN (${type.values.map(quoteText).join(', ')}))`
    add(definition, !!has('change'))
    const unique = has('unique')
    if (unique)
      constraint(`CONSTRAINT ${quoteName(stringOf(unique.args[0]) ?? indexName(table, [column], 'unique'))} UNIQUE (${quoteName(column)})`)
    const indexed = has('index')
    if (indexed) index([column], stringOf(indexed.args[0]))
    // foreignId('user_id')->constrained() points to users.id; foreignIdFor(User::class) to the model's table
    const constrained = has('constrained')
    if (constrained) {
      const parent = stringOf(constrained.args[0]) ?? (model ? tableOf(model) : pluralize(column.replace(/_id$/, '')))
      foreign([column], modifiers, stringOf(constrained.named.indexName), { table: parent, column: stringOf(constrained.args[1]) ?? 'id' })
    } else if (has('references')) foreign([column], modifiers, undefined)
  }
  if (operation.kind === 'create') {
    const comment = operation.chains.find((chain) => chain[0].name === 'comment' && chain.length === 1)
    const options = comment ? ` COMMENT=${quoteText(stringOf(comment[0].args[0]) ?? '')}` : ''
    return [`CREATE TABLE ${quoteName(table)} (\n  ${[...columns, ...constraints].join(',\n  ')}\n)${options}`, ...after]
  }
  return after
}

// The connection

const CONNECTIONS: Record<string, Dialect> = {
  pgsql: 'postgresql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  sqlsrv: 'sqlserver',
}

/** The engine the configuration names: `DB_CONNECTION=pgsql`, or the default of config/database.php. */
function connectionOf(files: SourceFile[]): Dialect | null {
  for (const file of files) {
    const match =
      /^\s*DB_CONNECTION\s*=\s*['"]?(\w+)/m.exec(file.text) ??
      /['"]default['"]\s*=>\s*env\(\s*['"]DB_CONNECTION['"]\s*,\s*['"](\w+)['"]/.exec(file.text)
    if (match && CONNECTIONS[match[1]]) return CONNECTIONS[match[1]]
  }
  return null
}

// The models

const MODEL_BASES = new Set(['Model', 'Authenticatable', 'Pivot', 'MorphPivot'])

const quoted = (values: (string | number)[]) =>
  values.map((value) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)).join(', ')

function readEloquent(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const classes = readClasses(files.filter((file) => /\b(class|enum)\s+\w+/.test(file.text)))
  const byName = new Map(classes.map((cls) => [cls.name, cls]))
  const isModel = (cls: PhpClass, seen = new Set<string>()): boolean => {
    seen.add(cls.name)
    if (!cls.base) return false
    if (MODEL_BASES.has(cls.base)) return true
    const base = byName.get(cls.base)
    return !!base && !seen.has(base.name) && isModel(base, seen)
  }
  const models = classes.filter((cls) => cls.kind === 'class' && isModel(cls))
  const property = (cls: PhpClass, name: string) => cls.properties.find((item) => item.name === name)?.initializer
  const tableOf = (model: string) => {
    const cls = byName.get(model)
    return (cls && stringOf(property(cls, 'table'))) ?? snake(pluralize(model))
  }

  // The migrations, in the order of their names, as one DDL text
  const migrations = files
    .filter((file) => /\bSchema::|\bDB::(statement|unprepared)\b/.test(file.text))
    .sort((a, b) => a.name.localeCompare(b.name))
  const operations = migrations.flatMap((file) => readMigration(file.text))
  const rawSql = operations.flatMap((operation) => (operation.kind === 'sql' ? [operation.sql] : []))
  const dialect = connectionOf(files) ?? (rawSql.length > 0 ? ddlDialect(rawSql.join(';\n')) : null)
  const statements = operations.flatMap((operation) => {
    if (operation.kind === 'sql') return [operation.sql]
    if (operation.kind === 'drop') return [`DROP TABLE IF EXISTS ${quoteName(operation.table)}`]
    if (operation.kind === 'rename') return [`ALTER TABLE ${quoteName(operation.from)} RENAME TO ${quoteName(operation.to)}`]
    return blueprintSql(operation, dialect, tableOf)
  })
  const schema = readDdl(statements.join(';\n'), dialect)
  notes.push(...schema.notes)

  for (const model of models) {
    const tableName = tableOf(model.name)
    const table = schema.tables.find((item) => item.name === tableName)
    if (!table) {
      notes.push({ code: 'orm.modelWithoutTable', params: { table: tableName } })
      continue
    }
    table.entity = model.name
    // Casts to an enum: the values it keeps, checked
    const casts =
      property(model, 'casts') ?? model.methods.find((method) => method.name === 'casts')?.returns.find((item) => item.kind === 'dict')
    for (const [column, cast] of entriesOf(casts)) {
      const enumClass = byName.get(classOf(cast) ?? '')
      const target = table.columns.find((item) => item.name === column)
      // A column that is already an enum of the database needs no CHECK
      if (enumClass?.kind !== 'enum' || !target || target.type.kind === 'enum') continue
      const values = enumClass.cases.map((item) => item.value ?? item.name)
      const enumName = snake(enumClass.name)
      if (!schema.enums.some((item) => item.name === enumName))
        schema.enums.push({ name: enumName, values: values.map(String), storage: 'check' })
      if (!table.checks.some((check) => check.parsed?.kind === 'in' && check.parsed.column === column))
        table.checks.push(checkOf(`${column} IN (${quoted(values)})`))
    }
    // Relations name the foreign keys: belongsTo on this side, hasMany and hasOne on the other
    for (const method of model.methods) {
      const relation = method.returns.find((item) => item.kind === 'call')
      if (relation?.kind !== 'call') continue
      const kind = nameOf(relation)
      const related = classOf(relation.args[0])
      if (!related || !kind) continue
      if (kind === 'belongsTo') {
        const column = stringOf(relation.args[1]) ?? `${snake(method.name)}_${stringOf(relation.args[2]) ?? 'id'}`
        const key = table.foreignKeys.find((item) => item.columns.length === 1 && item.columns[0] === column)
        if (key && !key.attribute) key.attribute = method.name
      } else if (kind === 'hasMany' || kind === 'hasOne') {
        const other = schema.tables.find((item) => item.name === tableOf(related))
        const column = stringOf(relation.args[1]) ?? `${snake(model.name)}_id`
        const key = other?.foreignKeys.find(
          (item) => item.columns.length === 1 && item.columns[0] === column && item.references.table === table.name,
        )
        if (key && !key.inverse) key.inverse = method.name
      }
    }
  }
  return { ...schema, source: { kind: 'orm', format: 'eloquent' }, notes }
}

export const eloquentReader: OrmReader = {
  id: 'eloquent',
  label: 'Eloquent',
  language: 'php',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\bIlluminate\\(Database|Support\\Facades)\b/.test(text) &&
      /\bSchema::(create|table)\b|\bextends\s+(Model|Authenticatable|Pivot)\b/.test(text)
      ? 1
      : 0
  },
  read: readEloquent,
}
