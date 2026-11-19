/**
 * Reads Django models (see fieldModels.ts): tables named by `Meta.db_table` or by the app and the model, a big
 * integer `id` when a model declares no key, every foreign key indexed, and many-to-many tables that Django creates
 * (`<table>_<field>`) unless a `through` model maps one. `TextChoices` and `IntegerChoices` are enums.
 */
import type { DbColumn, DbTable, DbType } from '../../schema/types.ts'
import { nameOf, numberOf, textOf, type Expr } from './expressions.ts'
import { linkTable, readFieldModels, type FieldFlavour } from './fieldModels.ts'
import type { OrmReader } from './types.ts'

type Call = Expr & { kind: 'call' }

/** Text fields with the length Django gives them when none is said. */
const TEXT_LENGTHS: Record<string, number | undefined> = {
  CharField: undefined,
  SlugField: 50,
  EmailField: 254,
  URLField: 200,
  GenericIPAddressField: 39,
  IPAddressField: 15,
  FilePathField: 100,
  FileField: 100,
  ImageField: 100,
}

const INTEGERS: Record<string, { bits: 16 | 32 | 64; identity?: true; positive?: true }> = {
  AutoField: { bits: 32, identity: true },
  BigAutoField: { bits: 64, identity: true },
  SmallAutoField: { bits: 16, identity: true },
  IntegerField: { bits: 32 },
  BigIntegerField: { bits: 64 },
  SmallIntegerField: { bits: 16 },
  PositiveIntegerField: { bits: 32, positive: true },
  PositiveBigIntegerField: { bits: 64, positive: true },
  PositiveSmallIntegerField: { bits: 16, positive: true },
}

/** The database type of a field, or null when it is not one the rules know. */
function typeOf(field: Call): DbType | null {
  const name = nameOf(field) ?? ''
  const named = field.named
  const sql = textOf(field)
  if (INTEGERS[name]) return { sql, kind: 'integer', bits: INTEGERS[name].bits }
  if (name in TEXT_LENGTHS) {
    const length = numberOf(named.max_length) ?? TEXT_LENGTHS[name]
    return length !== undefined ? { sql, kind: 'text', length } : { sql, kind: 'text' }
  }
  switch (name) {
    case 'TextField':
      return { sql, kind: 'text' }
    case 'FloatField':
      return { sql, kind: 'float', bits: 64 }
    case 'DecimalField': {
      const precision = numberOf(named.max_digits)
      const scale = numberOf(named.decimal_places)
      return { sql, kind: 'decimal', ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) }
    }
    case 'BooleanField':
    case 'NullBooleanField':
      return { sql, kind: 'boolean' }
    case 'DateField':
      return { sql, kind: 'date' }
    // Django keeps times in UTC (USE_TZ, on by default since Django 5)
    case 'DateTimeField':
      return { sql, kind: 'datetime', timezone: true }
    case 'TimeField':
      return { sql, kind: 'time', timezone: false }
    case 'UUIDField':
      return { sql, kind: 'uuid' }
    case 'BinaryField': {
      const length = numberOf(named.max_length)
      return length !== undefined ? { sql, kind: 'binary', length } : { sql, kind: 'binary' }
    }
    case 'JSONField':
      return { sql, kind: 'json' }
    case 'ArrayField': {
      const base = field.args[0] ?? named.base_field
      const items = base?.kind === 'call' ? typeOf(base) : null
      return { sql, kind: 'array', items: items ?? { sql: base ? textOf(base) : '', kind: 'unknown' } }
    }
    default:
      return null
  }
}

/** The app a model belongs to, from where its file is: `shop/models.py` or `shop/models/order.py` → `shop`. */
function appOf(file: string): string | null {
  const parts = file.split('/').filter(Boolean)
  const models = parts.lastIndexOf('models')
  if (models > 0) return parts[models - 1]
  return parts.length > 1 && parts.at(-1) === 'models.py' ? parts.at(-2)! : null
}

const bigAutoId = (): DbColumn => ({
  name: 'id',
  type: { sql: 'models.BigAutoField()', kind: 'integer', bits: 64 },
  nullable: false,
  generated: 'identity',
})

const DJANGO: FieldFlavour = {
  format: 'django',
  typeOf: (field) => {
    const type = typeOf(field)
    return type ? { type } : null
  },
  identity: (kind) => INTEGERS[kind]?.identity === true,
  positive: (kind) => INTEGERS[kind]?.positive === true,
  foreignKey: 'ForeignKey',
  oneToOne: 'OneToOneField',
  manyToMany: 'ManyToManyField',
  options: { column: 'db_column', comment: 'db_comment', table: 'db_table', tableComment: 'db_table_comment' },
  defaultTable(def) {
    const app = appOf(def.file)
    const lower = def.name.toLowerCase()
    return app ? `${app}_${lower}` : lower
  },
  implicitKey: bigAutoId,
  indexesKeys: true,
  // Django's table for a many-to-many field: `<table>_<field>`, numbered, with a key to each side; a `through`
  // model is a table of its own, read as any other model
  joinTable(model, target, relation): DbTable | null {
    if (relation.named.through) return null
    const self = model === target
    const from = `${self ? 'from_' : ''}${model.def.name.toLowerCase()}_id`
    const to = `${self ? 'to_' : ''}${target.def.name.toLowerCase()}_id`
    const table = linkTable(`${model.table.name}_${relation.attribute}`, model.def.line, [
      [from, model],
      [to, target],
    ])
    table.columns.unshift(bigAutoId())
    table.primaryKey = ['id']
    table.uniques.push({ columns: [from, to] })
    table.indexes.push({ columns: [from] }, { columns: [to] })
    return table
  },
}

export const djangoReader: OrmReader = {
  id: 'django',
  label: 'Django',
  language: 'python',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    if (!/\bfrom\s+django\.db\s+import\s+models\b|\bdjango\.db\.models\b/.test(text)) return 0
    return /\(\s*models\.Model\s*\)|models\.\w+Field\(/.test(text) ? 1 : 0.5
  },
  read: (files) => readFieldModels(files, DJANGO),
}
