/**
 * Project bar: saving and opening Model2API projects, and the opt-in to keep the work in this browser.
 */
import { useRef } from 'react'
import { useI18n } from '../../i18n/useI18n.ts'
import './ProjectBar.css'

interface ProjectBarProps {
  canSave: boolean
  remember: boolean
  hasSaved: boolean
  message: { text: string; kind: 'ok' | 'error' } | null
  onSave: () => void
  onOpen: (file: File) => void
  onRememberChange: (remember: boolean) => void
  onClearSaved: () => void
}

/** Saving and opening projects, and the opt-in to keep the work in this browser. */
export function ProjectBar({ canSave, remember, hasSaved, message, onSave, onOpen, onRememberChange, onClearSaved }: ProjectBarProps) {
  const { t } = useI18n()
  const fileInput = useRef<HTMLInputElement>(null)

  return (
    <section className="project-bar panel" aria-label={t.projectActions}>
      <div className="actions">
        <button type="button" className="button" onClick={() => fileInput.current?.click()}>
          {t.openProject}
        </button>
        <button type="button" className="button" onClick={onSave} disabled={!canSave}>
          {t.saveProject}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) onOpen(file)
          }}
        />
      </div>
      <div className="project-bar__storage">
        <label className="project-bar__remember" title={t.rememberHint}>
          <input type="checkbox" checked={remember} onChange={(event) => onRememberChange(event.target.checked)} />
          {t.remember}
        </label>
        {hasSaved && (
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              if (window.confirm(t.clearSavedConfirm)) onClearSaved()
            }}
          >
            {t.clearSaved}
          </button>
        )}
      </div>
      {message && (
        <p className={`project-bar__message project-bar__message--${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </section>
  )
}
