/**
 * The settings of the generated project, remembered in this browser as a preference (they say nothing
 * about the user's models) and always consistent with the compatibility matrix.
 */
import { useCallback, useMemo } from 'react'
import { DEFAULT_SETTINGS, normalizeSettings, type ProjectSettings } from '../core/compatibility/stack.ts'
import { useStoredState } from './useStoredState.ts'

export const SETTINGS_KEY = 'model2api.settings'

export function useProjectSettings(): [ProjectSettings, (change: Partial<ProjectSettings>) => void] {
  const [stored, setStored] = useStoredState<ProjectSettings>(SETTINGS_KEY, () => DEFAULT_SETTINGS)
  // A stored value from an older version may lack new settings or hold options no longer offered
  const settings = useMemo(() => normalizeSettings({ ...DEFAULT_SETTINGS, ...stored }), [stored])
  const update = useCallback(
    (change: Partial<ProjectSettings>) => setStored((current) => normalizeSettings({ ...DEFAULT_SETTINGS, ...current, ...change })),
    [setStored],
  )
  return [settings, update]
}
