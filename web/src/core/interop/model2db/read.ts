/**
 * Reads a saved Model2DB project (`model2db-project`) into a physical schema. The project keeps the input
 * text, the design decisions and the output settings, not the tables, so the tables are built again the
 * way Model2DB builds them, with a copy of its code (`vendor/`, decision 15): the input is read with its
 * parsers, the saved design is fitted to it, and the relational build runs with the project's naming,
 * text type and engine. The result is then written as `db-schema`.
 */
import type { DbCheck, DbColumn, DbEnum, DbNote, DbSchema, DbTable, DbType, Dialect } from '../../schema/types.ts'
import { reconcile } from './vendor/design/edit.ts'
import { sqlColumnType } from './vendor/generate/sql/sql.ts'
import { readProject, type Model2DBProject, type ProjectError } from './vendor/interop/project.ts'
import { detectFormat, parseInput } from './vendor/parsers/registry.ts'
import { buildRelational } from './vendor/physical/relational.ts'
import type { Column, ColumnType, PhysicalEnum, RelationalSchema, Table } from './vendor/physical/types.ts'

export type Model2DBReadError = ProjectError | 'unreadableInput' | 'noModels' | 'notRelational'

export type Model2DBReadResult = { ok: true; schema: DbSchema } | { ok: false; error: Model2DBReadError; path?: string }

/** Engines of each relational output of Model2DB (`generate/outputs.ts`): an SQL output is its own engine,
 * an ORM or a migration tool uses the project's engine when it supports it, and its first one otherwise. */
const RELATIONAL_OUTPUTS: Record<string, readonly Dialect[] | null> = {
  postgresql: null,
  mysql: null,
  mariadb: null,
  sqlite: null,
  sqlserver: null,
  oracle: null,
  flyway: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  liquibase: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  django: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'oracle'],
  sqlalchemy: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  sqlmodel: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  tortoise: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  prisma: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver'],
  typeorm: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  sequelize: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  drizzle: ['postgresql', 'mysql', 'mariadb', 'sqlite'],
  jpa: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  hibernate: ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  'spring-data-jpa': ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle'],
  efcore: ['sqlserver', 'postgresql', 'mysql', 'mariadb', 'sqlite', 'oracle'],
  eloquent: ['mysql', 'mariadb', 'postgresql', 'sqlite', 'sqlserver'],
  doctrine: ['mysql', 'mariadb', 'postgresql', 'sqlite', 'sqlserver', 'oracle'],
}

/** Outputs that write SQL or migrations, not classes: their tables have no entity of their own. */
const SQL_OUTPUTS = new Set(['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle', 'flyway', 'liquibase'])

function engineOf(output: string, engine: Dialect): Dialect {
  const engines = RELATIONAL_OUTPUTS[output]
  if (!engines) return output as Dialect
  return engines.includes(engine) ? engine : engines[0]
}

/** The tables Model2DB builds for the project, as Model2DB itself does when the project is opened. */
function relationalOf(project: Model2DBProject): { physical: RelationalSchema; engine: Dialect } | Model2DBReadError {
  const { input, output } = project
  if (!(output.output in RELATIONAL_OUTPUTS)) return 'notRelational'
  const format = input.format ?? detectFormat(input.text, input.fileName)
  if (!format) return 'unreadableInput'
  const outcome = parseInput(input.text, format, { rootName: 'Root' })
  if (!outcome.ok) return outcome.error.code === 'noModels' ? 'noModels' : 'unreadableInput'
  if (outcome.schema.models.length === 0) return 'noModels'
  const design = reconcile(project.designs.relational, outcome.schema, 'relational')
  const engine = engineOf(output.output, output.engine)
  const physical = buildRelational(outcome.schema, design, { naming: output.naming.relational, strings: output.strings, dialect: engine })
  return { physical, engine }
}

// Writing it as db-schema

function bitsOf(type: ColumnType & { kind: 'primitive' }): 16 | 32 | 64 {
  if (type.bits === 64) return 64
  return type.bits !== undefined && type.bits <= 16 ? 16 : 32
}

