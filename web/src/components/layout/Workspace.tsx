/**
 * Workspace: the models and their endpoints side by side, and the generated project under them, at full
 * width. Below 1100px one part at a time, chosen with tabs (personal_web_style RESPONSIVE_GUIDE.md).
 * It only arranges the panes; each pane is built by the caller.
 */
import { useState, type ReactNode } from 'react'
import { WORKSPACE_PARTS, type WorkspacePart } from '../../app/workspaceParts.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { onTabListKeyDown } from '../common/tabKeys.ts'
import './Workspace.css'

export interface WorkspaceProps {
  panes: Record<WorkspacePart, ReactNode>
  /** Count shown on a tab: pending decisions, problems; 0 shows nothing */
  counts?: Partial<Record<WorkspacePart, number>>
  /** Parts whose tab says something is wrong (an input that cannot be read) */
  errors?: Partial<Record<WorkspacePart, boolean>>
  /** The part shown first on narrow screens, and whenever it changes */
  part?: WorkspacePart
}

/** Models → Endpoints → Project, with the tabs that show one part at a time on narrow screens. */
export function Workspace({ panes, counts = {}, errors = {}, part: requested = 'models' }: WorkspaceProps) {
  const { t } = useI18n()
  const [state, setState] = useState({ requested, part: requested })
  // A new requested part (an example loaded, a project opened) moves the tabs to it
  if (state.requested !== requested) setState({ requested, part: requested })
  const part = state.part
  const select = (next: WorkspacePart) => setState({ requested, part: next })

  return (
    <>
      <div
        className="workspace__tabs"
        role="tablist"
        aria-label={t.workspaceLabel}
        onKeyDown={(event) => onTabListKeyDown(event, (index) => select(WORKSPACE_PARTS[index]))}
      >
        {WORKSPACE_PARTS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={part === id}
            tabIndex={part === id ? 0 : -1}
            className="workspace__tab"
            onClick={() => select(id)}
          >
            {t.workspaceParts[id]}
            {(counts[id] ?? 0) > 0 && (
              <span className="workspace__tab-badge" aria-label={t.pendingCount(counts[id]!)}>
                {counts[id]}
              </span>
            )}
            {errors[id] && (
              <span className="workspace__tab-badge workspace__tab-badge--error" aria-label={t.hasError}>
                !
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="workspace" data-part={part}>
        <div className="workspace__top">
          {panes.models}
          {panes.endpoints}
        </div>
        <div className="workspace__project">{panes.project}</div>
      </div>
    </>
  )
}
