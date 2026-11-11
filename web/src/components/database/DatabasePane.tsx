/**
 * Database pane: the database the code is generated for, pasted, opened or dropped, read in the browser and
 * never uploaded. Today it reads Model2DB projects; DDL and ORM code come next (ROADMAP). The footer says
 * what was read or why the input cannot be read.
 */
import type { LanguageSupport } from '@codemirror/language'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { columnCount, type InputState } from '../../app/workspace.ts'
import type { Model2DBReadResult } from '../../core/interop/model2db/read.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { CodeEditor } from '../common/CodeEditor.tsx'
import { editorLanguage } from '../common/editorLanguages.ts'
import { Pane } from '../common/Pane.tsx'
import './DatabasePane.css'

// Far above any project; avoids freezing the tab with a huge file dropped by mistake
const MAX_FILE_SIZE = 10 * 1024 * 1024

export interface DatabasePaneProps {
  input: InputState
  read: Model2DBReadResult | null
  onChange: (input: InputState) => void
}

/** The input editor with its file actions and status. */
export function DatabasePane({ input, read, onChange }: DatabasePaneProps) {
  const { t } = useI18n()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [language, setLanguage] = useState<LanguageSupport | null>(null)

  useEffect(() => {
    let active = true
    void editorLanguage('json').then((loaded) => {
      if (active) setLanguage(loaded)
    })
    return () => {
      active = false
    }
  }, [])

  async function openFile(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      setFileError(t.fileTooLarge(file.name))
      return
    }
    try {
      onChange({ text: await file.text(), fileName: file.name })
      setFileError(null)
    } catch {
      setFileError(t.fileError(file.name))
    }
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

  let status: ReactNode
  if (fileError)
    status = (
      <p className="input-status input-status--error" role="alert">
        {fileError}
      </p>
    )
  else if (!read) status = <p className="input-status">{t.inputEmpty}</p>
  else if (!read.ok)
    status = (
      <p className="input-status input-status--error" role="alert">
        {t.readError(read.error, read.path)}
      </p>
    )
  else
    status = (
      <p className="input-status input-status--ok">
        {t.databaseSummary(read.schema.source.format, read.schema.dialect, read.schema.tables.length, columnCount(read.schema))}
        {read.schema.notes.length > 0 && (
          <span className="input-status__warnings" title={read.schema.notes.map((note) => note.code).join('\n')}>
            {' · '}
            {t.warningsCount(read.schema.notes.length)}
          </span>
        )}
      </p>
    )

  return (
    <div
      className={`database-pane${dragging ? ' database-pane--dragging' : ''}`}
      onDragOver={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDropCapture={(event) => {
        if (!hasFiles(event)) return
        // Captured before CodeMirror, which would otherwise insert the file as text
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        const file = event.dataTransfer.files[0]
        if (file) void openFile(file)
      }}
    >
      <Pane
        title={t.workspaceParts.database}
        actions={
          <>
            <button type="button" className="button" onClick={() => fileInput.current?.click()}>
              {t.openFile}
            </button>
            <button type="button" className="button" onClick={() => onChange({ text: '' })} disabled={input.text === ''}>
              {t.clear}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.model2db.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void openFile(file)
              }}
            />
          </>
        }
        footer={status}
      >
        <div className="database-pane__editor">
          <CodeEditor
            value={input.text}
            onChange={(text) => {
              setFileError(null)
              onChange({ text })
            }}
            language={language}
            label={t.inputLabel}
            placeholder={t.inputPlaceholder}
          />
          {dragging && <div className="database-pane__drop">{t.dropFile}</div>}
        </div>
      </Pane>
    </div>
  )
}
