/**
 * Reads Tortoise ORM models (see fieldModels.ts): tables named by `Meta.table` or by the model in lower case, an
 * integer `id` when a model declares no key, integer keys the database numbers unless `generated=False`, foreign
 * keys deleted with their rows unless they say otherwise and indexed only when they ask, and the table of a
 * many-to-many field (`through`, or `<table>_<other table>`) keyed by its two columns. `CharEnumField` and
 * `IntEnumField` keep their values in the application: the rules read them as an enum with a CHECK.
 */
import { toSnakeCase } from '../../model/naming.ts'
import type { DbType } from '../../schema/types.ts'
import { booleanOf, nameOf, numberOf, stringOf, textOf, type Expr } from './expressions.ts'
import { linkTable, readFieldModels, type FieldFlavour, type FieldType } from './fieldModels.ts'
import type { EnumClass } from './python.ts'
import type { OrmReader } from './types.ts'

type Call = Expr & { kind: 'call' }

const INTEGERS: Record<string, 16 | 32 | 64> = { SmallIntField: 16, IntField: 32, BigIntField: 64 }

/** The type of a Tortoise field, with the enum of an enum field. */
function typeOf(field: Call, enums: Map<string, EnumClass>): FieldType | null {
  const name = nameOf(field) ?? ''
  const named = field.named
  const sql = textOf(field)
  if (INTEGERS[name]) return { type: { sql, kind: 'integer', bits: INTEGERS[name] } }
  const simple: Record<string, DbType> = {
    FloatField: { sql, kind: 'float', bits: 64 },
    TextField: { sql, kind: 'text' },
    BooleanField: { sql, kind: 'boolean' },
    DateField: { sql, kind: 'date' },
    // Tortoise keeps times in UTC with their zone
    DatetimeField: { sql, kind: 'datetime', timezone: true },
    TimeField: { sql, kind: 'time', timezone: false },
    UUIDField: { sql, kind: 'uuid' },
    BinaryField: { sql, kind: 'binary' },
    JSONField: { sql, kind: 'json' },
  }
  if (simple[name]) return { type: simple[name] }
  if (name === 'CharField') {
    const length = numberOf(named.max_length)
    return { type: length !== undefined ? { sql, kind: 'text', length } : { sql, kind: 'text' } }
  }
  if (name === 'DecimalField') {
    const precision = numberOf(named.max_digits)
    const scale = numberOf(named.decimal_places)
    return {
      type: { sql, kind: 'decimal', ...(precision !== undefined ? { precision } : {}), ...(scale !== undefined ? { scale } : {}) },
    }
  }
  if (name === 'CharEnumField' || name === 'IntEnumField') {
    const reference = field.args[0] ?? named.enum_type
    const enumClass = reference?.kind === 'name' ? enums.get(reference.path.at(-1)!) : undefined
    const values = enumClass?.members.map((member) => String(member.value)) ?? []
    const item = enumClass ? { name: toSnakeCase(enumClass.name), values, storage: 'check' as const } : undefined
    if (name === 'IntEnumField') return { type: { sql, kind: 'integer', bits: 16 }, ...(item ? { enum: item } : {}) }
    // Without a length, Tortoise makes the column as long as the longest value
    const length = numberOf(named.max_length) || Math.max(1, ...values.map((value) => value.length))
    return { type: { sql, kind: 'text', length }, ...(item ? { enum: item } : {}) }
  }
  return null
}

const TORTOISE: FieldFlavour = {
  format: 'tortoise',
  typeOf,
  // Tortoise numbers an integer key unless told not to
  identity: (_kind, named, type, primaryKey) => primaryKey && type?.kind === 'integer' && booleanOf(named.generated) !== false,
  positive: () => false,
  foreignKey: 'ForeignKeyField',
  oneToOne: 'OneToOneField',
  manyToMany: 'ManyToManyField',
  options: { column: 'source_field', comment: 'description', table: 'table', tableComment: 'table_description' },
  defaultTable: (def) => def.name.toLowerCase(),
  implicitKey: () => ({
    name: 'id',
    type: { sql: 'fields.IntField(primary_key=True)', kind: 'integer', bits: 32 },
    nullable: false,
    generated: 'identity',
  }),
  onDelete: 'cascade',
  indexesKeys: false,
  joinTable(model, target, relation, models) {
    const name = stringOf(relation.named.through) ?? `${model.table.name}_${target.table.name}`
    // A model that maps the table reads it as any other
    if (models.some((item) => item.table.name === name)) return null
    const backward = stringOf(relation.named.backward_key) ?? `${model.def.name.toLowerCase()}_id`
    const forward = stringOf(relation.named.forward_key) ?? `${target.def.name.toLowerCase()}_id`
    const table = linkTable(name, model.def.line, [
      [backward, model],
      [forward, target],
    ])
    table.primaryKey = [backward, forward]
    return table
  },
}

export const tortoiseReader: OrmReader = {
  id: 'tortoise',
  label: 'Tortoise ORM',
  language: 'python',
  detect(files) {
    const text = files.map((file) => file.text).join('\n')
    return /\b(from|import)\s+tortoise\b/.test(text) ? 1 : 0
  },
  read: (files) => readFieldModels(files, TORTOISE),
}
