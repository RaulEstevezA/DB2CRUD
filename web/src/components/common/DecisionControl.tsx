/**
 * One decision of the design: the chosen or suggested option, its state in text and color, and why it was
 * proposed. A pending decision offers to confirm the suggestion as it is, or to choose another option.
 */
import { useRef } from 'react'
import { sameValue, type Decision } from '../../core/decisions/decision.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { ConfidenceBadge } from './ConfidenceBadge.tsx'
import './DecisionControl.css'

export interface DecisionControlProps<T> {
  /** Element id, so the review list can take the focus here */
  id: string
  /** What the decision is about, for the select's name and the confirm button: “Order: key” */
  subject: string
  decision: Decision<T>
  optionLabel: (value: T) => string
  onChoose: (value: T) => void
  onAccept: () => void
  /** Hides the reason, for dense rows: it stays in the title of the badge */
  compact?: boolean
}

export function DecisionControl<T>({ id, subject, decision, optionLabel, onChoose, onAccept, compact = false }: DecisionControlProps<T>) {
  const { t } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const select = useRef<HTMLSelectElement>(null)
  const pending = decision.status === 'pending'
  const index = Math.max(
    0,
    decision.options.findIndex((option) => sameValue(option, decision.value)),
  )
  const why = decision.manual ? t.reason({ code: 'manual' }) : decision.reasons.map((reason) => t.reason(reason)).join(' ')

  return (
    <div
      ref={container}
      className={`decision${pending ? ' decision--pending' : ''}`}
      id={id}
      tabIndex={-1}
      role="group"
      aria-label={subject}
    >
      <div className="decision__row">
        {decision.options.length > 1 ? (
          <select
            ref={select}
            className="select decision__select"
            aria-label={subject}
            aria-describedby={compact ? undefined : `${id}-why`}
            title={compact ? why : undefined}
            value={index}
            onChange={(event) => onChoose(decision.options[Number(event.target.value)])}
          >
            {decision.options.map((option, i) => (
              <option key={i} value={i}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
        ) : (
          <span className="decision__value" title={compact ? why : undefined}>
            {optionLabel(decision.value)}
          </span>
        )}
        {(!compact || pending || decision.manual) && (
          <ConfidenceBadge confidence={decision.manual ? 'manual' : decision.confidence} title={why} />
        )}
        {pending && (
          <button
            type="button"
            className="button button--small"
            title={t.acceptTitle(subject)}
            aria-label={t.acceptTitle(subject)}
            onClick={() => {
              onAccept()
              // The button goes away once confirmed: the focus stays on this decision instead of the page
              ;(select.current ?? container.current)?.focus()
            }}
          >
            {t.accept}
          </button>
        )}
      </div>
      {!compact && (
        <p className="decision__why" id={`${id}-why`}>
          {why}
        </p>
      )}
    </div>
  )
}
