/**
 * Design pane: the CRUD design of the database, table by table. Each table shows the decisions the schema
 * cannot settle, the queries of its repository and the operations of its service, each with its
 * confidence; pending proposals are listed first and never applied on their own. Undo, redo and reset.
 */
import type { ReactNode } from 'react'
import { decisionId } from '../../app/review.ts'
import { accept, decidePolicy, pendingDecisions, setOperationInclude, setQueryInclude, type CrudDecisionRef } from '../../core/crud/edit.ts'
import type {
  Concurrency,
  CrudDesign,
  DeleteMode,
  OperationDesign,
  PolicyDecisionKind,
  QueryDesign,
  TablePolicy,
} from '../../core/crud/types.ts'
import type { Decision } from '../../core/decisions/decision.ts'
import type { CrudDesignState } from '../../hooks/useCrudDesign.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { ConfidenceBadge } from '../common/ConfidenceBadge.tsx'
import { DecisionControl } from '../common/DecisionControl.tsx'
import { Pane } from '../common/Pane.tsx'
import './DesignPane.css'

function focus(id: string) {
  const element = document.getElementById(id)
  element?.scrollIntoView({ block: 'center' })
  element?.focus()
}

export interface DesignPaneProps {
  state: CrudDesignState
}

export function DesignPane({ state }: DesignPaneProps) {
  const { t } = useI18n()
  const { design, change, reset, history } = state
  const pending = design ? pendingDecisions(design) : []

  const subjectOf = (ref: CrudDecisionRef) =>
    ref.kind === 'policy' ? t.policySubject(ref.table, t.policyKinds[ref.decision]) : t.itemSubject(ref.table, ref.id.split(':')[0], ref.id)

  return (
    <Pane
      title={t.workspaceParts.design}
      actions={
        <div className="actions">
          <button type="button" className="button" onClick={history.undo} disabled={!history.canUndo} title={t.undoTitle}>
            {t.undo}
          </button>
          <button type="button" className="button" onClick={history.redo} disabled={!history.canRedo} title={t.redoTitle}>
            {t.redo}
          </button>
          <button
            type="button"
            className="button"
            disabled={!design}
            title={t.resetTitle}
            onClick={() => {
              if (window.confirm(t.confirmReset)) reset()
            }}
          >
            {t.reset}
          </button>
        </div>
      }
      footer={
        design && (
          <p className={pending.length > 0 ? 'design__status design__status--pending' : 'design__status'}>
            {t.designSummary(design.repositories.length, design.services.length)}
            {pending.length > 0 && ` · ${t.pendingCount(pending.length)}`}
          </p>
        )
      }
    >
      {!design ? (
        <p className="pane-empty">{t.designEmpty}</p>
      ) : (
        <div className="design">
          {pending.length > 0 && (
            <details className="review-box" open>
              <summary>{t.pendingCount(pending.length)}</summary>
              <ul>
                {pending.map((ref) => (
                  <li key={decisionId(ref)}>
                    <button type="button" className="review-box__link" onClick={() => focus(decisionId(ref))}>
                      {subjectOf(ref)}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {design.policies.map((policy) => (
            <TableCard key={policy.table} design={design} policy={policy} onChange={change} />
          ))}
        </div>
      )}
    </Pane>
  )
}

interface TableCardProps {
  design: CrudDesign
  policy: TablePolicy
  onChange: CrudDesignState['change']
}

function TableCard({ design, policy, onChange }: TableCardProps) {
  const { t } = useI18n()
  const table = policy.table
  const repository = design.repositories.find((item) => item.table === table)
  const service = design.services.find((item) => item.table === table)

  const label = (kind: PolicyDecisionKind, value: unknown): string => {
    switch (kind) {
      case 'role':
        return t.roles[value as TablePolicy['role']['value']]
      case 'delete': {
        const mode = value as DeleteMode
        return mode.mode === 'hard' ? t.deleteHard : t.deleteSoft(mode.column)
      }
      case 'concurrency': {
        const mode = value as Concurrency
        return mode.mode === 'none' ? t.concurrencyNone : t.concurrencyVersion(mode.column)
      }
      case 'children':
        return t.childrenPolicies[value as 'block' | 'deleteFirst']
      case 'hidden': {
        const columns = value as string[]
        return columns.length === 0 ? t.hiddenNone : columns.join(', ')
      }
    }
  }

  const decisions = (['role', 'delete', 'concurrency', 'children', 'hidden'] as const)
    .map((kind) => [kind, policy[kind]] as const)
    .filter(([, decision]) => decision !== null) as [PolicyDecisionKind, Decision<unknown>][]

  return (
    <article className="table-card">
      <header className="table-card__header">
        <h3 className="table-card__title">
          <span className="mono">{table}</span>
          {repository && <span className="table-card__entity">{repository.entity}</span>}
        </h3>
        {repository?.entityMissing && <span className="badge badge--accent">{t.entityMissing}</span>}
      </header>
      <div className="table-card__decisions">
        {decisions.map(([kind, decision]) => (
          <div className="table-card__decision" key={kind}>
            <span className="table-card__label">{t.policyKinds[kind]}</span>
            <DecisionControl
              id={decisionId({ kind: 'policy', table, decision: kind })}
              subject={t.policySubject(table, t.policyKinds[kind])}
              decision={decision}
              optionLabel={(value) => label(kind, value)}
              onChoose={(value) => onChange((current) => decidePolicy(current, table, kind, value))}
              onAccept={() => onChange((current) => accept(current, { kind: 'policy', table, decision: kind }))}
              compact
            />
          </div>
        ))}
      </div>
      {repository && (
        <ItemList
          title={t.queriesTitle}
          items={repository.queries}
          refOf={(item) => ({ kind: 'query', table, id: item.id })}
          describe={(item: QueryDesign) => t.queryDescription(item.kind, item.columns)}
          onToggle={(item, include) => onChange((current) => setQueryInclude(current, table, item.id, include))}
          onAccept={(item) => onChange((current) => accept(current, { kind: 'query', table, id: item.id }))}
        />
      )}
      {service && (
        <ItemList
          title={t.operationsTitle(service.name)}
          items={service.operations}
          refOf={(item) => ({ kind: 'operation', table, id: item.id })}
          describe={(item: OperationDesign) => t.operationDescription(item)}
          onToggle={(item, include) => onChange((current) => setOperationInclude(current, table, item.id, include))}
          onAccept={(item) => onChange((current) => accept(current, { kind: 'operation', table, id: item.id }))}
        />
      )}
    </article>
  )
}

interface ItemListProps<T extends { id: string; name: string; include: Decision<boolean> }> {
  title: string
  items: T[]
  refOf: (item: T) => CrudDecisionRef
  describe: (item: T) => ReactNode
  onToggle: (item: T, include: boolean) => void
  onAccept: (item: T) => void
}

/** Queries or operations, each one on or off, with its confidence when it is not exact. */
function ItemList<T extends { id: string; name: string; include: Decision<boolean> }>({
  title,
  items,
  refOf,
  describe,
  onToggle,
  onAccept,
}: ItemListProps<T>) {
  const { t } = useI18n()
  return (
    <details className="table-card__items" open>
      <summary>{title}</summary>
      <ul className="item-list">
        {items.map((item) => {
          const ref = refOf(item)
          const include = item.include
          const pending = include.status === 'pending'
          return (
            <li key={item.id} className={include.value ? 'item' : 'item item--off'}>
              <label className="check">
                <input
                  type="checkbox"
                  id={decisionId(ref)}
                  checked={include.value}
                  onChange={(event) => onToggle(item, event.target.checked)}
                />
                <span className="mono item__name">{item.name}</span>
              </label>
              <span className="item__description">{describe(item)}</span>
              {(pending || include.manual || include.confidence !== 'exact') && (
                <ConfidenceBadge
                  confidence={include.manual ? 'manual' : include.confidence}
                  title={include.reasons.map((reason) => t.reason(reason)).join(' ')}
                />
              )}
              {pending && (
                <button type="button" className="button button--small" onClick={() => onAccept(item)} title={t.acceptTitle(item.name)}>
                  {t.accept}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
