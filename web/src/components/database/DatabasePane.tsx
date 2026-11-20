/**
 * Database pane: the database the code is generated for and, optionally, the application models the services take,
 * each in its own tab, pasted, opened or dropped, read in the browser and never uploaded. The database is a Model2DB
 * project, ORM code (SQLAlchemy, SQLModel, Django, Tortoise, Prisma, TypeORM, Sequelize, Drizzle, JPA, EF Core,
 * Doctrine and Eloquent so far) or SQL DDL; the models, classes and DTOs in any language or format the importers
 * read. The footer says what was read or why the input cannot be read.
 */
import type { LanguageSupport } from '@codemirror/language'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  MODEL_EXTENSIONS,
  columnCount,
  inputLanguage,
  modelsLanguage,
  sourceLabel,
  type DatabaseReadResult,
  type InputState,
  type ModelsReadResult,
} from '../../app/workspace.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { CodeEditor } from '../common/CodeEditor.tsx'
import { editorLanguage } from '../common/editorLanguages.ts'
import { Pane } from '../common/Pane.tsx'
import { onTabListKeyDown } from '../common/tabKeys.ts'
import './DatabasePane.css'

// Far above any project; avoids freezing the tab with a huge file dropped by mistake
const MAX_FILE_SIZE = 10 * 1024 * 1024

const DATABASE_EXTENSIONS = '.json,.model2db.json,.py,.prisma,.ts,.js,.java,.cs,.php,.sql'

type Source = 'database' | 'models'
const SOURCES: Source[] = ['database', 'models']

export interface DatabasePaneProps {
  input: InputState
  read: DatabaseReadResult | null
  onChange: (input: InputState) => void
  models: InputState
  modelsRead: ModelsReadResult | null
  onModelsChange: (input: InputState) => void
}

/** The input editors with their file actions and status. */
export function DatabasePane({ input, read, onChange, models, modelsRead, onModelsChange }: DatabasePaneProps) {
  const { t } = useI18n()
  const fileInput = useRef<HTMLInputElement>(null)
  const [source, setSource] = useState<Source>('database')
  const [dragging, setDragging] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [language, setLanguage] = useState<LanguageSupport | null>(null)

  const current = source === 'database' ? input : models
  const change = source === 'database' ? onChange : onModelsChange

  const languageId = source === 'database' ? inputLanguage(input) : modelsLanguage(models)
  useEffect(() => {
    let active = true
    void editorLanguage(languageId).then((loaded) => {
      if (active) setLanguage(loaded)
    })
    return () => {
      active = false
    }
  }, [languageId])

  async function openFile(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      setFileError(t.fileTooLarge(file.name))
      return
    }
    try {
      change({ text: await file.text(), fileName: file.name })
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
  else if (source === 'models') {
    if (!modelsRead) status = <p className="input-status">{t.modelsEmpty}</p>
    else if (!modelsRead.ok)
      status = (
        <p className="input-status input-status--error" role="alert">
          {t.modelsError(modelsRead.error)}
        </p>
      )
    else
      status = (
        <p className="input-status input-status--ok">
          {modelsRead.project
            ? t.mapperSummary(modelsRead.project.source.model, modelsRead.project.target.model)
            : t.modelsSummary(modelsRead.format, modelsRead.schema.models.length)}
        </p>
      )
  } else if (!read) status = <p className="input-status">{t.inputEmpty}</p>
  else if (!read.ok)
    status = (
      <p className="input-status input-status--error" role="alert">
        {t.readError(read.error, read.path)}
      </p>
    )
  else
    status = (
      <p className="input-status input-status--ok">
        {t.databaseSummary(sourceLabel(read.schema), read.schema.dialect, read.schema.tables.length, columnCount(read.schema))}
        {read.schema.notes.length > 0 && (
          <span className="input-status__warnings" title={read.schema.notes.map((note) => note.code).join('\n')}>
            {' · '}
            {t.warningsCount(read.schema.notes.length)}
          </span>
        )}
      </p>
    )

  const select = (next: Source) => {
    setSource(next)
    setFileError(null)
  }

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
            <button type="button" className="button" onClick={() => change({ text: '' })} disabled={current.text === ''}>
              {t.clear}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={source === 'database' ? DATABASE_EXTENSIONS : MODEL_EXTENSIONS}
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
        <div
          className="input-tabs"
          role="tablist"
          aria-label={t.inputSourcesLabel}
          onKeyDown={(event) => onTabListKeyDown(event, (index) => select(SOURCES[index]))}
        >
          {SOURCES.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`input-tab-${id}`}
              aria-selected={source === id}
              aria-controls="input-editor"
              tabIndex={source === id ? 0 : -1}
              className={source === id ? 'input-tabs__tab input-tabs__tab--active' : 'input-tabs__tab'}
              onClick={() => select(id)}
            >
              {t.inputSources[id]}
              {id === 'models' && modelsRead?.ok && <span className="input-tabs__count">{modelsRead.schema.models.length}</span>}
            </button>
          ))}
        </div>
        <div className="database-pane__editor" id="input-editor" role="tabpanel" aria-labelledby={`input-tab-${source}`}>
          <CodeEditor
            value={current.text}
            onChange={(text) => {
              setFileError(null)
              change({ text })
            }}
            language={language}
            label={source === 'database' ? t.inputLabel : t.modelsLabel}
            placeholder={source === 'database' ? t.inputPlaceholder : t.modelsPlaceholder}
          />
          {dragging && <div className="database-pane__drop">{t.dropFile}</div>}
        </div>
      </Pane>
    </div>
  )
}
