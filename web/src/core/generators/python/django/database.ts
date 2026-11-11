/**
 * The database layer of a Django project: `app/settings.py` (only what the ORM needs, the database from
 * DATABASE_URL), `app/models.py` (imports every entity, so Django's app registry knows them) and the model of
 * each table: exact table and column names (`db_table`, `db_column`), precise fields, every constraint the
 * ORM can express, and a `TODO` where it cannot. No migrations are written: the database already exists.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbCheck, DbForeignKey, DbType } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { Imports, pyLiteral } from '../python.ts'
import { findInfo, moduleOf, pathOf, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'

const URLS: Record<string, string> = {
  postgresql: 'postgresql://app:app@localhost:5432/app',
  mysql: 'mysql://app:app@localhost:3306/app',
  mariadb: 'mysql://app:app@localhost:3306/app',
  sqlite: 'sqlite:///./app.db',
}

export function defaultUrl(context: Context): string {
  return URLS[context.settings.database] ?? URLS.postgresql
}

export function settingsFile(context: Context): GeneratedFile {
  return {
    path: 'app/settings.py',
    content: lines(
      '"""Django settings of the data access layer: only what the ORM needs. The database comes from DATABASE_URL;',
      'see .env.example. Import this module from your project\'s settings, or point DJANGO_SETTINGS_MODULE to it."""',
      '',
      'import os',
      'from urllib.parse import unquote, urlsplit',
      '',
      '',
      'def database_from_url(url: str) -> dict[str, str]:',
      '    """A Django database from a URL: postgresql://user:password@host:port/name, mysql://…, sqlite:///path or',
      '    sqlite://:memory:. A driver after the scheme (postgresql+psycopg) is ignored."""',
      '    parts = urlsplit(url)',
      '    scheme = parts.scheme.split("+", 1)[0]',
      '    if scheme == "sqlite":',
      '        return {"ENGINE": "django.db.backends.sqlite3", "NAME": parts.netloc or parts.path[1:] or ":memory:"}',
      '    engine = {"postgresql": "postgresql", "postgres": "postgresql", "mysql": "mysql", "mariadb": "mysql"}[scheme]',
      '    if engine == "mysql":',
      '        # PyMySQL stands in for mysqlclient, which needs a C compiler and the MySQL client library',
      '        import pymysql',
      '',
      '        pymysql.install_as_MySQLdb()',
      '    return {',
      '        "ENGINE": f"django.db.backends.{engine}",',
      '        "NAME": parts.path.lstrip("/"),',
      '        "USER": unquote(parts.username or ""),',
      '        "PASSWORD": unquote(parts.password or ""),',
      '        "HOST": parts.hostname or "",',
      '        "PORT": str(parts.port or ""),',
      '    }',
      '',
      '',
      'SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "only-the-orm-is-used-change-it-in-your-project")',
      'INSTALLED_APPS = ["app"]',
      `DATABASES = {"default": database_from_url(os.environ.get("DATABASE_URL", "${defaultUrl(context)}"))}`,
      'USE_TZ = True',
      'TIME_ZONE = "UTC"',
      'DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"',
      '',
    ),
  }
}

/** `app/models.py`: Django finds the models of an app in this module, so it imports every entity. */
export function modelsFile(context: Context): GeneratedFile {
  const imports = new Imports()
  const written = context.tables.filter((info) => info.writesEntity)
  for (const info of written) imports.from(moduleOf(context, info, 'entity'), info.entity)
  return {
    path: 'app/models.py',
    content: lines(
      '"""The models of the app, imported here so Django\'s app registry and the test database know every table."""',
      '',
      imports.write('app'),
      '',
      `__all__ = [${written.map((info) => `"${info.entity}"`).join(', ')}]`,
      '',
    ),
  }
}

// Fields

/** The Django field of a foreign key column, when the ORM can express it: a single column named `<x>_id` to the
 * primary key of a table with a single-column key. Django names the field `<x>` and keeps `<x>_id` as its column. */
function foreignKeyField(
  context: Context,
  info: TableInfo,
  column: ColumnInfo,
): { key: DbForeignKey; name: string; target: TableInfo } | null {
  const key = info.table.foreignKeys.find((item) => item.columns.length === 1 && item.columns[0] === column.column.name)
  if (!key || !column.attr.endsWith('_id') || column.attr === '_id') return null
  const target = findInfo(context, key.references.table)
  if (!target || target.key.length !== 1 || target.key[0].column.name !== key.references.columns[0] || !target.table.primaryKey) return null
  return { key, name: column.attr.slice(0, -3), target }
}

