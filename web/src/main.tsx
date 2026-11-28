/**
 * Entry point of the web version: mounts the application in the page.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installMotion } from './app/motion.ts'
import { I18nProvider } from './i18n/I18nProvider.tsx'

// The collapsible lists animate where the browser cannot do it in CSS
installMotion()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
