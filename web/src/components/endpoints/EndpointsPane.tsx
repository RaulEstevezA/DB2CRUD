/**
 * Endpoints pane: the API Model2API proposes for the models, to review and change. It lists what waits for
 * the user and the problems that leave an endpoint out of the code, with undo, redo and reset.
 */
import { decisionElementId, endpointElementId, focusElement } from '../../app/review.ts'
import type { ApiDesign } from '../../core/api/types.ts'
import type { ProjectSettings } from '../../core/compatibility/stack.ts'
import { getDecision, pendingDecisions } from '../../core/design/edit.ts'
import type { ModelSchema } from '../../core/model/schema.ts'
import type { DesignIssue } from '../../core/validation/design.ts'
import type { ApiDesignState } from '../../hooks/useApiDesign.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { Pane } from '../common/Pane.tsx'
import { ResourceCard } from './ResourceCard.tsx'
import './EndpointsPane.css'

export interface EndpointsPaneProps {
  schema: ModelSchema | null
  design: ApiDesign | null
  settings: ProjectSettings
  issues: DesignIssue[]
  state: Pick<ApiDesignState, 'change' | 'reset' | 'history'>
}

export function EndpointsPane({ schema, design, settings, issues, state }: EndpointsPaneProps) {
  const { t } = useI18n()
  const { change, reset, history } = state
  const pending = design ? pendingDecisions(design) : []
  const resources = design?.resources.filter((item) => item.expose.value === 'resource') ?? []
  const embedded = design?.resources.filter((item) => item.expose.value !== 'resource') ?? []
  const endpoints = resources.reduce((total, resource) => total + resource.endpoints.filter((endpoint) => endpoint.enabled).length, 0)
  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')

  return (
    <Pane
      title={t.workspaceParts.endpoints}
      actions={
        <>
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
        </>
      }
      footer={
        design ? (
          <p className={pending.length > 0 ? 'endpoints__status endpoints__status--pending' : 'endpoints__status'}>
            {t.designSummary(resources.length, endpoints)}
            {pending.length > 0 && ` · ${t.pendingCount(pending.length)}`}
          </p>
        ) : null
      }
    >
      {!design || !schema ? (
        <p className="pane-empty">{t.endpointsEmpty}</p>
      ) : (
        <div className="endpoints">
          {pending.length > 0 && (
            <details className="review-box" open>
              <summary>{t.pendingCount(pending.length)}</summary>
              <ul>
                {pending.map((ref) => {
                  const where = ref.kind === 'expose' || ref.kind === 'key' ? ref.model : `${ref.model}.${ref.field}`
                  const decision = getDecision(design, ref)
                  return (
                    <li key={decisionElementId(ref)}>
                      <button type="button" className="review-box__link" onClick={() => focusElement(decisionElementId(ref))}>
                        {where}
                      </button>{' '}
                      {decision ? decision.reasons.map((reason) => t.reason(reason)).join(' ') : ''}
                    </li>
                  )
                })}
              </ul>
            </details>
          )}
          {issues.length > 0 && (
            <details className={errors.length > 0 ? 'review-box review-box--danger' : 'review-box'} open={errors.length > 0}>
              <summary>{t.issuesSummary(errors.length, warnings.length)}</summary>
              <ul>
                {issues.map((issue, index) => (
                  <li key={index}>
                    {issue.endpoint ? (
                      <button type="button" className="review-box__link" onClick={() => focusElement(endpointElementId(issue.endpoint!))}>
                        {issue.model}
                      </button>
                    ) : (
                      <span className="mono">{issue.model}</span>
                    )}{' '}
                    {t.issue(issue)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {resources.length === 0 && <p className="pane-empty">{t.noResources}</p>}
          {resources.map((resource) => (
            <ResourceCard
              key={resource.model}
              schema={schema}
              resource={resource}
              settings={settings}
              issues={issues.filter((issue) => issue.model === resource.model)}
              change={change}
            />
          ))}
          {embedded.length > 0 && (
            <>
              <h3 className="endpoints__section">{t.embeddedSection}</h3>
              <p className="endpoints__hint">{t.embeddedHint}</p>
              {embedded.map((resource) => (
                <ResourceCard key={resource.model} schema={schema} resource={resource} settings={settings} issues={[]} change={change} />
              ))}
            </>
          )}
        </div>
      )}
    </Pane>
  )
}
