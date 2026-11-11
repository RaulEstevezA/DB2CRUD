import { allFields, type FieldDef, type ModelDef, type ModelSchema, type TypeRef } from '../../model/schema.ts'
import { declaredLength, declaredPrecision } from '../../design/hints.ts'
import type { Design, FieldDesign } from '../../design/types.ts'
import { constraintName, freeName } from '../naming.ts'
import type { ModelRole } from '../roles.ts'
import type { BuildOptions, ColumnType, Note, Table, Todo } from '../types.ts'
import { DEFAULT_LENGTH } from './names.ts'

// Precision used for decimals whose input does not say it: enough for money in most currencies
export const DEFAULT_PRECISION = { precision: 18, scale: 2 }

/** A stored model and its table while it is being built. */
export interface Entity {
  model: ModelDef
  table: Table
  design: FieldDesign[]
  /** Column names already used in the table, in lower case */
  used: Set<string>
  /** The primary key, once known: its column and type */
  key: { column: string; type: ColumnType } | null
}

/** The state shared by the steps of the relational build (tables, columns, relations, enums), with the
 * operations every step uses: creating tables, typing columns, adding foreign keys and TODOs. */
export class RelationalBuild {
  readonly notes: Note[] = []
  readonly entities = new Map<string, Entity>()
  /** List, map and join tables, after the entities */
  readonly extraTables: Table[] = []
  readonly enumsUsed = new Set<string>()
  readonly usedTables = new Set<string>()
  /** Decimal fields that got the default precision */
  readonly decimals: string[] = []

  readonly schema: ModelSchema
  readonly design: Design
  readonly options: BuildOptions
  readonly roles: Map<string, ModelRole>

  constructor(schema: ModelSchema, design: Design, options: BuildOptions, roles: Map<string, ModelRole>) {
    this.schema = schema
    this.design = design
    this.options = options
    this.roles = roles
  }

  newTable(name: string, kind: Table['kind'], model: string, field?: string): Table {
    return {
      name: freeName(name, this.usedTables),
      kind,
      model,
      ...(field ? { field } : {}),
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      uniques: [],
      indexes: [],
      checks: [],
      todos: [],
    }
  }

  todo(table: Table, code: Todo['code'], params: Record<string, string>) {
    table.todos.push({ code, params })
  }

  /** Fields of a stored model with their decisions, inherited ones included. */
  fieldsOf(entity: Entity): { field: FieldDef; decided: FieldDesign | undefined }[] {
    return allFields(this.schema, entity.model).map((field) => ({
      field,
      decided: entity.design.find((item) => item.field === field.name),
    }))
  }

  /** The type of a field's column: the one the user wrote, or the one derived from the field. */
  typeOf(field: FieldDef, decided: FieldDesign | undefined, path: string): ColumnType {
    if (decided?.type) return { kind: 'raw', sql: decided.type }
    if (
      decided?.wholeNumber?.status === 'active' &&
      decided.wholeNumber.value &&
      field.type.kind === 'primitive' &&
      field.type.name === 'float'
    )
      return { kind: 'primitive', name: 'integer' }
    return this.columnType(field.type, field, path)
  }

  columnType(type: TypeRef, field: FieldDef, path: string): ColumnType {
    if (type.kind === 'enum') {
      this.enumsUsed.add(type.name)
      return { kind: 'enum', name: type.name }
    }
    if (type.kind !== 'primitive' || type.name === 'any') return { kind: 'json' }
    const result: ColumnType = { kind: 'primitive', name: type.name, ...(type.bits ? { bits: type.bits } : {}) }
    const { strings, dialect } = this.options
    if (type.name === 'string') {
      const varchar = strings === 'varchar' || (strings === 'auto' && dialect !== 'postgresql' && dialect !== 'sqlite')
      const length = declaredLength(field) ?? (varchar ? DEFAULT_LENGTH : undefined)
      if (length) result.length = length
    }
    if (type.name === 'decimal') {
      const declared = declaredPrecision(field)
      if (!declared) this.decimals.push(path)
      Object.assign(result, declared ?? DEFAULT_PRECISION)
    }
    return result
  }

  /** A foreign key from a column to a stored model's key, indexed; merges navigation into an existing one. */
  foreignKey(
    table: Table,
    column: string,
    target: Entity,
    onDelete?: 'cascade' | 'set null',
    navigation: { field?: string; inverse?: string } = {},
  ) {
    if (!target.key) {
      this.todo(table, 'foreignKeyTargetNotStored', { column, model: target.model.name })
      return
    }
    const existing = table.foreignKeys.find((fk) => fk.columns.length === 1 && fk.columns[0] === column)
    if (existing) {
      Object.assign(existing, navigation)
      return
    }
    table.foreignKeys.push({
      name: constraintName('fk', table.name, [column]),
      columns: [column],
      table: target.table.name,
      references: [target.key.column],
      ...(onDelete ? { onDelete } : {}),
      ...navigation,
    })
    if (!table.primaryKey.includes(column) && !table.indexes.some((index) => index.columns[0] === column))
      table.indexes.push({ name: constraintName('ix', table.name, [column]), columns: [column], unique: false })
  }
}
