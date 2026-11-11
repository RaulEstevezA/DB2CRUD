/**
 * Language switcher of the header: one button per language, the current one pressed.
 */
import { languages } from '../../i18n/messages.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import './LanguageSwitcher.css'

/** `EN` `ES` buttons; choosing one changes the language of the whole site. */
export function LanguageSwitcher() {
  const { language, setLanguage, t } = useI18n()

  return (
    <div className="language-switcher" role="group" aria-label={t.languageLabel}>
      {languages.map((code) => (
        <button
          key={code}
          type="button"
          className="language-switcher__option"
          aria-pressed={code === language}
          onClick={() => setLanguage(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