const ON_DELETE: Record<string, string> = {
  cascade: 'CASCADE',
  'set null': 'SET_NULL',
  'set default': 'SET_DEFAULT',
  restrict: 'RESTRICT',
  'no action': 'DO_NOTHING',
}

/** The name of a column's field in the model: the foreign key's name, or the column's attribute. */
export function fieldName(context: Context, info: TableInfo, column: ColumnInfo): string {
  return foreignKeyField(context, info, column)?.name ?? column.attr
}

function fieldType(context: Context, type: DbType, todos: string[]): { field: string; args: string[] } {
  switch (type.kind) {
    case 'integer':
      return { field: type.bits === 16 ? 'SmallIntegerField' : type.bits === 64 ? 'BigIntegerField' : 'IntegerField', args: [] }
    case 'decimal':
      if (type.precision === undefined) todos.push(`"${type.sql}" declares no precision: 20 digits, 6 decimals are assumed`)
      return {
        field: 'DecimalField',
        args: [`max_digits=${type.precision ?? 20}`, `decimal_places=${type.scale ?? (type.precision === undefined ? 6 : 0)}`],
      }
    case 'float':
      return { field: 'FloatField', args: [] }
    case 'text':
      if (type.length === undefined) return { field: 'TextField', args: [] }
      if (type.fixed) todos.push(`"${type.sql}" has a fixed length; Django writes it as VARCHAR`)
      return { field: 'CharField', args: [`max_length=${type.length}`] }
    case 'boolean':
      return { field: 'BooleanField', args: [] }
    case 'date':
      return { field: 'DateField', args: [] }
    case 'time':
      return { field: 'TimeField', args: [] }
    case 'datetime':
      return { field: 'DateTimeField', args: [] }
    case 'uuid':
      return { field: 'UUIDField', args: [] }
    case 'binary':
      return { field: 'BinaryField', args: [] }
    case 'json':
      return { field: 'JSONField', args: [] }
    case 'array':
      todos.push(`"${type.sql}" is kept as JSON; use django.contrib.postgres ArrayField on PostgreSQL if you need the native array`)
      return { field: 'JSONField', args: [] }
    case 'enum': {
      const item = context.schema.enums.find((candidate) => candidate.name === type.name)
      const values = item?.values ?? []
      const length = Math.max(1, ...values.map((value) => value.length))
      return {
        field: 'CharField',
        args: [
          `max_length=${length}`,
          `choices=[${values.map((value) => `(${JSON.stringify(value)}, ${JSON.stringify(value)})`).join(', ')}]`,
        ],
      }
    }
    case 'unknown':
      todos.push(`"${type.sql}" has no Django field here; it is mapped as text`)
      return { field: 'TextField', args: [] }
  }
}

function fieldLine(context: Context, info: TableInfo, column: ColumnInfo, imports: Imports): Line[] {
  const db = column.column
  const todos: string[] = []
  const singleKey = info.table.primaryKey?.length === 1 && info.table.primaryKey[0] === db.name
  const foreign = foreignKeyField(context, info, column)
  const args: string[] = []
  let field: string
  if (foreign) {
    field = 'ForeignKey'
    args.push(
      JSON.stringify(foreign.target.entity),
      `on_delete=models.${ON_DELETE[foreign.key.onDelete ?? 'no action']}`,
      'related_name="+"',
    )
    args.push(`db_column=${JSON.stringify(db.name)}`)
  } else {
    const relation = info.table.foreignKeys.find((key) => key.columns.includes(db.name))
    if (relation)
      todos.push(
        `${relation.columns.join(', ')} points to ${relation.references.table}; Django can only express single-column keys named <x>_id to a single-column primary key`,
      )
    if (db.generated === 'identity' && singleKey) {
      field =
        db.type.kind === 'integer' && db.type.bits === 16
          ? 'SmallAutoField'
          : db.type.kind === 'integer' && db.type.bits === 32
            ? 'AutoField'
            : 'BigAutoField'
    } else {
      const type = fieldType(context, db.type, todos)
      field = type.field
      args.push(...type.args)
    }
    if (column.attr !== db.name) args.push(`db_column=${JSON.stringify(db.name)}`)
  }
  if (singleKey) args.push('primary_key=True')
  if (db.generated === 'uuid') {
    imports.module('uuid')
    args.push('default=uuid.uuid4')
  }
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    imports.from('django.db.models.functions', 'Now')
    args.push('db_default=Now()')
    if (db.generated === 'onUpdateNow') args.push('auto_now=True')
  }
  if (typeof db.generated === 'object') todos.push(`computed by the database as ${db.generated.computed}; never written by the application`)
  if (db.default?.kind === 'literal') args.push(`default=${pyLiteral(db.default.value)}`)
  if (db.default?.kind === 'expression') todos.push(`the database fills it with ${db.default.sql} when it is left out`)
  if (db.nullable && !singleKey) args.push('null=True', 'blank=True')
  const name = foreign?.name ?? column.attr
  return [...todos.map((todo) => `    # TODO: ${todo}`), `    ${name} = models.${field}(${args.join(', ')})`]
}

