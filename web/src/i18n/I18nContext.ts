/**
 * React context that carries the current language and its texts to every component.
 */
import { createContext } from 'react'
import type { Language, Messages } from './messages.ts'

/** What components receive from the context. */
export interface I18nValue {
  /** The current language. */
  language: Language
  /** Changes the language of the whole site. */
  setLanguage: (language: Language) => void
  /** The texts in the current language. */
  t: Messages
}

/** Empty outside `<I18nProvider>`, so a missing provider is detected by `useI18n`. */
export const I18nContext = createContext<I18nValue | null>(null)
