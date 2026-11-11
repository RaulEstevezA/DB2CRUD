/**
 * The page: header, presentation, the workspace and the links of the suite. The workspace only has the
 * input for now; the CRUD design and the generated project come back with the new core (ROADMAP).
 */
import { useDeferredValue, useMemo, useState } from 'react'
import { EMPTY_INPUT, readInput, type InputState } from './app/workspace.ts'
import { AppFooter } from './components/layout/AppFooter.tsx'
import { AppHeader } from './components/layout/AppHeader.tsx'
import { IntroPanel } from './components/layout/IntroPanel.tsx'
import { LinksPanel } from './components/layout/LinksPanel.tsx'
import { Workspace } from './components/layout/Workspace.tsx'
import { ModelsPane } from './components/models/ModelsPane.tsx'
import { findExample, type ExampleId } from './examples/index.ts'
import { useI18n } from './i18n/useI18n.ts'
import './App.css'

/** The whole tool, in a single screen (personal_web_style `layouts/tool-page.md`). */
function App() {
  const { t } = useI18n()
  const [input, setInput] = useState<InputState>(EMPTY_INPUT)

  // Large inputs are read after the keystroke is painted, so typing stays smooth
  const deferredInput = useDeferredValue(input)
  const read = useMemo(() => readInput(deferredInput), [deferredInput])
  const inputError = input.text.trim() !== '' && (!read.format || (read.outcome !== null && !read.outcome.ok))
  const hasWork = input.text.trim() !== ''

  function loadExample(id: ExampleId) {
    const example = findExample(id)
    if (!example || (hasWork && !window.confirm(t.confirmReplace))) return
    setInput({ text: example.text, format: example.format })
  }

  return (
    <div className="app">
      <AppHeader />
      <main className="app__main">
        <IntroPanel onExample={loadExample} />
        <Workspace errors={{ models: inputError }} panes={{ models: <ModelsPane input={input} read={read} onChange={setInput} /> }} />
        <LinksPanel />
      </main>
      <AppFooter />
    </div>
  )
}

export default App
