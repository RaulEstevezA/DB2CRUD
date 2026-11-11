/**
 * Chooses the interface language when the tool opens.
 *
 * The website, the tools, the demos and the games share a single language, stored under one key
 * (personal_web_style DECISIONS.md, "Clave del idioma guardado").
 */
import { languages, type Language } from './messages.ts'

/** The one language of the whole website: portfolio, tools, demos and games share this key. */
export const SITE_LANGUAGE_KEY = 'lang'

function isLanguage(value: unknown): value is Language {
  return languages.includes(value as Language)
}

/**
 * Picks the inherited language first, then the browser's, then English.
 *
 * @param readInherited Reads the language stored by the website; it may throw if storage is blocked.
 * @param browserLanguage The browser's language tag, such as `es-ES`.
 * @returns A language the interface has.
 */
export function detectLanguage(readInherited: () => string | null, browserLanguage: string): Language {
  try {
    const inherited = readInherited()
    if (isLanguage(inherited)) return inherited
  } catch {
    // Storage may be unavailable (private mode, blocked cookies): fall back to the browser
  }
  const browser = browserLanguage.slice(0, 2)
  return isLanguage(browser) ? browser : 'en'
}
