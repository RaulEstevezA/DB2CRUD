/**
 * Reads Django models into the physical schema: classes of `models.Model` (and of abstract models, whose fields
 * they inherit), their fields with the options that reach the database, `Meta` (`db_table`, constraints, indexes,
 * `unique_together`), foreign keys and one-to-one fields (a column `<name>_id` with an index), many-to-many fields
 * (a table of their own unless `through` names one) and `TextChoices`/`IntegerChoices` as enums. Django keeps
 * `on_delete` in the application; the reader takes it as what the database should do, as Model2DB writes it.
 * A model with `managed = False` is a table Django never creates: it has only the indexes its `Meta` names, and a
 * note says its key may exist only in the ORM.
 */
import { toSnakeCase } from '../../model/naming.ts'
import { checkOf } from '../../schema/checks.ts'
import type { DbColumn, DbEnum, DbForeignKey, DbIndex, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { booleanOf, literalOf, nameOf, numberOf, stringOf, textOf, type Expr } from './expressions.ts'
import {
  assignmentOf,
  attributesOf,
  classOf,
  emptyTable,
  isNow,
  isUuid,
  readModules,
  type Assignment,
  type ClassDef,
  type EnumClass,
} from './python.ts'
import type { OrmReader, SourceFile } from './types.ts'

type Call = Expr & { kind: 'call' }

// Types

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

// Reading a model

const ON_DELETE: Record<string, DbForeignKey['onDelete']> = {
  CASCADE: 'cascade',
  SET_NULL: 'set null',
  SET_DEFAULT: 'set default',
  RESTRICT: 'restrict',
}

/** A foreign key waiting for the table of its model: `target` is the class (`"self"` already replaced). */
interface PendingKey {
  key: DbForeignKey
  target: string
  /** The field of the target it references (`to_field`); its primary key when not said */
  toField?: string
  column: DbColumn
}

/** A many-to-many field with no `through` model: Django creates its table. */
interface ManyToMany {
  attribute: string
  target: string
  inverse?: string
}

interface Model {
  def: ClassDef
  table: DbTable
  /** Column of each field */
  columns: Map<string, string>
  keys: PendingKey[]
  manyToMany: ManyToMany[]
  /** `pk = models.CompositePrimaryKey("order", "line")`: fields, resolved once every column is known */
  compositeKey?: string[]
  /** Foreign key columns Django indexes on its own */
  keyIndexes: string[]
  meta: Map<string, Expr>
}

/** The class a relation names: `"Product"`, `"shop.Product"`, `Product` or `"self"`. */
function targetOf(expr: Expr | undefined, self: string): string {
  const text = stringOf(expr) ?? (expr?.kind === 'name' ? expr.path.join('.') : '')
  const name = text.split('.').at(-1) ?? ''
  return name === 'self' ? self : name
}

/** `Meta`'s settings, by name. */
function metaOf(def: ClassDef): Map<string, Expr> {
  const meta = new Map<string, Expr>()
  for (const statement of def.body) {
    const inner = classOf(statement)
    if (inner?.name !== 'Meta') continue
    for (const item of inner.body.map(assignmentOf)) if (item?.value) meta.set(item.name, item.value)
  }
  return meta
}

/** The app a model belongs to, from where its file is: `shop/models.py` or `shop/models/order.py` → `shop`. */
function appOf(file: string): string | null {
  const parts = file.split('/').filter(Boolean)
  const models = parts.lastIndexOf('models')
  if (models > 0) return parts[models - 1]
  return parts.length > 1 && parts.at(-1) === 'models.py' ? parts.at(-2)! : null
}

/** The value Django stores for a default: `OrderStatus.PAID` is `"paid"`. */
function defaultValue(expr: Expr, enums: Map<string, EnumClass>): DbColumn['default'] | undefined {
  const literal = literalOf(expr)
  if (literal !== undefined) return { kind: 'literal', value: literal }
  if (expr.kind === 'name' && expr.path.length >= 2) {
    const member = enums.get(expr.path.at(-2)!)?.members.find((item) => item.name === expr.path.at(-1))
    if (member) return { kind: 'literal', value: member.value }
  }
  return undefined
}

/** `db_default=Now()`, `db_default=Value(0)` or `db_default=0`: what the database fills in. */
function databaseDefault(expr: Expr, column: DbColumn): void {
  if (isNow(expr)) column.generated = 'now'
  else if (isUuid(expr)) column.generated = 'uuid'
  else {
    const value = nameOf(expr) === 'Value' && expr.kind === 'call' ? literalOf(expr.args[0]) : literalOf(expr)
    column.default = value !== undefined ? { kind: 'literal', value } : { kind: 'expression', sql: textOf(expr) }
  }
}

/** The enum a field's `choices` name: `OrderStatus.choices`, or a list of `(value, label)` pairs. */
function choicesOf(expr: Expr | undefined, enums: Map<string, EnumClass>, fallback: string): DbEnum | null {
  if (!expr) return null
  if (expr.kind === 'attribute' || expr.kind === 'name') {
    const path = expr.kind === 'name' ? expr.path : [nameOf(expr.target) ?? '', expr.name]
    const enumClass = path.at(-1) === 'choices' ? enums.get(path.at(-2) ?? '') : undefined
    if (enumClass)
      return { name: toSnakeCase(enumClass.name), values: enumClass.members.map((member) => String(member.value)), storage: 'check' }
  }
  if (expr.kind === 'list') {
    const values = expr.items.map((item) => literalOf(item.kind === 'list' ? item.items[0] : item))
    if (values.every((value) => typeof value === 'string' || typeof value === 'number'))
      return { name: fallback, values: values.map(String), storage: 'check' }
  }
  return null
}

const RELATIONS = new Set(['ForeignKey', 'OneToOneField', 'ManyToManyField'])

/** Adds a field to its model: a column, a key, or a many-to-many table. */
function addField(model: Model, item: Assignment, enums: Map<string, EnumClass>, enumsUsed: DbEnum[], notes: DbNote[]): void {
  const field = item.value
  if (field?.kind !== 'call') return
  const kind = nameOf(field) ?? ''
  const named = field.named
  const { table } = model
  if (kind === 'CompositePrimaryKey') {
    model.compositeKey = field.args.map((arg) => stringOf(arg)).filter((name): name is string => !!name)
    return
  }
  if (kind === 'ManyToManyField') {
    // A `through` model is a table of its own, read as any other model
    if (!named.through) {
      const inverse = stringOf(named.related_name)
      model.manyToMany.push({
        attribute: item.name,
        target: targetOf(field.args[0] ?? named.to, model.def.name),
        ...(inverse && !inverse.endsWith('+') ? { inverse } : {}),
      })
    }
    return
  }
  const relation = RELATIONS.has(kind)
  if (!relation && !kind.endsWith('Field')) return
  const primaryKey = booleanOf(named.primary_key) === true
  const declared = stringOf(named.db_column)
  const name = declared ?? (relation ? `${item.name}_id` : item.name)
  const type = relation
    ? null
    : kind === 'GeneratedField'
      ? named.output_field?.kind === 'call'
        ? typeOf(named.output_field)
        : null
      : typeOf(field)
  if (!relation && !type) notes.push({ code: 'orm.unknownType', params: { table: table.name, column: name, type: textOf(field) } })
  const column: DbColumn = {
    name,
    type: type ?? { sql: relation ? '' : textOf(field), kind: 'unknown' },
    nullable: !primaryKey && (booleanOf(named.null) === true || kind === 'NullBooleanField'),
  }
  if (INTEGERS[kind]?.identity) column.generated = 'identity'
  if (kind === 'GeneratedField' && named.expression) column.generated = { computed: textOf(named.expression) }
  if (named.auto_now) column.generated = 'onUpdateNow'
  else if (named.auto_now_add) column.generated = 'now'
  if (named.db_default) databaseDefault(named.db_default, column)
  const value = named.default
  if (value && !column.generated && !relation) {
    if (isUuid(value)) column.generated = 'uuid'
    else if (isNow(value)) column.generated = 'now'
    else {
      const fixed = defaultValue(value, enums)
      if (fixed && fixed.kind === 'literal' && fixed.value !== null) column.default = fixed
    }
  }
  const comment = stringOf(named.db_comment)
  if (comment) column.comment = comment
  if (declared && declared !== (relation ? `${item.name}_id` : item.name)) column.attribute = relation ? `${item.name}_id` : item.name
  table.columns.push(column)
  model.columns.set(item.name, name)
  if (relation) model.columns.set(`${item.name}_id`, name)
  if (primaryKey) table.primaryKey = [name]
  const unique = booleanOf(named.unique) === true || kind === 'OneToOneField'
  if (unique && !primaryKey) table.uniques.push({ columns: [name] })
  // Django indexes every foreign key unless told not to
  const indexed = booleanOf(named.db_index)
  if (!unique && !primaryKey) {
    if (indexed === true) table.indexes.push({ columns: [name] })
    else if (indexed === undefined && relation) model.keyIndexes.push(name)
  }
  if (INTEGERS[kind]?.positive) table.checks.push(checkOf(`${name} >= 0`))
  const choices = choicesOf(named.choices, enums, `${table.name}_${name}`)
  if (choices && !enumsUsed.some((item) => item.name === choices.name)) enumsUsed.push(choices)
  if (relation) {
    const onDelete = ON_DELETE[nameOf(named.on_delete) ?? '']
    const inverse = stringOf(named.related_name)
    model.keys.push({
      key: {
        columns: [name],
        references: { table: '', columns: [] },
        ...(onDelete ? { onDelete } : {}),
        attribute: item.name,
        ...(inverse && !inverse.endsWith('+') ? { inverse } : {}),
      },
      target: targetOf(field.args[0] ?? named.to, model.def.name),
      ...(stringOf(named.to_field) ? { toField: stringOf(named.to_field) } : {}),
      column,
    })
  }
}

/** The columns of a list of fields as `Meta` names them (`"-created_at"` is descending: the order does not count). */
function fieldColumns(expr: Expr | undefined, model: Model): string[] {
  const items = expr?.kind === 'list' ? expr.items : []
  return items
    .map((item) => stringOf(item)?.replace(/^-/, ''))
    .filter((name): name is string => !!name)
    .map((name) => model.columns.get(name) ?? name)
}

const LOOKUPS: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', exact: '=' }

/** `Q(status__in=["paid", "shipped"])` or `Q(price__gte=0)` as SQL, with the columns of the fields. */
function conditionSql(expr: Expr | undefined, model: Model): string | null {
  if (expr?.kind !== 'call' || nameOf(expr) !== 'Q') return null
  const parts: string[] = []
  for (const [key, value] of Object.entries(expr.named)) {
    const [field, lookup = 'exact'] = key.split('__')
    const column = model.columns.get(field) ?? field
    const sqlValue = (item: Expr) => {
      const literal = literalOf(item)
      if (typeof literal === 'string') return `'${literal.replace(/'/g, "''")}'`
      return literal === undefined ? null : String(literal)
    }
    if (lookup === 'in' && value.kind === 'list') {
      const values = value.items.map(sqlValue)
      if (values.some((item) => item === null)) return null
      parts.push(`${column} IN (${values.join(', ')})`)
    } else if (LOOKUPS[lookup] && sqlValue(value) !== null) parts.push(`${column} ${LOOKUPS[lookup]} ${sqlValue(value)}`)
    else return null
  }
  return parts.length > 0 ? parts.join(' AND ') : null
}

/** `unique_together = ("a", "b")` or `(("a", "b"), ("c", "d"))`: the groups of fields. */
function groupsOf(expr: Expr | undefined): Expr[] {
  if (expr?.kind !== 'list') return []
  return expr.items.every((item) => item.kind === 'string') ? [expr] : expr.items.filter((item) => item.kind === 'list')
}

/** What `Meta` says about the table: its name is read before, the rest once every column is known. */
function applyMeta(model: Model, notes: DbNote[]): void {
  const { table, meta } = model
  const comment = stringOf(meta.get('db_table_comment'))
  if (comment) table.comment = comment
  for (const group of groupsOf(meta.get('unique_together'))) table.uniques.push({ columns: fieldColumns(group, model) })
  for (const group of groupsOf(meta.get('index_together'))) table.indexes.push({ columns: fieldColumns(group, model) })
  const constraints = meta.get('constraints')
  for (const item of constraints?.kind === 'list' ? constraints.items : []) {
    if (item.kind !== 'call') continue
    const name = stringOf(item.named.name)
    if (nameOf(item) === 'UniqueConstraint') {
      const fields = item.named.fields ?? { kind: 'list', items: item.args }
      table.uniques.push({ ...(name ? { name } : {}), columns: fieldColumns(fields, model) })
    } else if (nameOf(item) === 'CheckConstraint') {
      const condition = item.named.condition ?? item.named.check
      const sql = conditionSql(condition, model)
      if (sql) table.checks.push(checkOf(sql, name))
      else if (condition) {
        table.checks.push({ ...(name ? { name } : {}), sql: textOf(condition) })
        notes.push({ code: 'orm.unreadCheck', params: { table: table.name, check: textOf(condition) } })
      }
    }
  }
  const indexes = meta.get('indexes')
  for (const item of indexes?.kind === 'list' ? indexes.items : []) {
    if (item.kind !== 'call' || nameOf(item) !== 'Index') continue
    const name = stringOf(item.named.name)
    const index: DbIndex = { ...(name ? { name } : {}), columns: fieldColumns(item.named.fields, model) }
    if (index.columns.length > 0) table.indexes.push(index)
  }
  if (booleanOf(meta.get('managed')) === false) {
    notes.push({ code: 'orm.unmanagedTable', params: { table: table.name } })
    return
  }
  // The index of a foreign key, unless the key or another index already starts with its column
  const leading = [table.primaryKey ?? [], ...table.uniques.map((item) => item.columns), ...table.indexes.map((item) => item.columns)].map(
    (columns) => columns[0],
  )
  for (const column of model.keyIndexes) if (!leading.includes(column)) table.indexes.push({ columns: [column] })
}

function isModel(def: ClassDef, classes: Map<string, ClassDef>, seen = new Set<string>()): boolean {
  seen.add(def.name)
  return def.bases.some((base) => {
    if (/(^|\.)Model$/.test(base)) return true
    const parent = classes.get(base.split('.').at(-1)!)
    return parent !== undefined && !seen.has(parent.name) && isModel(parent, classes, seen)
  })
}

const isAbstract = (def: ClassDef) => booleanOf(metaOf(def).get('abstract')) === true

function modelOf(
  def: ClassDef,
  classes: Map<string, ClassDef>,
  enums: Map<string, EnumClass>,
  enumsUsed: DbEnum[],
  notes: DbNote[],
): Model {
  const meta = metaOf(def)
  const app = appOf(def.file)
  const lower = def.name.toLowerCase()
  const name = stringOf(meta.get('db_table')) ?? (app ? `${app}_${lower}` : lower)
  const table = emptyTable(name, def.line)
  table.entity = def.name
  const model: Model = { def, table, columns: new Map(), keys: [], manyToMany: [], meta, keyIndexes: [] }
  // The fields of abstract models are inherited; a concrete parent keeps its own table
  for (const item of attributesOf(def, classes, isAbstract)) addField(model, item, enums, enumsUsed, notes)
  if (model.compositeKey) table.primaryKey = model.compositeKey.map((field) => model.columns.get(field) ?? field)
  // A model without a primary key gets Django's: `id`, a big integer the database numbers
  if (table.primaryKey === null) {
    table.columns.unshift({
      name: 'id',
      type: { sql: 'models.BigAutoField()', kind: 'integer', bits: 64 },
      nullable: false,
      generated: 'identity',
    })
    table.primaryKey = ['id']
    model.columns.set('id', 'id')
  }
  model.columns.set('pk', table.primaryKey[0])
  return model
}

// Resolving what refers to what

function resolve(models: Model[], notes: DbNote[]): DbTable[] {
  const byClass = new Map(models.map((model) => [model.def.name, model]))
  const joins: DbTable[] = []
  for (const model of models) {
    for (const pending of model.keys) {
      const target = byClass.get(pending.target)
      const columns = target ? (pending.toField ? [target.columns.get(pending.toField) ?? pending.toField] : target.table.primaryKey) : null
      if (!target || !columns || columns.length !== 1) {
        notes.push({ code: 'orm.unknownReference', params: { table: model.table.name, column: pending.column.name } })
        continue
      }
      pending.key.references = { table: target.table.name, ...(target.table.schema ? { schema: target.table.schema } : {}), columns }
      model.table.foreignKeys.push(pending.key)
      // A key takes the type of the column it references, without its numbering
      const referenced = target.table.columns.find((column) => column.name === columns[0])
      if (referenced) pending.column.type = referenced.type
    }
    for (const relation of model.manyToMany) {
      const target = byClass.get(relation.target)
      if (!target) {
        notes.push({ code: 'orm.unknownReference', params: { table: model.table.name, column: relation.attribute } })
        continue
      }
      joins.push(joinTable(model, target, relation))
    }
  }
  return joins
}

/** The table Django creates for a many-to-many field: `<table>_<field>`, with a key to each side. */
function joinTable(model: Model, target: Model, relation: ManyToMany): DbTable {
  const self = model === target
  const from = `${self ? 'from_' : ''}${model.def.name.toLowerCase()}_id`
  const to = `${self ? 'to_' : ''}${target.def.name.toLowerCase()}_id`
  const table = emptyTable(`${model.table.name}_${relation.attribute}`, model.def.line)
  const keyColumn = (name: string, side: Model): DbColumn => {
    const referenced = side.table.columns.find((column) => column.name === side.table.primaryKey![0])
    return { name, type: referenced?.type ?? { sql: '', kind: 'unknown' }, nullable: false }
  }
  table.columns.push(
    { name: 'id', type: { sql: 'models.BigAutoField()', kind: 'integer', bits: 64 }, nullable: false, generated: 'identity' },
    keyColumn(from, model),
    keyColumn(to, target),
  )
  table.primaryKey = ['id']
  const reference = (side: Model) => ({
    table: side.table.name,
    ...(side.table.schema ? { schema: side.table.schema } : {}),
    columns: [side.table.primaryKey![0]],
  })
  table.foreignKeys.push(
    { columns: [from], references: reference(model), onDelete: 'cascade' },
    { columns: [to], references: reference(target), onDelete: 'cascade' },
  )
  table.uniques.push({ columns: [from, to] })
  table.indexes.push({ columns: [from] }, { columns: [to] })
  return table
}

function readDjango(files: SourceFile[]): DbSchema {
  const notes: DbNote[] = []
  const { classes, enums } = readModules(files)
  const byName = new Map(classes.map((def) => [def.name, def]))
  const enumsUsed: DbEnum[] = []
  const models = classes
    .filter((def) => isModel(def, byName) && !isAbstract(def) && booleanOf(metaOf(def).get('proxy')) !== true)
    .map((def) => modelOf(def, byName, enums, enumsUsed, notes))
  const joins = resolve(models, notes)
  for (const model of models) applyMeta(model, notes)
  return {
    format: 'db-schema',
    version: 1,
    dialect: null,
    source: { kind: 'orm', format: 'django' },
    tables: [...models.map((model) => model.table), ...joins],
    enums: enumsUsed,
    notes,
  }
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
  read: readDjango,
}
