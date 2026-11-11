/**
 * The page: header, presentation, the workspace (database, CRUD design, project) and the links of the suite.
 */
import { useDeferredValue, useMemo, useState } from 'react'
import { EMPTY_INPUT, readDatabase, type InputState } from './app/workspace.ts'
import type { WorkspacePart } from './app/workspaceParts.ts'
import { DatabasePane } from './components/database/DatabasePane.tsx'
import { DesignPane } from './components/design/DesignPane.tsx'
import { AppFooter } from './components/layout/AppFooter.tsx'
import { AppHeader } from './components/layout/AppHeader.tsx'
import { IntroPanel } from './components/layout/IntroPanel.tsx'
import { LinksPanel } from './components/layout/LinksPanel.tsx'
import { Workspace } from './components/layout/Workspace.tsx'
import { ProjectPane } from './components/project/ProjectPane.tsx'
import { pendingDecisions } from './core/crud/edit.ts'
import { generateProject } from './core/generators/registry.ts'
import { DEFAULT_SETTINGS, normalizeSettings, type ProjectSettings } from './core/settings/settings.ts'
import { findExample, type ExampleId } from './examples/index.ts'
import { useCrudDesign } from './hooks/useCrudDesign.ts'
import { useStoredState } from './hooks/useStoredState.ts'
import { useUndoShortcuts } from './hooks/useUndoShortcuts.ts'
import { useI18n } from './i18n/useI18n.ts'
import './App.css'

/** The whole tool, in a single screen (personal_web_style `layouts/tool-page.md`). */
function App() {
  const { t } = useI18n()
  const [input, setInput] = useState<InputState>(EMPTY_INPUT)
  const [part, setPart] = useState<WorkspacePart>('database')
  // The settings are a preference, kept in this browser; the database never is
  const [stored, setStored] = useStoredState<ProjectSettings>('db2crud.settings', () => DEFAULT_SETTINGS)
  const settings = useMemo(() => normalizeSettings(stored), [stored])

  // Large inputs are read after the keystroke is painted, so typing stays smooth
  const deferredInput = useDeferredValue(input)
  const read = useMemo(() => readDatabase(deferredInput), [deferredInput])
  const schema = read?.ok ? read.schema : null
  const designState = useCrudDesign(schema)
  const { design } = designState
  useUndoShortcuts(designState.history)
  const files = useMemo(() => (schema && design ? generateProject(schema, design, settings) : []), [schema, design, settings])
  const pending = design ? pendingDecisions(design).length : 0
  const hasWork = input.text.trim() !== ''

  function changeSettings(change: Partial<ProjectSettings>) {
    setStored(normalizeSettings({ ...settings, ...change }))
  }

  function replaceInput(next: InputState): boolean {
    if (hasWork && !window.confirm(t.confirmReplace)) return false
    // Another database: the decisions made on the previous one do not apply
    designState.load(null)
    setInput(next)
    return true
  }

  function loadExample(id: ExampleId) {
    const example = findExample(id)
    if (!example || !replaceInput({ text: example.text, fileName: `${example.project}.model2db.json` })) return
    changeSettings({ name: example.project })
    setPart('design')
  }

  function changeInput(next: InputState) {
    // Clearing the input starts over: the decisions made on the previous database are discarded too
    if (next.text.trim() === '') designState.load(null)
    setInput(next)
  }

  return (
    <div className="app">
      <AppHeader />
      <main className="app__main">
        <IntroPanel onExample={loadExample} />
        <Workspace
          part={part}
          errors={{ database: read !== null && !read.ok }}
          counts={{ design: pending }}
          panes={{
            database: <DatabasePane input={input} read={read} onChange={changeInput} />,
            design: <DesignPane state={designState} />,
            project: <ProjectPane settings={settings} files={files} onSettingsChange={changeSettings} />,
          }}
        />
        <LinksPanel />
      </main>
      <AppFooter />
    </div>
  )
}

export default App
