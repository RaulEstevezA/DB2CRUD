/**
 * Edits of a CRUD design. Each returns a new design and leaves the previous one untouched, so the history
 * can keep it for undo. After an edit that changes a table decision, the caller proposes the design again
 * with the edited one as `previous` (crud/propose.ts), so the operations that depend on it follow.
 */
import { sameValue, type Decision } from '../decisions/decision.ts'
import type { CrudDesign, PolicyDecisionKind, TablePolicy } from './types.ts'

/** Where a decision lives in a design, for the review list and the interface. */
export type CrudDecisionRef =
  | { kind: 'policy'; table: string; decision: PolicyDecisionKind }
  | { kind: 'query'; table: string; id: string }
  | { kind: 'operation'; table: string; id: string }

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

/** The decision a reference points to, or undefined when the design no longer has it. */
export function findDecision(design: CrudDesign, ref: CrudDecisionRef): Decision<unknown> | undefined {
  if (ref.kind === 'policy') {
    const policy = design.policies.find((item) => item.table === ref.table)
    return (policy?.[ref.decision] as Decision<unknown> | null | undefined) ?? undefined
  }
  if (ref.kind === 'query')
    return design.repositories.find((item) => item.table === ref.table)?.queries.find((query) => query.id === ref.id)?.include
  return design.services.find((item) => item.table === ref.table)?.operations.find((operation) => operation.id === ref.id)?.include
}

/** Confirms a pending proposal as it is. */
export function accept(design: CrudDesign, ref: CrudDecisionRef): CrudDesign {
  const current = findDecision(design, ref)
  if (!current) return design
  if (ref.kind === 'policy') return decidePolicy(design, ref.table, ref.decision, current.value)
  if (ref.kind === 'query') return setQueryInclude(design, ref.table, ref.id, current.value as boolean)
  return setOperationInclude(design, ref.table, ref.id, current.value as boolean)
}

/** Every decision still waiting for the user, table by table: policies, then queries, then operations. */
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
  }
  return pending
}
