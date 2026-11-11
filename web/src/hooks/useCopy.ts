/**
 * Copying a text to the clipboard, with a short confirmation for the button that did it.
 */
import { useEffect, useState } from 'react'

/** Copies a text to the clipboard; `copied` is true for two seconds after it works. If the clipboard is
 * blocked (permissions, insecure context) nothing is shown: the text can still be selected by hand. */
export function useCopy(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Blocked: nothing to do
    }
  }
  return { copied, copy }
}
