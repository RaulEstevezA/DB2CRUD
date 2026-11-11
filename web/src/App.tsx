/**
 * Root component: holds the state of the screen (the input, the design, the settings and the project
 * actions) and composes the panes. It holds no domain rules; those live in `core/`, and the interface
 * logic in `app/`.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { downloadBlob } from './app/download.ts'
import { REMEMBER_KEY, WORKSPACE_KEY, inputOfProject, loadSaved } from './app/project.ts'
import { EMPTY_INPUT, readInput, type InputState } from './app/workspace.ts'
import type { WorkspacePart } from './app/workspaceParts.ts'
import { AppFooter } from './components/layout/AppFooter.tsx'
import { AppHeader } from './components/layout/AppHeader.tsx'
import { IntroPanel } from './components/layout/IntroPanel.tsx'
import { LinksPanel } from './components/layout/LinksPanel.tsx'
import { ProjectBar } from './components/layout/ProjectBar.tsx'
import { Workspace } from './components/layout/Workspace.tsx'
import { ModelsPane } from './components/models/ModelsPane.tsx'
import { EndpointsPane } from './components/endpoints/EndpointsPane.tsx'
import { ProjectPane } from './components/project/ProjectPane.tsx'
import { resolveApi } from './core/api/spec.ts'
import { pendingDecisions } from './core/design/edit.ts'
import { generateProject } from './core/generators/registry.ts'
import { createProject, projectFileName, readProject, type Model2ApiProject } from './core/project/project.ts'
import { findExample, type ExampleId } from './examples/index.ts'
import { useApiDesign } from './hooks/useApiDesign.ts'
import { useProjectSettings } from './hooks/useProjectSettings.ts'
import { useStoredState } from './hooks/useStoredState.ts'
import { useUndoShortcuts } from './hooks/useUndoShortcuts.ts'
import { useI18n } from './i18n/useI18n.ts'
import './App.css'

type Message = { text: string; kind: 'ok' | 'error' } | null

/** What the page opens with: the work kept in this browser when the user asked for it, or nothing. */
function startup(): Model2ApiProject | null {
  return typeof localStorage === 'undefined' ? null : loadSaved(localStorage)
}

/** The whole tool, in a single screen (personal_web_style `layouts/tool-page.md`). */
function App() {
  const { t } = useI18n()
  const [saved] = useState(startup)
  const [input, setInput] = useState<InputState>(() => (saved ? inputOfProject(saved) : EMPTY_INPUT))
  const [part, setPart] = useState<WorkspacePart>(saved ? 'endpoints' : 'models')
  const [message, setMessage] = useState<Message>(() => (saved ? { text: t.restored, kind: 'ok' } : null))
  // A preference; the work itself is only kept while it is on
  const [remember, setRemember] = useStoredState(REMEMBER_KEY, () => false)
  const [hasSaved, setHasSaved] = useState(saved !== null)

  // Large inputs are read after the keystroke is painted, so typing stays smooth
  const deferredInput = useDeferredValue(input)
  const read = useMemo(() => readInput(deferredInput), [deferredInput])
  const inputError = input.text.trim() !== '' && (!read.format || (read.outcome !== null && !read.outcome.ok))
  const schema = read.outcome?.ok ? read.outcome.schema : null

  const [settings, updateSettings] = useProjectSettings()
  const designState = useApiDesign(schema, saved?.design ?? null)
  const { design } = designState
  useUndoShortcuts(designState.history)
  const spec = useMemo(() => (schema && design ? resolveApi(schema, design, settings) : null), [schema, design, settings])
  const pending = design ? pendingDecisions(design).length : 0
  const files = useMemo(() => (spec ? generateProject(spec, settings) : []), [spec, settings])
  const hasWork = input.text.trim() !== ''

  // Settings kept in a restored project win over the stored preference, once
  useEffect(() => {
    if (saved) updateSettings(saved.settings)
  }, [saved, updateSettings])

  const currentProject = useCallback(
    () =>
      hasWork ? createProject({ text: input.text, format: read.format ?? input.format, fileName: input.fileName }, design, settings) : null,
    [hasWork, input, read.format, design, settings],
  )

  // The browser's copy of the work, kept up to date while "Remember in this browser" is on
  useEffect(() => {
    if (!remember) return
    const timer = setTimeout(() => {
      const project = currentProject()
      if (!project) return
      try {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(project))
        setHasSaved(true)
      } catch {
        // Full or blocked storage: the work is simply not kept
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [remember, currentProject])

  function replaceWork(next: InputState): boolean {
    if (hasWork && !window.confirm(t.confirmReplace)) return false
    // Different models: the decisions made on the previous ones do not apply
    designState.load(null)
    setInput(next)
    setMessage(null)
    return true
  }

  function loadExample(id: ExampleId) {
    const example = findExample(id)
    if (!example || !replaceWork({ text: example.text, format: example.format })) return
    updateSettings({ name: example.project })
    setPart('endpoints')
  }

  async function openProject(file: File) {
    try {
      const opened = readProject(await file.text())
      if (!opened.ok) {
        setMessage({ text: t.projectError(opened.error), kind: 'error' })
        return
      }
      if (hasWork && !window.confirm(t.confirmReplace)) return
      designState.load(opened.project.design)
      setInput(inputOfProject(opened.project))
      updateSettings(opened.project.settings)
      setMessage({ text: t.projectLoaded(file.name), kind: 'ok' })
      setPart('endpoints')
    } catch {
      setMessage({ text: t.fileError(file.name), kind: 'error' })
    }
  }

  function saveProject() {
    const project = currentProject()
    if (project) downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), projectFileName(settings))
  }

  function changeRemember(next: boolean) {
    setRemember(next)
    if (!next) clearSaved(false)
  }

  function clearSaved(announce = true) {
    try {
      localStorage.removeItem(WORKSPACE_KEY)
    } catch {
      // Nothing to delete
    }
    setHasSaved(false)
    if (announce) {
      setRemember(false)
      setMessage({ text: t.savedCleared, kind: 'ok' })
    }
  }

  function changeInput(next: InputState) {
    // Clearing the input starts over: the decisions made on the previous models are discarded too
    if (next.text.trim() === '') designState.load(null)
    setInput(next)
  }

  return (
    <div className="app">
      <AppHeader />
      <main className="app__main">
        <IntroPanel onExample={loadExample} />
        <ProjectBar
          canSave={hasWork}
          remember={remember}
          hasSaved={hasSaved}
          message={message}
          onSave={saveProject}
          onOpen={(file) => void openProject(file)}
          onRememberChange={changeRemember}
          onClearSaved={() => clearSaved()}
        />
        <Workspace
          part={part}
          errors={{ models: inputError }}
          counts={{ endpoints: pending + (spec?.issues.filter((issue) => issue.severity === 'error').length ?? 0) }}
          panes={{
            models: <ModelsPane input={input} read={read} onChange={changeInput} />,
            endpoints: (
              <EndpointsPane schema={schema} design={design} settings={settings} issues={spec?.issues ?? []} state={designState} />
            ),
            project: <ProjectPane spec={spec} settings={settings} files={files} onSettingsChange={updateSettings} />,
          }}
        />
        <LinksPanel />
      </main>
      <AppFooter />
    </div>
  )
}

export default App
