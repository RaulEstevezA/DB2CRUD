/**
 * Models pane: the models to make an API of, pasted, opened or dropped, read in the browser and never
 * uploaded. The footer says what was read or where the input cannot be read.
 */
import type { LanguageSupport } from '@codemirror/language'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { acceptedExtensions, detectFormat, findParser, parsers } from '../../core/importers/registry.ts'
import type { InputFormatId } from '../../core/importers/types.ts'
import type { InputState, ReadInput } from '../../app/workspace.ts'
import { fieldCount } from '../../app/workspace.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { editorLanguage } from '../common/editorLanguages.ts'
import { CodeEditor } from '../common/CodeEditor.tsx'
import { Pane } from '../common/Pane.tsx'
import './ModelsPane.css'

// Far above any model or example document; avoids freezing the tab with a huge file dropped by mistake
const MAX_FILE_SIZE = 10 * 1024 * 1024

export interface ModelsPaneProps {
  input: InputState
  read: ReadInput
  onChange: (input: InputState) => void
}

/** The input editor with its format, file actions and status. */
export function ModelsPane({ input, read, onChange }: ModelsPaneProps) {
  const { t } = useI18n()
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [language, setLanguage] = useState<LanguageSupport | null>(null)
  const format = read.format
  const parser = format ? findParser(format) : undefined
  const detected = input.text.trim() !== '' ? detectFormat(input.text, input.fileName) : null
  const outcome = read.outcome

  useEffect(() => {
    let active = true
    void editorLanguage(parser?.editorLanguage ?? 'text').then((loaded) => {
      if (active) setLanguage(loaded)
    })
    return () => {
      active = false
    }
  }, [parser?.editorLanguage])

  function change(next: Partial<InputState>) {
    setFileError(null)
    onChange({ ...input, ...next })
  }

  async function openFile(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      setFileError(t.fileTooLarge(file.name))
      return
    }
    try {
      const text = await file.text()
      onChange({ text, format: null, fileName: file.name })
      setFileError(null)
    } catch {
      setFileError(t.fileError(file.name))
    }
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

  let status: ReactNode
  if (fileError) {
    status = (
      <p className="input-status input-status--error" role="alert">
        {fileError}
      </p>
    )
  } else if (input.text.trim() === '') {
    status = <p className="input-status">{t.inputEmpty}</p>
  } else if (!format) {
    status = (
      <p className="input-status input-status--warning" role="alert">
        {t.undetected}
      </p>
    )
  } else if (outcome && !outcome.ok) {
    const { error } = outcome
    status = (
      <p className="input-status input-status--error" role="alert">
        {error.line !== undefined && <strong>{t.errorPosition(error.line, error.column ?? 1)} · </strong>}
        {t.parseIssue(error)}
      </p>
    )
  } else if (outcome?.ok) {
    status = (
      <p className="input-status input-status--ok">
        {input.receivedFrom && <span className="input-status__received">{t.receivedFrom(input.receivedFrom)} </span>}
        {t.inputSummary(parser?.label ?? format, outcome.schema.models.length, fieldCount(outcome.schema))}
        {outcome.warnings.length > 0 && (
          <span className="input-status__warnings" title={outcome.warnings.map((warning) => t.parseIssue(warning)).join('\n')}>
            {' · '}
            {t.warningsCount(outcome.warnings.length)}
          </span>
        )}
      </p>
    )
  }

  return (
    <div
      className={`models-pane${dragging ? ' models-pane--dragging' : ''}`}
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
        title={t.workspaceParts.models}
        actions={
          <>
            <button type="button" className="button" onClick={() => fileInput.current?.click()}>
              {t.openFile}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => change({ text: '', format: null, fileName: undefined, receivedFrom: undefined })}
              disabled={input.text === ''}
            >
              {t.clear}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={acceptedExtensions().join(',')}
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
        <div className="models-pane__settings">
          <label className="field">
            <span>{t.formatLabel}</span>
            <select
              className="select"
              value={input.format ?? ''}
              onChange={(event) => change({ format: (event.target.value || null) as InputFormatId | null })}
            >
              <option value="">{t.formatAuto(detected ? (findParser(detected)?.label ?? detected) : null)}</option>
              {parsers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="models-pane__editor">
          <CodeEditor
            value={input.text}
            onChange={(text) => change({ text, receivedFrom: undefined })}
            language={language}
            label={t.inputLabel}
            placeholder={t.inputPlaceholder}
            errorLine={outcome && !outcome.ok && outcome.error.line !== undefined ? outcome.error.line : null}
          />
          {dragging && <div className="models-pane__drop">{t.dropFile}</div>}
        </div>
      </Pane>
    </div>
  )
}
