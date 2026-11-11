/**
 * One model in the endpoints pane: whether it is a resource, its key, the first segment of its paths, its
 * fields and, for resources, its endpoints.
 */
import { decisionElementId } from '../../app/review.ts'
import type { ApiDesign, ResourceDesign } from '../../core/api/types.ts'
import type { ProjectSettings } from '../../core/compatibility/stack.ts'
import { decide, setResourcePath } from '../../core/design/edit.ts'
import { defaultResourcePath, keyField } from '../../core/design/propose.ts'
import type { ModelSchema } from '../../core/model/schema.ts'
import type { DesignIssue } from '../../core/validation/design.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { CommitInput } from '../common/CommitInput.tsx'
import { DecisionControl } from '../common/DecisionControl.tsx'
import { EndpointList } from './EndpointList.tsx'
import { FieldTable } from './FieldTable.tsx'

export interface ResourceCardProps {
  schema: ModelSchema
  resource: ResourceDesign
  settings: ProjectSettings
  issues: DesignIssue[]
  change: (edit: (design: ApiDesign) => ApiDesign) => void
}

export function ResourceCard({ schema, resource, settings, issues, change }: ResourceCardProps) {
  const { t } = useI18n()
  const isResource = resource.expose.value === 'resource'
  const titleId = `resource-${resource.model.replace(/[^\w-]/g, '_')}`
  const enabled = resource.endpoints.filter((endpoint) => endpoint.enabled).length
  return (
    <section className="resource-card" aria-labelledby={titleId}>
      <div className="resource-card__header">
        <h3 className="resource-card__title" id={titleId}>
          {resource.model}
        </h3>
        {isResource && (
          <label className="resource-card__path">
            <span className="visually-hidden">{t.resourcePathLabel(resource.model)}</span>
            <span aria-hidden="true">/</span>
            <CommitInput
              className="input input--mono"
              value={resource.path ?? ''}
              placeholder={defaultResourcePath(resource.model)}
              spellCheck={false}
              onCommit={(path) => change((design) => setResourcePath(design, resource.model, path))}
            />
          </label>
        )}
      </div>
      <div className="resource-card__decisions">
        <div className="resource-card__decision">
          <span className="resource-card__label">{t.exposeLabel}</span>
          <DecisionControl
            id={decisionElementId({ kind: 'expose', model: resource.model })}
            subject={t.exposeSubject(resource.model)}
            decision={resource.expose}
            optionLabel={(value) => t.exposeOptions[value]}
            onChoose={(value) => change((design) => decide(design, { kind: 'expose', model: resource.model }, value))}
            onAccept={() => change((design) => decide(design, { kind: 'expose', model: resource.model }))}
          />
        </div>
        {isResource && resource.key && (
          <div className="resource-card__decision">
            <span className="resource-card__label">{t.keyLabel}</span>
            <DecisionControl
              id={decisionElementId({ kind: 'key', model: resource.model })}
              subject={t.keySubject(resource.model)}
              decision={resource.key}
              optionLabel={(value) => t.keyOption(value)}
              onChoose={(value) => change((design) => decide(design, { kind: 'key', model: resource.model }, value))}
              onAccept={() => change((design) => decide(design, { kind: 'key', model: resource.model }))}
            />
          </div>
        )}
      </div>
      <details className="resource-card__fields">
        <summary>{t.fieldsSummary(resource.fields.length, resource.fields.filter((field) => field.include).length)}</summary>
        <FieldTable schema={schema} resource={resource} keyField={keyField(resource)} change={change} />
      </details>
      {isResource && (
        <div className="resource-card__endpoints">
          <p className="resource-card__label">{t.endpointsCount(enabled, resource.endpoints.length)}</p>
          <EndpointList schema={schema} resource={resource} settings={settings} issues={issues} change={change} />
        </div>
      )}
    </section>
  )
}
