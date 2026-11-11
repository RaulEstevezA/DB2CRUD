/**
 * A text input whose value is applied when the user leaves it or presses Enter, not on every keystroke,
 * so a word typed is one step of the undo history. Escape puts the applied value back.
 */
import { useState, type InputHTMLAttributes } from 'react'

export interface CommitInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'> {
  value: string
  onCommit: (value: string) => void
}

export function CommitInput({ value, onCommit, ...props }: CommitInputProps) {
  const [draft, setDraft] = useState<{ base: string; text: string }>({ base: value, text: value })
  // A new value from outside (undo, another edit) replaces what is being typed
  const text = draft.base === value ? draft.text : value
  const commit = () => {
    if (text !== value) onCommit(text)
  }
  return (
    <input
      {...props}
      value={text}
      onChange={(event) => setDraft({ base: value, text: event.target.value })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setDraft({ base: value, text: value })
      }}
    />
  )
}
