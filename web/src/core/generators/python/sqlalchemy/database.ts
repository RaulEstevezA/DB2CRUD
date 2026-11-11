/**
 * `app/db.py` (engine, sessions and the declarative base) and the entity of each table: exact table and
 * column names, precise types and every constraint of the input, so the entities reflect the database
 * instead of designing it. No migrations are written: the database already exists.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbForeignKey, DbType } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { Imports, pyLiteral } from '../python.ts'
import { columnPyType, moduleOf, pathOf, writesEntities, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'

const SYNC_URLS: Record<string, string> = {
  postgresql: 'postgresql+psycopg://app:app@localhost:5432/app',
  mysql: 'mysql+pymysql://app:app@localhost:3306/app',
  mariadb: 'mysql+pymysql://app:app@localhost:3306/app',
  sqlite: 'sqlite:///./app.db',
}

export function defaultUrl(context: Context): string {
  return SYNC_URLS[context.settings.database] ?? SYNC_URLS.postgresql
}

export function dbFile(context: Context): GeneratedFile {
  const imports = new Imports().module('os')
  const base = writesEntities(context)
  if (context.async) {
    imports
      .from('sqlalchemy', 'event')
      .from('sqlalchemy.ext.asyncio', 'AsyncEngine', 'AsyncSession', 'async_sessionmaker', 'create_async_engine')
  } else {
    imports.from('sqlalchemy', 'Engine', 'create_engine', 'event').from('sqlalchemy.orm', 'Session', 'sessionmaker')
  }
  if (base) imports.from('sqlalchemy.orm', 'DeclarativeBase')
  const engine = context.async ? 'AsyncEngine' : 'Engine'
  const content = lines(
    `"""Database engine, sessions${base ? ' and the declarative base of the entities' : ''} (SQLAlchemy 2${context.async ? ', asynchronous' : ''}).`,
    '',
    'The URL comes from DATABASE_URL; see .env.example.',
    '"""',
    '',
    imports.write('app'),
    '',
    `DATABASE_URL = os.environ.get("DATABASE_URL", "${defaultUrl(context)}")`,
    '',
    base && ['', 'class Base(DeclarativeBase):', '    """Base of every entity."""', ''],
    context.async && [
      '',
      '# The asynchronous driver of each database the synchronous URLs name',
      '_ASYNC_DRIVERS = {"sqlite": "sqlite+aiosqlite", "sqlite+pysqlite": "sqlite+aiosqlite", "mysql+pymysql": "mysql+aiomysql", "mariadb+pymysql": "mysql+aiomysql"}',
      '',
      '',
      'def async_url(url: str) -> str:',
      '    """The same database with an asynchronous driver: psycopg already is one."""',
      '    scheme, separator, rest = url.partition("://")',
      '    return _ASYNC_DRIVERS.get(scheme, scheme) + separator + rest',
    ],
    '',
    '',
    `def create_db_engine(url: str = DATABASE_URL) -> ${engine}:`,
    '    """An engine for the database at `url`. SQLite gets foreign keys turned on, as other databases have them."""',
    context.async
      ? '    engine = create_async_engine(async_url(url), pool_pre_ping=not url.startswith("sqlite"))'
      : '    engine = create_engine(url, pool_pre_ping=not url.startswith("sqlite"))',
    '    if url.startswith("sqlite"):',
    '',
    `        @event.listens_for(engine${context.async ? '.sync_engine' : ''}, "connect")`,
    '        def _foreign_keys(connection, _record) -> None:  # type: ignore[no-untyped-def]',
    '            cursor = connection.cursor()',
    '            cursor.execute("PRAGMA foreign_keys=ON")',
    '            cursor.close()',
    '',
    '    return engine',
    '',
    '',
    context.async
      ? 'def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:'
      : 'def create_session_factory(engine: Engine) -> sessionmaker[Session]:',
    '    """Sessions that keep loaded rows readable after a commit."""',
    context.async
      ? '    return async_sessionmaker(engine, expire_on_commit=False)'
      : '    return sessionmaker(engine, expire_on_commit=False)',
    '',
  )
  return { path: 'app/db.py', content }
}

// Entities

function saType(type: DbType, imports: Imports, key: boolean): string {
  const sa = (name: string) => {
    imports.from('sqlalchemy', name)
    return name
  }
  switch (type.kind) {
    case 'integer':
      // SQLite only numbers rows by itself on INTEGER PRIMARY KEY
      if (type.bits === 64 && key) return `${sa('BigInteger')}().with_variant(${sa('Integer')}(), "sqlite")`
      return `${sa(type.bits === 16 ? 'SmallInteger' : type.bits === 64 ? 'BigInteger' : 'Integer')}()`
    case 'decimal':
      return type.precision !== undefined ? `${sa('Numeric')}(${type.precision}, ${type.scale ?? 0})` : `${sa('Numeric')}()`
    case 'float':
      return type.bits === 32 ? `${sa('Float')}()` : `${sa('Double')}()`
    case 'text':
      if (type.length === undefined) return `${sa('Text')}()`
      return `${sa(type.fixed ? 'CHAR' : 'String')}(${type.length})`
    case 'boolean':
      return `${sa('Boolean')}()`
    case 'date':
      return `${sa('Date')}()`
    case 'time':
      return `${sa('Time')}(timezone=${type.timezone ? 'True' : 'False'})`
    case 'datetime':
      return `${sa('DateTime')}(timezone=${type.timezone ? 'True' : 'False'})`
    case 'uuid':
      return `${sa('Uuid')}()`
    case 'binary':
      return type.length !== undefined ? `${sa('LargeBinary')}(${type.length})` : `${sa('LargeBinary')}()`
    case 'json':
    case 'array':
      // Arrays are portable as JSON; a native PostgreSQL array is a decision for the user
      return `${sa('JSON')}()`
    case 'enum':
      return `${sa('String')}(${Math.max(1, type.name.length)})`
    case 'unknown':
      return `${sa('Text')}()`
  }
}

function enumType(context: Context, type: DbType & { kind: 'enum' }, imports: Imports): string {
  const item = context.schema.enums.find((candidate) => candidate.name === type.name)
  if (!item) return saType({ sql: type.sql, kind: 'text' }, imports, false)
  imports.from('sqlalchemy', 'Enum')
  return `Enum(${item.values.map((value) => JSON.stringify(value)).join(', ')}, name=${JSON.stringify(item.name)})`
}

function columnLine(context: Context, info: TableInfo, column: ColumnInfo, imports: Imports): Line[] {
  const { column: db } = column
  const isKey = info.table.primaryKey?.includes(db.name) ?? false
  const type = db.type.kind === 'enum' ? enumType(context, db.type, imports) : saType(db.type, imports, isKey)
  const args: string[] = []
  if (column.attr !== db.name) args.push(JSON.stringify(db.name))
  args.push(type)
  const singleKey = info.table.foreignKeys.find((key) => key.columns.length === 1 && key.columns[0] === db.name)
  if (singleKey) args.push(foreignKey(singleKey, imports))
  if (isKey) args.push('primary_key=True')
  if (db.generated === 'identity') args.push('autoincrement=True')
  if (db.generated === 'uuid') {
    imports.from('uuid', 'uuid4')
    args.push('default=uuid4')
  }
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    imports.from('sqlalchemy', 'func')
    args.push('server_default=func.now()')
    if (db.generated === 'onUpdateNow') args.push('onupdate=func.now()')
  }
  if (typeof db.generated === 'object') {
    imports.from('sqlalchemy', 'Computed')
    args.push(`Computed(${JSON.stringify(db.generated.computed)})`)
  }
  if (db.default?.kind === 'literal') args.push(`default=${pyLiteral(db.default.value)}`)
  if (db.default?.kind === 'expression') {
    imports.from('sqlalchemy', 'text')
    args.push(`server_default=text(${JSON.stringify(db.default.sql)})`)
  }
  if (!isKey) args.push(`nullable=${db.nullable ? 'True' : 'False'}`)
  const todo = db.type.kind === 'unknown' ? `    # TODO: "${db.type.sql}" has no SQLAlchemy type here; it is mapped as text` : null
  const array =
    db.type.kind === 'array'
      ? `    # TODO: "${db.type.sql}" is mapped as JSON; use sqlalchemy.ARRAY on PostgreSQL if you need the native array`
      : null
  imports.from('sqlalchemy.orm', 'Mapped', 'mapped_column')
  return [todo, array, `    ${column.attr}: Mapped[${columnPyType(column, imports)}] = mapped_column(${args.join(', ')})`]
}

function foreignKey(key: DbForeignKey, imports: Imports): string {
  imports.from('sqlalchemy', 'ForeignKey')
  const target = `${key.references.schema ? `${key.references.schema}.` : ''}${key.references.table}.${key.references.columns[0]}`
  const options = [JSON.stringify(target)]
  if (key.name) options.push(`name=${JSON.stringify(key.name)}`)
  if (key.onDelete) options.push(`ondelete=${JSON.stringify(key.onDelete.toUpperCase())}`)
  if (key.onUpdate) options.push(`onupdate=${JSON.stringify(key.onUpdate.toUpperCase())}`)
  return `ForeignKey(${options.join(', ')})`
}

const quoteList = (names: string[]) => names.map((name) => JSON.stringify(name)).join(', ')

function tableArgs(info: TableInfo, imports: Imports): string[] {
  const { table } = info
  const args: string[] = []
  for (const key of table.foreignKeys.filter((item) => item.columns.length > 1)) {
    imports.from('sqlalchemy', 'ForeignKeyConstraint')
    const target = `${key.references.schema ? `${key.references.schema}.` : ''}${key.references.table}`
    const options = [
      `[${quoteList(key.columns)}]`,
      `[${key.references.columns.map((column) => JSON.stringify(`${target}.${column}`)).join(', ')}]`,
    ]
    if (key.name) options.push(`name=${JSON.stringify(key.name)}`)
    if (key.onDelete) options.push(`ondelete=${JSON.stringify(key.onDelete.toUpperCase())}`)
    args.push(`ForeignKeyConstraint(${options.join(', ')})`)
  }
  for (const unique of table.uniques) {
    imports.from('sqlalchemy', 'UniqueConstraint')
    args.push(`UniqueConstraint(${quoteList(unique.columns)}${unique.name ? `, name=${JSON.stringify(unique.name)}` : ''})`)
  }
  for (const index of table.indexes) {
    imports.from('sqlalchemy', 'Index')
    const name = index.name ?? `ix_${table.name}_${index.columns.join('_')}`
    args.push(`Index(${JSON.stringify(name)}, ${quoteList(index.columns)})`)
  }
  for (const check of table.checks) {
    imports.from('sqlalchemy', 'CheckConstraint')
    args.push(`CheckConstraint(${JSON.stringify(check.sql)}${check.name ? `, name=${JSON.stringify(check.name)}` : ''})`)
  }
  return args
}

export function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const imports = new Imports().from('app.db', 'Base')
  const columns = info.columns.flatMap((column) => columnLine(context, info, column, imports))
  const args = tableArgs(info, imports)
  const namespace = info.table.schema ? `{"schema": ${JSON.stringify(info.table.schema)}}` : null
  const tuple = [...args, ...(namespace ? [namespace] : [])]
  const content = lines(
    `"""Entity of the "${info.name}" table${info.table.comment ? `: ${info.table.comment}` : ''}."""`,
    '',
    imports.write('app'),
    '',
    '',
    `class ${info.entity}(Base):`,
    `    """A row of the "${info.name}" table."""`,
    '',
    `    __tablename__ = ${JSON.stringify(info.name)}`,
    tuple.length === 1 && namespace ? `    __table_args__ = ${namespace}` : null,
    tuple.length > 0 && !(tuple.length === 1 && namespace)
      ? ['    __table_args__ = (', ...tuple.map((arg) => `        ${arg},`), '    )']
      : null,
    '',
    columns,
    !info.table.primaryKey && [
      '',
      '    # The table has no primary key: rows are told apart by all their columns, for reading only',
      `    __mapper_args__ = {"primary_key": [${info.columns.map((column) => column.attr).join(', ')}]}  # noqa: RUF012`,
    ],
    '',
  )
  return { path: pathOf(moduleOf(context, info, 'entity')), content }
}

/** Every entity the project writes, and a module that imports them all so the metadata knows every table. */
export function entityFiles(context: Context): GeneratedFile[] {
  return context.tables.filter((info) => info.writesEntity).map((info) => entityFile(context, info))
}
