/**
 * Project pane: every setting of the generated project (docs/design.md, section 4), only with the options
 * the chosen stack offers; whether that stack is verified; the tree of generated files with a viewer; and the
 * ways to take them: copy, download one file or the whole project as a .zip. Everything is written in the
 * browser.
 */
import type { LanguageSupport } from '@codemirror/language'
import { useEffect, useState, type ReactNode } from 'react'
import { downloadBlob } from '../../app/download.ts'
import type { GeneratedFile } from '../../core/export/files.ts'
import { createZip } from '../../core/export/zip.ts'
import { findStack, STACKS, type ProjectSettings } from '../../core/settings/settings.ts'
import { isVerified } from '../../core/settings/verified.ts'
import { useCopy } from '../../hooks/useCopy.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { CodeEditor } from '../common/CodeEditor.tsx'
import { CommitInput } from '../common/CommitInput.tsx'
import { editorLanguage, languageOfFile } from '../common/editorLanguages.ts'
import { Pane } from '../common/Pane.tsx'
import { FileTree } from './FileTree.tsx'
import './ProjectPane.css'

export interface ProjectPaneProps {
  settings: ProjectSettings
  files: GeneratedFile[]
  onSettingsChange: (change: Partial<ProjectSettings>) => void
}

export function ProjectPane({ settings, files, onSettingsChange }: ProjectPaneProps) {
  const { t } = useI18n()
  const [chosen, setChosen] = useState<string | null>(null)
  const [language, setLanguage] = useState<LanguageSupport | null>(null)
  const { copied, copy } = useCopy()
  const stack = findStack(settings.language, settings.orm) ?? STACKS[0]
  // The chosen file while it exists; the README otherwise, so the pane always shows something useful
  const file = files.find((item) => item.path === chosen) ?? files.find((item) => item.path === 'README.md') ?? files[0] ?? null
  const todos = files.reduce((total, item) => total + (item.content.match(/\bTODO\b/g)?.length ?? 0), 0)
  const verified = isVerified(settings)

  useEffect(() => {
    let active = true
    void editorLanguage(file ? languageOfFile(file.path) : 'text').then((loaded) => {
      if (active) setLanguage(loaded)
    })
    return () => {
      active = false
    }
  }, [file])

  function downloadZip() {
    const archive = createZip(files.map((item) => ({ name: `${settings.name}/${item.path}`, content: item.content })))
    downloadBlob(new Blob([archive], { type: 'application/zip' }), `${settings.name}.zip`)
  }

  function downloadFile(item: GeneratedFile) {
    downloadBlob(new Blob([item.content], { type: 'text/plain;charset=utf-8' }), item.path.split('/').pop() ?? item.path)
  }

  /** A select of one setting, with the label of each option. */
  function choice<K extends keyof ProjectSettings>(
    key: K,
    label: string,
    options: readonly ProjectSettings[K][],
    text: (value: ProjectSettings[K]) => string,
  ): ReactNode {
    return (
      <label className="field">
        <span>{label}</span>
        <select
          className="select"
          value={String(settings[key])}
          onChange={(event) => onSettingsChange({ [key]: parse(options, event.target.value) } as Partial<ProjectSettings>)}
        >
          {options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {text(option)}
            </option>
          ))}
        </select>
      </label>
    )
  }

  return (
    <Pane
      title={t.workspaceParts.project}
      footer={
        <div className="project__footer">
          <p className="project__file">
            {file ? <span className="mono">{file.path}</span> : <span>{t.projectEmpty}</span>}
            {files.length > 0 && todos > 0 && <span className="project__todos"> · {t.todoCount(todos)}</span>}
          </p>
          <div className="actions">
            <button type="button" className="button" disabled={!file} onClick={() => file && void copy(file.content)}>
              {copied ? t.copied : t.copy}
            </button>
            <button type="button" className="button" disabled={!file} onClick={() => file && downloadFile(file)}>
              {t.downloadFile}
            </button>
            <button type="button" className="button button--primary" disabled={files.length === 0} onClick={downloadZip}>
              {t.downloadZip(files.length)}
            </button>
          </div>
        </div>
      }
    >
      <div className="project">
        <div className="project__settings">
          <label className="field">
            <span>{t.projectName}</span>
            <CommitInput
              className="input input--mono"
              value={settings.name}
              spellCheck={false}
              onCommit={(name) => onSettingsChange({ name })}
            />
          </label>
          <label className="field">
            <span>{t.stackLabel}</span>
            <select
              className="select"
              value={`${settings.language}:${settings.orm}`}
              onChange={(event) => {
                const [language, orm] = event.target.value.split(':')
                onSettingsChange({ language, orm } as Partial<ProjectSettings>)
              }}
            >
              {STACKS.map((item) => (
                <option key={`${item.language}:${item.orm}`} value={`${item.language}:${item.orm}`}>
                  {`${t.languages[item.language]} · ${item.label}`}
                </option>
              ))}
            </select>
          </label>
          {choice('database', t.databaseLabel, stack.databases, (value) => t.databases[value])}
          {choice('execution', t.executionLabel, stack.execution, (value) => t.executions[value])}
          {choice('entities', t.entitiesLabel, ['missing', 'all', 'none'], (value) => t.entitiesModes[value])}
          {settings.entities !== 'all' && (
            <label className="field">
              <span>{t.entitiesModuleLabel}</span>
              <CommitInput
                className="input input--mono"
                value={settings.entitiesModule}
                spellCheck={false}
                onCommit={(entitiesModule) => onSettingsChange({ entitiesModule })}
              />
            </label>
          )}
          {choice('services', t.servicesLabel, [true, false], (value) => (value ? t.yes : t.no))}
          {settings.services && choice('serviceTypes', t.serviceTypesLabel, ['entities', 'dtos'], (value) => t.serviceTypes[value])}
          {settings.services &&
            settings.serviceTypes === 'dtos' &&
            choice('dtoKind', t.dtoKindLabel, stack.dtoKinds, (value) => t.dtoKinds[value])}
          {settings.services &&
            stack.updates.length > 1 &&
            choice('updates', t.updatesLabel, stack.updates, (value) => t.updatesModes[value])}
          {choice('transactions', t.transactionsLabel, ['operation', 'caller', 'repository'], (value) => t.transactions[value])}
          {stack.errors.length > 1 && choice('errors', t.errorsLabel, stack.errors, (value) => t.errorStyles[value])}
          {choice('paging', t.pagingLabel, ['offset', 'cursor', 'none'], (value) => t.pagings[value])}
          {choice('architecture', t.architectureLabel, ['layer', 'table'], (value) => t.architectures[value])}
          {choice('verbs', t.verbsLabel, ['getFind', 'get', 'find'], (value) => t.verbs[value])}
          {choice('repositoryInterfaces', t.interfacesLabel, [true, false], (value) => (value ? t.yes : t.no))}
          {choice('memoryRepositories', t.memoryLabel, [true, false], (value) => (value ? t.yes : t.no))}
          {choice(
            'tests',
            t.testsLabel,
            settings.services ? ['all', 'services', 'repositories', 'none'] : ['repositories', 'none'],
            (value) => t.testsModes[value],
          )}
        </div>
        <p className={verified ? 'project__verified project__verified--ok' : 'project__verified'}>
          {verified ? t.stackVerified : t.stackNotVerified}
        </p>
        {files.length === 0 ? (
          <p className="pane-empty">{t.projectEmpty}</p>
        ) : (
          <div className="project__browser">
            <FileTree files={files} selected={file?.path ?? null} onSelect={setChosen} />
            <div className="project__viewer">
              <CodeEditor value={file?.content ?? ''} language={language} readOnly label={t.fileLabel(file?.path ?? '')} />
            </div>
          </div>
        )}
      </div>
    </Pane>
  )
}

/** The option a select's value stands for (booleans and strings both travel as text). */
function parse<T>(options: readonly T[], value: string): T {
  return options.find((option) => String(option) === value) ?? options[0]
}
