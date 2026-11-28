/**
 * Holds the interface language: detects it on startup, keeps `<html lang>` in sync and stores the user's
 * choice under the site-wide key, so the website and the other tools follow it. A change of language fades as a
 * change of page does (personal_web_style patterns/fade-in.md).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { detectLanguage, SITE_LANGUAGE_KEY } from './detectLanguage.ts'
import { I18nContext } from './I18nContext.ts'
import { messages, type Language } from './messages.ts'

/** Provides the language and its texts to everything inside it. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() =>
    detectLanguage(() => localStorage.getItem(SITE_LANGUAGE_KEY), navigator.language),
  )

  useEffect(() => {
    document.documentElement.lang = language
    try {
      localStorage.setItem(SITE_LANGUAGE_KEY, language)
    } catch {
      // Not critical: the choice just won't be remembered
    }
  }, [language])

  // The new language is applied inside the transition, so the browser captures the texts already changed; without
  // support or with reduced motion, it changes at once
  const switchLanguage = useCallback((next: Language) => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!document.startViewTransition || reduceMotion) {
      setLanguage(next)
      return
    }
    document.startViewTransition(() => flushSync(() => setLanguage(next)))
  }, [])

  return <I18nContext.Provider value={{ language, setLanguage: switchLanguage, t: messages[language] }}>{children}</I18nContext.Provider>
}