/** The CHECK constraints Django can express, as Q objects; the others become a TODO. */
function checkConstraint(context: Context, info: TableInfo, check: DbCheck, index: number, imports: Imports): string | null {
  const parsed = check.parsed
  if (!parsed || parsed.kind === 'length') return null
  const column = info.columns.find((item) => item.column.name === parsed.column)
  if (!column) return null
  const field = fieldName(context, info, column)
  const lookup =
    parsed.kind === 'in'
      ? `${field}__in=[${parsed.values.map((value) => JSON.stringify(value)).join(', ')}]`
      : `${field}__${{ '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' }[parsed.op]}=${parsed.value}`
  imports.from('django.db.models', 'Q')
  const name = check.name ?? `ck_${info.name}_${parsed.column}_${index}`
  return `models.CheckConstraint(condition=Q(${lookup}), name=${JSON.stringify(name)})`
}

/** Django refuses index names longer than 30 characters. */
const indexName = (name: string) => (name.length <= 30 ? name : name.slice(0, 30))

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const imports = new Imports().from('django.db', 'models')
  const fields = info.columns.flatMap((column) => fieldLine(context, info, column, imports))
  const names = (columns: string[]) =>
    columns
      .map((name) =>
        JSON.stringify(
          fieldName(
            context,
            info,
            info.columns.find((column) => column.column.name === name)!,
          ),
        ),
      )
      .join(', ')
  const attrs = (columns: string[]) =>
    columns.map((name) => JSON.stringify(info.columns.find((column) => column.column.name === name)!.attr)).join(', ')
  const constraints: string[] = []
  const todos: string[] = []
  for (const unique of info.table.uniques)
    constraints.push(
      `models.UniqueConstraint(fields=[${names(unique.columns)}], name=${JSON.stringify(unique.name ?? `uq_${info.name}_${unique.columns.join('_')}`)})`,
    )
  info.table.checks.forEach((check, index) => {
    const constraint = checkConstraint(context, info, check, index, imports)
    if (constraint) constraints.push(constraint)
    else todos.push(`CHECK (${check.sql}) is kept by the database; Django cannot express it`)
  })
  const indexes = info.table.indexes.map(
    (index) =>
      `models.Index(fields=[${names(index.columns)}], name=${JSON.stringify(indexName(index.name ?? `ix_${info.name}_${index.columns.join('_')}`))})`,
  )
  if (info.table.schema) todos.push(`the table is in the "${info.table.schema}" schema; set the search path or db_table for it`)
  const compositeKey = info.table.primaryKey ? info.table.primaryKey.length > 1 : true
  const content = lines(
    `"""Entity of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}."""`,
    '',
    imports.write('app'),
    '',
    '',
    `class ${info.entity}(models.Model):`,
    `    """A row of the "${info.name}" table."""`,
    '',
    compositeKey && [
      !info.table.primaryKey && '    # The table has no primary key: rows are told apart by all their columns, for reading only',
      `    pk = models.CompositePrimaryKey(${attrs(info.key.map((column) => column.column.name))})`,
    ],
    fields,
    '',
    '    class Meta:',
    `        db_table = ${JSON.stringify(info.name)}`,
    !info.table.primaryKey && [
      '        # Read only: Django never creates or changes this table, so the key above stays in the ORM',
      '        managed = False',
    ],
    ...todos.map((todo) => `        # TODO: ${todo}`),
    constraints.length > 0 && ['        constraints = [', ...constraints.map((item) => `            ${item},`), '        ]'],
    indexes.length > 0 && ['        indexes = [', ...indexes.map((item) => `            ${item},`), '        ]'],
    '',
  )
  return { path: pathOf(moduleOf(context, info, 'entity')), content }
}

export function databaseFiles(context: Context): GeneratedFile[] {
  return [
    settingsFile(context),
    modelsFile(context),
    ...context.tables.filter((info) => info.writesEntity).map((info) => entityFile(context, info)),
  ]
}
