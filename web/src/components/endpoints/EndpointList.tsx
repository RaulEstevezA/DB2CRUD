/**
 * Endpoints of a resource: each one can be turned on and off and edited in place. Business endpoints can
 * be added and removed; standard ones are only turned off, never removed.
 */
import { useState } from 'react'
import { endpointElementId } from '../../app/review.ts'
import { HTTP_METHODS, type ApiDesign, type Endpoint, type EndpointAccess, type ResourceDesign } from '../../core/api/types.ts'
import type { ProjectSettings } from '../../core/compatibility/stack.ts'
import { addCustomEndpoint, removeEndpoint, updateEndpoint, type EndpointPatch } from '../../core/design/edit.ts'
import type { ModelSchema } from '../../core/model/schema.ts'
import { filterableFields, type DesignIssue } from '../../core/validation/design.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { CommitInput } from '../common/CommitInput.tsx'

export interface EndpointListProps {
  schema: ModelSchema
  resource: ResourceDesign
  settings: ProjectSettings
  issues: DesignIssue[]
  change: (edit: (design: ApiDesign) => ApiDesign) => void
}

const ACCESS: EndpointAccess[] = ['default', 'public', 'authenticated', 'roles']

export function EndpointList({ schema, resource, settings, issues, change }: EndpointListProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState<string | null>(null)
  const update = (id: string, patch: EndpointPatch) => change((design) => updateEndpoint(design, resource.model, id, patch))
  const filterable = [...filterableFields(resource, schema)]

  return (
    <div className="endpoint-list">
      <ul className="endpoint-list__items">
        {resource.endpoints.map((endpoint) => {
          const own = issues.filter((issue) => issue.endpoint === endpoint.id)
          const errors = own.filter((issue) => issue.severity === 'error')
          const expanded = open === endpoint.id
          return (
            <li
              key={endpoint.id}
              id={endpointElementId(endpoint.id)}
              tabIndex={-1}
              className={`endpoint${endpoint.enabled ? '' : ' endpoint--off'}`}
            >
              <div className="endpoint__row">
                <input
                  type="checkbox"
                  checked={endpoint.enabled}
                  aria-label={t.enableEndpoint(`${endpoint.method} ${endpoint.path}`)}
                  onChange={(event) => update(endpoint.id, { enabled: event.target.checked })}
                />
                <span className={`endpoint__method endpoint__method--${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
                <span className="endpoint__path">{endpoint.path}</span>
                <span className="endpoint__summary">{endpoint.summary}</span>
                {endpoint.operation === 'custom' && <span className="badge">{t.customBadge}</span>}
                {!endpoint.enabled && <span className="badge">{t.endpointOff}</span>}
                {errors.length > 0 && (
                  <span className="badge badge--danger" title={errors.map((issue) => t.issue(issue)).join('\n')}>
                    {t.notGenerated}
                  </span>
                )}
                <button
                  type="button"
                  className="button button--small endpoint__edit"
                  aria-expanded={expanded}
                  aria-controls={`${endpointElementId(endpoint.id)}-editor`}
                  onClick={() => setOpen(expanded ? null : endpoint.id)}
                >
                  {expanded ? t.done : t.edit}
                </button>
              </div>
              {own.length > 0 && (
                <ul className="endpoint__issues">
                  {own.map((issue, index) => (
                    <li key={index} className={issue.severity === 'error' ? 'endpoint__issue--error' : 'endpoint__issue--warning'}>
                      {t.issue(issue)}
                    </li>
                  ))}
                </ul>
              )}
              {expanded && (
                <EndpointEditor
                  id={`${endpointElementId(endpoint.id)}-editor`}
                  endpoint={endpoint}
                  filterable={filterable}
                  auth={settings.auth}
                  onChange={(patch) => update(endpoint.id, patch)}
                  onRemove={() => {
                    setOpen(null)
                    change((design) => removeEndpoint(design, resource.model, endpoint.id))
                  }}
                />
              )}
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        className="button button--small"
        onClick={() => {
          let added = ''
          change((design) => {
            const result = addCustomEndpoint(design, resource.model)
            added = result.id
            return result.design
          })
          if (added) setOpen(added)
        }}
      >
        {t.addEndpoint}
      </button>
    </div>
  )
}

interface EndpointEditorProps {
  id: string
  endpoint: Endpoint
  filterable: string[]
  auth: ProjectSettings['auth']
  onChange: (patch: EndpointPatch) => void
  onRemove: () => void
}

/** The settings of one endpoint. Every change applies at once and can be undone. */
function EndpointEditor({ id, endpoint, filterable, auth, onChange, onRemove }: EndpointEditorProps) {
  const { t } = useI18n()
  const custom = endpoint.operation === 'custom'
  const toggle = (list: string[] | undefined, field: string) =>
    list?.includes(field) ? list.filter((item) => item !== field) : [...(list ?? []), field]

  return (
    <div className="endpoint-editor" id={id}>
      <div className="endpoint-editor__grid">
        {custom && (
          <label className="field">
            <span>{t.methodLabel}</span>
            <select
              className="select"
              value={endpoint.method}
              onChange={(event) => onChange({ method: event.target.value as Endpoint['method'] })}
            >
              {HTTP_METHODS.map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field endpoint-editor__wide">
          <span>{t.pathLabel}</span>
          <CommitInput className="input input--mono" value={endpoint.path} onCommit={(path) => onChange({ path })} spellCheck={false} />
        </label>
        <label className="field">
          <span>{t.nameLabel}</span>
          <CommitInput
            className="input input--mono"
            value={endpoint.name}
            onCommit={(name) => onChange({ name: name.trim() })}
            spellCheck={false}
          />
        </label>
        <label className="field endpoint-editor__wide">
          <span>{t.summaryLabel}</span>
          <CommitInput
            className="input"
            value={endpoint.summary}
            onCommit={(summary) => onChange({ summary: summary.trim() || endpoint.summary })}
          />
        </label>
        <label className="field">
          <span>{t.accessLabel}</span>
          <select
            className="select"
            value={endpoint.access}
            onChange={(event) => onChange({ access: event.target.value as EndpointAccess })}
          >
            {ACCESS.map((access) => (
              <option key={access} value={access}>
                {t.endpointAccess[access]}
              </option>
            ))}
          </select>
        </label>
        {endpoint.access === 'roles' && (
          <label className="field">
            <span>{t.rolesLabel}</span>
            <CommitInput
              className="input input--mono"
              value={endpoint.roles.join(', ')}
              onCommit={(text) => onChange({ roles: text.split(',') })}
              spellCheck={false}
            />
          </label>
        )}
        <label className="field">
          <span>{t.statusLabel}</span>
          <CommitInput
            className="input input--mono"
            inputMode="numeric"
            value={endpoint.status === undefined ? '' : String(endpoint.status)}
            placeholder={t.statusDefault}
            onCommit={(text) => onChange({ status: text.trim() === '' ? undefined : Number(text) })}
          />
        </label>
        {custom && (
          <>
            <label className="field">
              <span>{t.inputBodyLabel}</span>
              <select
                className="select"
                value={endpoint.input ?? 'none'}
                onChange={(event) => onChange({ input: event.target.value as Endpoint['input'] })}
              >
                {(['none', 'resource', 'partial'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t.customInput[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t.outputLabel}</span>
              <select
                className="select"
                value={endpoint.output ?? 'resource'}
                onChange={(event) => onChange({ output: event.target.value as Endpoint['output'] })}
              >
                {(['none', 'resource', 'list'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t.customOutput[value]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {endpoint.operation === 'list' && (
        <div className="endpoint-editor__list">
          <label className="check">
            <input
              type="checkbox"
              checked={endpoint.pagination === true}
              onChange={(event) => onChange({ pagination: event.target.checked })}
            />
            {t.paginationLabel}
          </label>
          {filterable.length > 0 && (
            <>
              <div className="endpoint-editor__chips" role="group" aria-label={t.filtersLabel}>
                <span className="endpoint-editor__chips-label">{t.filtersLabel}</span>
                {filterable.map((field) => (
                  <button
                    key={field}
                    type="button"
                    className="chip"
                    aria-pressed={endpoint.filters?.includes(field) === true}
                    onClick={() => onChange({ filters: toggle(endpoint.filters, field) })}
                  >
                    {field}
                  </button>
                ))}
              </div>
              <div className="endpoint-editor__chips" role="group" aria-label={t.sortLabel}>
                <span className="endpoint-editor__chips-label">{t.sortLabel}</span>
                {filterable.map((field) => (
                  <button
                    key={field}
                    type="button"
                    className="chip"
                    aria-pressed={endpoint.sort?.includes(field) === true}
                    onClick={() => onChange({ sort: toggle(endpoint.sort, field) })}
                  >
                    {field}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {auth === 'none' && endpoint.access !== 'default' && endpoint.access !== 'public' && (
        <p className="endpoint-editor__note">{t.accessNeedsAuth}</p>
      )}
      {custom && (
        <div className="endpoint-editor__footer">
          <p className="endpoint-editor__note">{t.customNote}</p>
          <button type="button" className="button button--small" onClick={onRemove}>
            {t.removeEndpoint}
          </button>
        </div>
      )}
    </div>
  )
}
