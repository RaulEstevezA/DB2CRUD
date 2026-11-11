/**
 * Hook that gives a component the current language and its texts.
 */
import { useContext } from 'react'
import { I18nContext, type I18nValue } from './I18nContext.ts'

/**
 * Reads the language context.
 *
 * @returns The current language, its texts and the function that changes it.
 * @throws Error when used outside `<I18nProvider>`.
 */
export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>')
  return value
}
