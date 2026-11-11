/**
 * Project pane: the stack of the generated project, the tree of generated
 * files with a viewer, and the ways to take them: copy, download one file, the OpenAPI contract or the
 * whole project as a .zip. Everything is written in the browser.
 */
import type { LanguageSupport } from '@codemirror/language'
import { useEffect, useState } from 'react'
import { downloadBlob } from '../../app/download.ts'
import type { ApiSpec } from '../../core/api/spec.ts'
import {
  FRAMEWORKS,
  databasesFor,
  findFramework,
  type ArchitectureId,
  type AuthId,
  type DatabaseId,
  type FrameworkId,
  type PersistenceId,
  type ProjectSettings,
} from '../../core/compatibility/stack.ts'
import { createZip } from '../../core/export/zip.ts'
import type { GeneratedFile } from '../../core/generators/common/types.ts'
import { findGenerator } from '../../core/generators/registry.ts'
import { useCopy } from '../../hooks/useCopy.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { CodeEditor } from '../common/CodeEditor.tsx'
import { CommitInput } from '../common/CommitInput.tsx'
import { editorLanguage, languageOfFile } from '../common/editorLanguages.ts'
import { Pane } from '../common/Pane.tsx'
import { FileTree } from './FileTree.tsx'
import './ProjectPane.css'

export interface ProjectPaneProps {
  spec: ApiSpec | null
  settings: ProjectSettings
  files: GeneratedFile[]
  onSettingsChange: (change: Partial<ProjectSettings>) => void
}

export function ProjectPane({ spec, settings, files, onSettingsChange }: ProjectPaneProps) {
  const { t } = useI18n()
  const [chosen, setChosen] = useState<string | null>(null)
  const [language, setLanguage] = useState<LanguageSupport | null>(null)
  const { copied, copy } = useCopy()
  const framework = findFramework(settings.framework)
  const databases = databasesFor(settings.framework, settings.persistence)
  // The chosen file while it exists; the README otherwise, so the pane always shows something useful
  const file = files.find((item) => item.path === chosen) ?? files.find((item) => item.path === 'README.md') ?? files[0] ?? null
  const todos = files.reduce((total, item) => total + (item.content.match(/\bTODO\b/g)?.length ?? 0), 0)
  const generator = findGenerator(settings.framework)

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
    downloadBlob(new Blob([archive], { type: 'application/zip' }), `${settings.name}-${settings.framework}.zip`)
  }

  function downloadFile(item: GeneratedFile) {
    downloadBlob(new Blob([item.content], { type: 'text/plain;charset=utf-8' }), item.path.split('/').pop() ?? item.path)
  }

  const openApi = files.find((item) => item.path === 'openapi.yaml')

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
            <button type="button" className="button" disabled={!openApi} onClick={() => openApi && downloadFile(openApi)}>
              {t.downloadOpenApi}
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
            <span>{t.frameworkLabel}</span>
            <select
              className="select"
              value={settings.framework}
              onChange={(event) => onSettingsChange({ framework: event.target.value as FrameworkId })}
            >
              {FRAMEWORKS.map((item) => (
                <option key={item.id} value={item.id} disabled={!findGenerator(item.id)}>
                  {findGenerator(item.id) ? `${item.label} · ${t.languages[item.language]}` : t.notWrittenYet(item.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t.architectureLabel}</span>
            <select
              className="select"
              value={settings.architecture}
              onChange={(event) => onSettingsChange({ architecture: event.target.value as ArchitectureId })}
            >
              {framework.architectures.map((item) => (
                <option key={item} value={item}>
                  {t.architectures[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t.persistenceLabel}</span>
            <select
              className="select"
              value={settings.persistence}
              onChange={(event) => onSettingsChange({ persistence: event.target.value as PersistenceId })}
            >
              {framework.persistence.map((item) => (
                <option key={item.id} value={item.id}>
                  {t.persistence[item.id]}
                </option>
              ))}
            </select>
          </label>
          {databases.length > 0 && (
            <label className="field">
              <span>{t.databaseLabel}</span>
              <select
                className="select"
                value={settings.database ?? ''}
                onChange={(event) => onSettingsChange({ database: event.target.value as DatabaseId })}
              >
                {databases.map((item) => (
                  <option key={item} value={item}>
                    {t.databases[item]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{t.authLabel}</span>
            <select className="select" value={settings.auth} onChange={(event) => onSettingsChange({ auth: event.target.value as AuthId })}>
              {framework.auth.map((item) => (
                <option key={item} value={item}>
                  {t.auth[item]}
                </option>
              ))}
            </select>
          </label>
          {settings.auth !== 'none' && (
            <label className="field">
              <span>{t.defaultAccessLabel}</span>
              <select
                className="select"
                value={settings.defaultAccess}
                onChange={(event) => onSettingsChange({ defaultAccess: event.target.value as ProjectSettings['defaultAccess'] })}
              >
                <option value="authenticated">{t.endpointAccess.authenticated}</option>
                <option value="public">{t.endpointAccess.public}</option>
              </select>
            </label>
          )}
          {(framework.language === 'java' || framework.language === 'kotlin') && (
            <label className="field">
              <span>{t.javaPackageLabel}</span>
              <CommitInput
                className="input input--mono"
                value={settings.javaPackage}
                spellCheck={false}
                onCommit={(javaPackage) => onSettingsChange({ javaPackage })}
              />
            </label>
          )}
        </div>
        {!generator ? (
          <p className="pane-empty">{t.notWrittenYet(framework.label)}</p>
        ) : !spec || files.length === 0 ? (
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
