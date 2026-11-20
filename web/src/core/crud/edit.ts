/**
 * Edits of a CRUD design. Each returns a new design and leaves the previous one untouched, so the history
 * can keep it for undo. After an edit that changes a table decision, the caller proposes the design again
 * with the edited one as `previous` (crud/propose.ts), so the operations that depend on it follow.
 */
import { sameValue, type Decision } from '../decisions/decision.ts'
import type { ColumnSource, Direction, ModelMatch } from '../matching/matching.ts'
import type { CrudDesign, PolicyDecisionKind, TablePolicy } from './types.ts'

/** Where a decision lives in a design, for the review list and the interface. */
export type CrudDecisionRef =
  | { kind: 'policy'; table: string; decision: PolicyDecisionKind }
  | { kind: 'query'; table: string; id: string }
  | { kind: 'operation'; table: string; id: string }
  /** The model of a table in one direction */
  | { kind: 'model'; table: string; direction: Direction }
  /** Where a column comes from (or goes to) in that model */
  | { kind: 'source'; table: string; direction: Direction; column: string }
  /** The child table a list field of that model stands for */
  | { kind: 'childTable'; table: string; direction: Direction; field: string }

/** The user's choice: it becomes active, whatever its confidence was. */
function choose<T>(current: Decision<T>, value: T): Decision<T> {
  if (!current.options.some((option) => sameValue(option, value))) return current
  return { ...current, value, status: 'active', manual: true }
}

function mapPolicy(design: CrudDesign, table: string, change: (policy: TablePolicy) => TablePolicy): CrudDesign {
  return { ...design, policies: design.policies.map((policy) => (policy.table === table ? change(policy) : policy)) }
}

/** Chooses a value for a table decision. A value that is not one of its options leaves the design as it is. */
export function decidePolicy(design: CrudDesign, table: string, kind: PolicyDecisionKind, value: unknown): CrudDesign {
  return mapPolicy(design, table, (policy) => {
    const current = policy[kind] as Decision<unknown> | null
    return current ? { ...policy, [kind]: choose(current, value) } : policy
  })
}

/** Turns a query of a repository on or off. */
export function setQueryInclude(design: CrudDesign, table: string, id: string, include: boolean): CrudDesign {
  return {
    ...design,
    repositories: design.repositories.map((repository) =>
      repository.table !== table
        ? repository
        : {
            ...repository,
            queries: repository.queries.map((query) => (query.id === id ? { ...query, include: choose(query.include, include) } : query)),
          },
    ),
  }
}

/** Turns an operation of a service on or off. */
export function setOperationInclude(design: CrudDesign, table: string, id: string, include: boolean): CrudDesign {
  return {
    ...design,
    services: design.services.map((service) =>
      service.table !== table
        ? service
        : {
            ...service,
            operations: service.operations.map((operation) =>
              operation.id === id ? { ...operation, include: choose(operation.include, include) } : operation,
            ),
          },
    ),
  }
}

function mapModelMatch(design: CrudDesign, table: string, direction: Direction, change: (match: ModelMatch) => ModelMatch): CrudDesign {
  if (!design.matching) return design
  return {
    ...design,
    matching: {
      tables: design.matching.tables.map((item) =>
        item.table !== table
          ? item
          : { ...item, models: item.models.map((match) => (match.direction === direction ? change(match) : match)) },
      ),
    },
  }
}

function findModelMatch(design: CrudDesign, table: string, direction: Direction): ModelMatch | undefined {
  return design.matching?.tables.find((item) => item.table === table)?.models.find((match) => match.direction === direction)
}

/**
 * Chooses the model of a table in one direction. The columns are matched again with the new model when the design
 * is proposed again: the choices made on those of the previous one are left behind.
 */
export function chooseModel(design: CrudDesign, table: string, direction: Direction, model: string | null): CrudDesign {
  return mapModelMatch(design, table, direction, (match) => {
    const next = choose(match.model, model)
    if (next === match.model) return match
    return sameValue(match.model.value, model) ? { ...match, model: next } : { ...match, model: next, columns: [], children: [] }
  })
}

