/**
 * Reads ORMs that declare a table as a class of field objects (Django, Tortoise): classes of a `Model` (and of
 * abstract models, whose fields they inherit), their fields with the options that reach the database, `Meta` (the
 * table, constraints, indexes, `unique_together`), foreign keys and one-to-one fields (a column `<name>_id`),
 * many-to-many fields and enums. What changes from one ORM to another (names of fields and options, the table and
 * key they give a model, the table of a many-to-many field) is its flavour. `on_delete` lives in the application;
 * the reader takes it as what the database should do, as Model2DB writes it. A model with `managed = False` is a
 * table the ORM never creates: it has only the indexes its `Meta` names, and a note says its key may exist only in
 * the ORM.
 */
import { toSnakeCase } from '../../model/naming.ts'
import { checkOf } from '../../schema/checks.ts'
import type { DbColumn, DbEnum, DbForeignKey, DbIndex, DbNote, DbSchema, DbTable, DbType } from '../../schema/types.ts'
import { booleanOf, literalOf, nameOf, stringOf, textOf, type Expr } from './expressions.ts'
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
import type { SourceFile } from './types.ts'

// Reading a model

type Call = Expr & { kind: 'call' }

/** What a flavour says about the type of a field: its type, and the enum it keeps (checked by a CHECK when `check`). */
export interface FieldType {
  type: DbType
  enum?: DbEnum
}

/** How an ORM of field classes names and reads what the engine reads. */
export interface FieldFlavour {
  format: string
  /** The type of a field (`IntegerField`, `fields.IntField`), or null when it is not one the rules know */
  typeOf(field: Call, enums: Map<string, EnumClass>): FieldType | null
  /** Whether the database numbers a field */
  identity(kind: string, named: Record<string, Expr>, type: DbType | null, primaryKey: boolean): boolean
  /** Whether a field keeps numbers from 0 up, with a CHECK */
  positive(kind: string): boolean
  foreignKey: string
  oneToOne: string
  manyToMany: string
  /** The names of the options: the column (`db_column`), its comment, the table and the table's comment */
  options: { column: string; comment: string; table: string; tableComment: string }
  /** The table of a model whose `Meta` does not name one */
  defaultTable(def: ClassDef): string
  /** The key the ORM gives a model that declares none */
  implicitKey: () => DbColumn
  /** What a foreign key does on delete when it does not say */
  onDelete?: DbForeignKey['onDelete']
  /** The ORM indexes every foreign key on its own */
  indexesKeys: boolean
  /** The table of a many-to-many field, or null when a model of its own maps it */
  joinTable(model: Model, target: Model, relation: ManyToMany, models: Model[]): DbTable | null
}

const ON_DELETE: Record<string, DbForeignKey['onDelete']> = {
  CASCADE: 'cascade',
  SET_NULL: 'set null',
  SET_DEFAULT: 'set default',
  RESTRICT: 'restrict',
  NO_ACTION: 'no action',
}

/** A foreign key waiting for the table of its model: `target` is the class (`"self"` already replaced). */
interface PendingKey {
  key: DbForeignKey
  target: string
  /** The field of the target it references (`to_field`); its primary key when not said */
  toField?: string
  column: DbColumn
}

/** A many-to-many field, with its options. */
export interface ManyToMany {
  attribute: string
  target: string
  inverse?: string
  named: Record<string, Expr>
}

