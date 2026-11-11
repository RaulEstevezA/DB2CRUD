/**
 * State of a decision as text with a color (personal_web_style patterns/confidence-states.md): never
 * color alone.
 */
import type { Confidence } from '../../core/decisions/decision.ts'
import { useI18n } from '../../i18n/useI18n.ts'

const VARIANT: Record<Confidence | 'manual', string> = {
  exact: 'badge--success',
  high: 'badge--success',
  probable: 'badge--accent',
  review: 'badge--warning',
  conflict: 'badge--warning',
  none: '',
  manual: 'badge--accent',
}

export function ConfidenceBadge({ confidence, title }: { confidence: Confidence | 'manual'; title?: string }) {
  const { t } = useI18n()
  return (
    <span className={`badge ${VARIANT[confidence]}`} title={title}>
      {t.status[confidence]}
    </span>
  )
}