function dbType(type: ColumnType, engine: Dialect, enums: PhysicalEnum[]): DbType {
  const sql = sqlColumnType(type, engine, enums)
  switch (type.kind) {
    case 'raw':
      return { sql, kind: 'unknown' }
    case 'json':
      return { sql, kind: 'json' }
    case 'array':
      return { sql, kind: 'array', items: dbType(type.items, engine, enums) }
    case 'enum': {
      const physical = enums.find((item) => item.name === type.name)
      return physical?.storage === 'native' ? { sql, kind: 'enum', name: physical.sqlName } : { sql, kind: 'text' }
    }
  }
  switch (type.name) {
    case 'string':
      return type.length !== undefined ? { sql, kind: 'text', length: type.length } : { sql, kind: 'text' }
    case 'integer':
      return { sql, kind: 'integer', bits: bitsOf(type) }
    case 'float':
      return { sql, kind: 'float', bits: type.bits === 32 ? 32 : 64 }
    case 'decimal':
      return {
        sql,
        kind: 'decimal',
        ...(type.precision !== undefined ? { precision: type.precision } : {}),
        ...(type.scale !== undefined ? { scale: type.scale } : {}),
      }
    case 'boolean':
      return { sql, kind: 'boolean' }
    case 'date':
      return { sql, kind: 'date' }
    case 'time':
      return { sql, kind: 'time', timezone: /zone|tz/i.test(sql) }
    case 'datetime':
      return { sql, kind: 'datetime', timezone: /zone|tz|offset/i.test(sql) }
    case 'uuid':
      return { sql, kind: 'uuid' }
    case 'binary':
      return { sql, kind: 'binary' }
    case 'any':
      return { sql, kind: 'json' }
    case 'duration':
      return { sql, kind: 'unknown' }
  }
}

function dbColumn(column: Column, engine: Dialect, enums: PhysicalEnum[]): DbColumn {
  return {
    name: column.name,
    type: dbType(column.type, engine, enums),
    nullable: column.nullable,
    ...(column.defaultValue !== undefined ? { default: { kind: 'literal' as const, value: column.defaultValue } } : {}),
    ...(column.generated ? { generated: column.generated } : {}),
  }
}

const quoted = (value: string | number) => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`)

function dbTable(table: Table, engine: Dialect, enums: PhysicalEnum[], withEntities: boolean): DbTable {
  const checks: DbCheck[] = table.checks.map((check) => ({
    name: check.name,
    sql: `${check.column} IN (${check.values.map(quoted).join(', ')})`,
    parsed: { kind: 'in', column: check.column, values: check.values },
  }))
  return {
    name: table.name,
    columns: table.columns.map((column) => dbColumn(column, engine, enums)),
    primaryKey: table.primaryKey.length > 0 ? table.primaryKey : null,
    foreignKeys: table.foreignKeys.map((key) => ({
      name: key.name,
      columns: key.columns,
      references: { table: key.table, columns: key.references },
      ...(key.onDelete ? { onDelete: key.onDelete } : {}),
      ...(key.field ? { attribute: key.field } : {}),
      ...(key.inverse ? { inverse: key.inverse } : {}),
    })),
    uniques: table.uniques.map((index) => ({ name: index.name, columns: index.columns })),
    indexes: table.indexes.map((index) => ({ name: index.name, columns: index.columns })),
    checks,
    ...(withEntities && table.kind === 'entity' ? { entity: table.model } : {}),
  }
}

function dbEnum(item: PhysicalEnum): DbEnum | null {
  if (item.storage !== 'native' && item.storage !== 'check') return null
  return { name: item.sqlName, values: item.values.map(String), storage: item.storage }
}

/** What the build left pending or noted, so the interface can say it. */
function notesOf(physical: RelationalSchema): DbNote[] {
  const notes: DbNote[] = physical.notes.map((note) => ({ code: `model2db.${note.code}`, params: note.params }))
  for (const table of physical.tables)
    for (const todo of table.todos) notes.push({ code: `model2db.${todo.code}`, params: { ...todo.params, table: table.name } })
  return notes
}

/** The physical schema of a saved Model2DB project, or why it cannot be read. */
export function readModel2DBProject(text: string): Model2DBReadResult {
  const read = readProject(text)
  if (!read.ok) return { ok: false, error: read.error, ...(read.path ? { path: read.path } : {}) }
  const built = relationalOf(read.project)
  if (typeof built === 'string') return { ok: false, error: built }
  const { physical, engine } = built
  const output = read.project.output.output
  const withEntities = !SQL_OUTPUTS.has(output)
  return {
    ok: true,
    schema: {
      format: 'db-schema',
      version: 1,
      dialect: engine,
      source: { kind: 'model2db', format: output },
      tables: physical.tables.map((table) => dbTable(table, engine, physical.enums, withEntities)),
      enums: physical.enums.map(dbEnum).filter((item): item is DbEnum => item !== null),
      notes: notesOf(physical),
    },
  }
}
