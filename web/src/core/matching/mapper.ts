/**
 * The matching of a table with a Mapper project (Mapper's `mapper-project`): one side of a model mapping is the
 * table (its model's fields are the columns, by name), the other the application model. When the table is the
 * target, the mapping says how the model is written into it; when it is the source, how a row is read into the
 * model. The same relation serves the other direction only when its transformation can be undone without loss
 * (`invertible`); otherwise that direction is left for review and the generated code leaves a `TODO`.
 */
import { invertible, type MapperMapping, type MapperProject } from '../interop/mapper/read.ts'
import { reason, type Confidence, type Reason } from '../decisions/decision.ts'
import type { FieldDef, ModelSchema } from '../model/schema.ts'
import type { DbColumn, DbTable } from '../schema/types.ts'
import { fieldFor, fieldsOf, modelName, namesTable } from './names.ts'

export interface MapperRelation {
  mapping: MapperMapping
  /** The side of the mapping the table is: `target` is written from the model, `source` read into it */
  side: 'source' | 'target'
  /** The application model: the other side */
  model: string
  /** The fields of the table's side, matched with the columns by name */
  tableFields: FieldDef[]
}

/** A column filled (or read) by a relation of a Mapper project. */
export interface MapperSource {
  kind: 'mapper'
  /** The model mapping (`Source->Target`) */
  mapping: string
  /** The side of the mapping the table is (as in `MapperRelation`) */
  side: 'source' | 'target'
  /** The target field of the relation in the mapping: the table's field, or the application model's */
  target: string
  /** The fields of the application model it uses (paths joined by dots), or fills */
  fields: string[]
  transform: string
  /** Whether the same relation serves the other direction */
  inverse: boolean
}

function fieldsOfModel(schema: ModelSchema, name: string): FieldDef[] | null {
  const model = schema.models.find((item) => item.name === name)
  return model ? fieldsOf(model, schema) : null
}

/** How many columns the fields of a model name. */
function columnsNamed(fields: FieldDef[], table: DbTable): number {
  return table.columns.filter((column) => fieldFor(column, fields, new Set()) !== null).length
}

/**
 * The model mapping of a project that relates a table, with the side the table is: the side whose model is named
 * like the table; when both are (`UserDto` and `User`), the one whose fields name more columns, the target on a tie.
 */
export function mapperRelation(table: DbTable, project: MapperProject): MapperRelation | null {
  const ordered = [...project.mappings].sort((a, b) => Number(b.id === project.root) - Number(a.id === project.root))
  for (const mapping of ordered) {
    const targetFields = fieldsOfModel(project.target.schema, mapping.target)
    const sourceFields = fieldsOfModel(project.source.schema, mapping.source)
    const target = targetFields !== null && namesTable(modelName(mapping.target).words, table)
    const source = sourceFields !== null && namesTable(modelName(mapping.source).words, table)
    if (!target && !source) continue
    const side =
      target && source
        ? columnsNamed(sourceFields!, table) > columnsNamed(targetFields!, table)
          ? 'source'
          : 'target'
        : target
          ? 'target'
          : 'source'
    return side === 'target'
      ? { mapping, side, model: mapping.source, tableFields: targetFields! }
      : { mapping, side, model: mapping.target, tableFields: sourceFields! }
  }
  return null
}

/** Where a column comes from in a relation, with its confidence and reasons; null when the mapping says nothing of it. */
export function mapperSource(
  relation: MapperRelation,
  column: DbColumn,
  taken: Set<string>,
): { source: MapperSource; confidence: Confidence; reasons: Reason[] } | null {
  const found = fieldFor(column, relation.tableFields, taken)
  if (!found) return null
  taken.add(found.field.name)
  const name = found.field.name
  const relevant = relation.mapping.fields.filter((item) => item.status === 'active' || item.status === 'pending')
  const field =
    relation.side === 'target'
      ? relevant.find((item) => item.target === name)
      : relevant.find((item) => item.sources.some((path) => path.length === 1 && path[0] === name))
  if (!field) return null
  const fields = relation.side === 'target' ? field.sources.map((path) => path.join('.')) : [field.target]
  const inverse = invertible(field.transform)
  const source: MapperSource = {
    kind: 'mapper',
    mapping: relation.mapping.id,
    side: relation.side,
    target: field.target,
    fields,
    transform: field.transform.kind,
    inverse,
  }
  const params = { fields: fields.join(', '), transform: field.transform.kind }
  if (field.status === 'pending') return { source, confidence: 'review', reasons: [reason('mapperPending', params)] }
  return inverse
    ? { source, confidence: 'exact', reasons: [reason('mapperField', params)] }
    : { source, confidence: 'review', reasons: [reason('mapperOneWay', params)] }
}

/** The fields of the application model left out on purpose in Mapper: they are not reported as unused. */
export function mapperIgnored(relation: MapperRelation): string[] {
  return relation.side === 'target' ? relation.mapping.ignoredSources : []
}