/** Chooses where a column comes from (or goes to) in the model of one direction. */
export function chooseSource(
  design: CrudDesign,
  table: string,
  direction: Direction,
  column: string,
  source: ColumnSource | null,
): CrudDesign {
  return mapModelMatch(design, table, direction, (match) => ({
    ...match,
    columns: match.columns.map((item) => (item.column === column ? { ...item, source: choose(item.source, source) } : item)),
  }))
}

/** Chooses the child table a list field stands for, or none. */
export function chooseChildTable(design: CrudDesign, table: string, direction: Direction, field: string, child: string | null): CrudDesign {
  return mapModelMatch(design, table, direction, (match) => ({
    ...match,
    children: match.children.map((item) => (item.field === field ? { ...item, table: choose(item.table, child) } : item)),
  }))
}

/** The decision a reference points to, or undefined when the design no longer has it. */
export function findDecision(design: CrudDesign, ref: CrudDecisionRef): Decision<unknown> | undefined {
  if (ref.kind === 'policy') {
    const policy = design.policies.find((item) => item.table === ref.table)
    return (policy?.[ref.decision] as Decision<unknown> | null | undefined) ?? undefined
  }
  if (ref.kind === 'query')
    return design.repositories.find((item) => item.table === ref.table)?.queries.find((query) => query.id === ref.id)?.include
  if (ref.kind === 'model') return findModelMatch(design, ref.table, ref.direction)?.model
  if (ref.kind === 'source')
    return findModelMatch(design, ref.table, ref.direction)?.columns.find((item) => item.column === ref.column)?.source
  if (ref.kind === 'childTable')
    return findModelMatch(design, ref.table, ref.direction)?.children.find((item) => item.field === ref.field)?.table
  return design.services.find((item) => item.table === ref.table)?.operations.find((operation) => operation.id === ref.id)?.include
}

/** Confirms a pending proposal as it is. */
export function accept(design: CrudDesign, ref: CrudDecisionRef): CrudDesign {
  const current = findDecision(design, ref)
  if (!current) return design
  if (ref.kind === 'policy') return decidePolicy(design, ref.table, ref.decision, current.value)
  if (ref.kind === 'query') return setQueryInclude(design, ref.table, ref.id, current.value as boolean)
  if (ref.kind === 'model') return chooseModel(design, ref.table, ref.direction, current.value as string | null)
  if (ref.kind === 'source') return chooseSource(design, ref.table, ref.direction, ref.column, current.value as ColumnSource | null)
  if (ref.kind === 'childTable') return chooseChildTable(design, ref.table, ref.direction, ref.field, current.value as string | null)
  return setOperationInclude(design, ref.table, ref.id, current.value as boolean)
}

/** Every decision still waiting for the user, table by table: policies, queries, operations, then the models. */
export function pendingDecisions(design: CrudDesign): CrudDecisionRef[] {
  const pending: CrudDecisionRef[] = []
  for (const policy of design.policies) {
    for (const decision of ['role', 'delete', 'concurrency', 'children', 'hidden'] as const)
      if (policy[decision]?.status === 'pending') pending.push({ kind: 'policy', table: policy.table, decision })
    const repository = design.repositories.find((item) => item.table === policy.table)
    for (const query of repository?.queries ?? [])
      if (query.include.status === 'pending') pending.push({ kind: 'query', table: policy.table, id: query.id })
    const service = design.services.find((item) => item.table === policy.table)
    for (const operation of service?.operations ?? [])
      if (operation.include.status === 'pending') pending.push({ kind: 'operation', table: policy.table, id: operation.id })
    for (const match of design.matching?.tables.find((item) => item.table === policy.table)?.models ?? []) {
      const { direction } = match
      if (match.model.status === 'pending') pending.push({ kind: 'model', table: policy.table, direction })
      for (const column of match.columns)
        if (column.source.status === 'pending') pending.push({ kind: 'source', table: policy.table, direction, column: column.column })
      for (const child of match.children)
        if (child.table.status === 'pending') pending.push({ kind: 'childTable', table: policy.table, direction, field: child.field })
    }
  }
  return pending
}