export interface Model {
  def: ClassDef
  table: DbTable
  /** Column of each field */
  columns: Map<string, string>
  keys: PendingKey[]
  manyToMany: ManyToMany[]
  /** `pk = models.CompositePrimaryKey("order", "line")`: fields, resolved once every column is known */
  compositeKey?: string[]
  /** Foreign key columns the ORM indexes on its own */
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

/** The value stored for a default: `OrderStatus.PAID` is `"paid"`. */
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

/** Adds a field to its model: a column, a key, or a many-to-many table. */
function addField(
  flavour: FieldFlavour,
  model: Model,
  item: Assignment,
  enums: Map<string, EnumClass>,
  enumsUsed: DbEnum[],
  notes: DbNote[],
): void {
  const field = item.value
  if (field?.kind !== 'call') return
  const kind = nameOf(field) ?? ''
  const named = field.named
  const { table } = model
  if (kind === 'CompositePrimaryKey') {
    model.compositeKey = field.args.map((arg) => stringOf(arg)).filter((name): name is string => !!name)
    return
  }
  if (kind === flavour.manyToMany) {
    const inverse = stringOf(named.related_name)
    model.manyToMany.push({
      attribute: item.name,
      target: targetOf(field.args[0] ?? named.to, model.def.name),
      ...(inverse && !inverse.endsWith('+') ? { inverse } : {}),
      named,
    })
    return
  }
  const relation = kind === flavour.foreignKey || kind === flavour.oneToOne
  if (!relation && !kind.endsWith('Field')) return
  const primaryKey = booleanOf(named.primary_key) === true || booleanOf(named.pk) === true
  const declared = stringOf(named[flavour.options.column])
  const name = declared ?? (relation ? `${item.name}_id` : item.name)
  const read = relation
    ? null
    : kind === 'GeneratedField'
      ? named.output_field?.kind === 'call'
        ? flavour.typeOf(named.output_field, enums)
        : null
      : flavour.typeOf(field, enums)
  const type = read?.type ?? null
  if (!relation && !type) notes.push({ code: 'orm.unknownType', params: { table: table.name, column: name, type: textOf(field) } })
  const column: DbColumn = {
    name,
    type: type ?? { sql: relation ? '' : textOf(field), kind: 'unknown' },
    nullable: !primaryKey && (booleanOf(named.null) === true || kind === 'NullBooleanField'),
  }
  if (flavour.identity(kind, named, type, primaryKey)) column.generated = 'identity'
  if (kind === 'GeneratedField' && named.expression) column.generated = { computed: computedOf(named.expression) }
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
  const comment = stringOf(named[flavour.options.comment])
  if (comment) column.comment = comment
  if (declared && declared !== (relation ? `${item.name}_id` : item.name)) column.attribute = relation ? `${item.name}_id` : item.name
  table.columns.push(column)
  model.columns.set(item.name, name)
  if (relation) model.columns.set(`${item.name}_id`, name)
  if (primaryKey) table.primaryKey = [name]
  const unique = booleanOf(named.unique) === true || kind === flavour.oneToOne
  if (unique && !primaryKey) table.uniques.push({ columns: [name] })
  // Django indexes every foreign key unless told not to; Tortoise only when `index=True` or `db_index=True`
  const indexed = booleanOf(named.db_index) ?? booleanOf(named.index)
  if (!unique && !primaryKey) {
    if (indexed === true) table.indexes.push({ columns: [name] })
    else if (indexed === undefined && relation && flavour.indexesKeys) model.keyIndexes.push(name)
  }
  if (flavour.positive(kind)) table.checks.push(checkOf(`${name} >= 0`))
  const choices = read?.enum ?? choicesOf(named.choices, enums, `${table.name}_${name}`)
  if (choices && !enumsUsed.some((item) => item.name === choices.name)) enumsUsed.push(choices)
  // An enum field keeps its values in the application: the rules read them as a CHECK
  if (read?.enum) {
    const values = read.enum.values.map((value) => (type?.kind === 'integer' ? value : `'${value.replace(/'/g, "''")}'`))
    table.checks.push(checkOf(`${name} IN (${values.join(', ')})`))
  }
  if (relation) {
    const onDelete = named.on_delete ? ON_DELETE[nameOf(named.on_delete) ?? ''] : flavour.onDelete
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

/** The expression of a computed column: the SQL of a `RawSQL`, or the Python code. */
const computedOf = (expr: Expr) => (nameOf(expr) === 'RawSQL' && expr.kind === 'call' ? stringOf(expr.args[0]) : undefined) ?? textOf(expr)

/** What `Meta` says about the table: its name is read before, the rest once every column is known. */
function applyMeta(flavour: FieldFlavour, model: Model, notes: DbNote[]): void {
  const { table, meta } = model
  const comment = stringOf(meta.get(flavour.options.tableComment))
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
  flavour: FieldFlavour,
  def: ClassDef,
  classes: Map<string, ClassDef>,
  enums: Map<string, EnumClass>,
  enumsUsed: DbEnum[],
  notes: DbNote[],
): Model {
  const meta = metaOf(def)
  const declared = stringOf(meta.get(flavour.options.table))
  // A table of another schema: `"sales"."orders"`, as Django leaves names already quoted
  const qualified = /^"([^"]+)"\."([^"]+)"$/.exec(declared ?? '')
  const table = emptyTable(qualified?.[2] ?? declared ?? flavour.defaultTable(def), def.line)
  if (qualified) table.schema = qualified[1]
  const schema = stringOf(meta.get('schema'))
  if (schema) table.schema = schema
  table.entity = def.name
  const model: Model = { def, table, columns: new Map(), keys: [], manyToMany: [], meta, keyIndexes: [] }
  // The fields of abstract models are inherited; a concrete parent keeps its own table
  for (const item of attributesOf(def, classes, isAbstract)) addField(flavour, model, item, enums, enumsUsed, notes)
  if (model.compositeKey) table.primaryKey = model.compositeKey.map((field) => model.columns.get(field) ?? field)
  // A model without a primary key gets the ORM's own
  if (table.primaryKey === null) {
    table.columns.unshift(flavour.implicitKey())
    table.primaryKey = ['id']
    model.columns.set('id', 'id')
  }
  model.columns.set('pk', table.primaryKey[0])
  return model
}

// Resolving what refers to what

function resolve(flavour: FieldFlavour, models: Model[], notes: DbNote[]): DbTable[] {
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
      const join = flavour.joinTable(model, target, relation, models)
      if (join) joins.push(join)
    }
  }
  return joins
}

/** A table of two foreign keys to the primary keys of two models, both deleted with their rows. */
export function linkTable(name: string, line: number, sides: [string, Model][]): DbTable {
  const table = emptyTable(name, line)
  for (const [column, side] of sides) {
    const key = side.table.primaryKey![0]
    const referenced = side.table.columns.find((item) => item.name === key)
    table.columns.push({ name: column, type: referenced?.type ?? { sql: '', kind: 'unknown' }, nullable: false })
    table.foreignKeys.push({
      columns: [column],
      references: { table: side.table.name, ...(side.table.schema ? { schema: side.table.schema } : {}), columns: [key] },
      onDelete: 'cascade',
    })
  }
  return table
}

/** The schema the models of these files declare, in this flavour. */
export function readFieldModels(files: SourceFile[], flavour: FieldFlavour): DbSchema {
  const notes: DbNote[] = []
  const { classes, enums } = readModules(files)
  const byName = new Map(classes.map((def) => [def.name, def]))
  const enumsUsed: DbEnum[] = []
  const models = classes
    .filter((def) => isModel(def, byName) && !isAbstract(def) && booleanOf(metaOf(def).get('proxy')) !== true)
    .map((def) => modelOf(flavour, def, byName, enums, enumsUsed, notes))
  const joins = resolve(flavour, models, notes)
  for (const model of models) applyMeta(flavour, model, notes)
  return {
    format: 'db-schema',
    version: 1,
    dialect: null,
    source: { kind: 'orm', format: flavour.format },
    tables: [...models.map((model) => model.table), ...joins],
    enums: enumsUsed,
    notes,
  }
}
