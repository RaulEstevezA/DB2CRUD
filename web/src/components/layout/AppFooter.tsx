/**
 * Footer shared by every tool: license, source code and the website (personal_web_style
 * components/navigation.md, "Footer").
 */
import { SOURCE_URL } from '../../app/links.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import './AppFooter.css'

/** Last line of the page, always at the bottom of the window. */
export function AppFooter() {
  const { t } = useI18n()

  return (
    <footer className="app-footer">
      <span>{t.license}</span>
      <a href={SOURCE_URL} target="_blank" rel="noopener">
        {t.sourceCode}
      </a>
      <a href="https://raulesteveza.github.io/">Raúl Estévez</a>
    </footer>
  )
}
