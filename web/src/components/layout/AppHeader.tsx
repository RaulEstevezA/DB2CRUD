/**
 * Header shared by the website and every tool: the name, linking to the website, and the language switcher.
 */
import { LanguageSwitcher } from './LanguageSwitcher.tsx'
import './AppHeader.css'

/** Same navigation bar as the website, so moving between the website and the tool feels seamless. */
export function AppHeader() {
  return (
    <header className="app-header">
      <nav className="app-header__nav">
        <a href="https://raulesteveza.github.io/" className="app-header__logo">
          Raúl Estévez
        </a>
        <LanguageSwitcher />
      </nav>
    </header>
  )
}
