/**
 * The work kept in this browser when the user asks for it ("Remember in this browser", off by default):
 * never sent anywhere, and dropped as soon as the option is turned off.
 */
import { readProject, type Model2ApiProject } from '../core/project/project.ts'
import type { InputState } from './workspace.ts'

export const WORKSPACE_KEY = 'model2api.workspace'
export const REMEMBER_KEY = 'model2api.remember'

/** The project kept in this browser, only while "Remember in this browser" is on. */
export function loadSaved(storage: Pick<Storage, 'getItem'>): Model2ApiProject | null {
  try {
    if (JSON.parse(storage.getItem(REMEMBER_KEY) ?? 'false') !== true) return null
    const raw = storage.getItem(WORKSPACE_KEY)
    if (!raw) return null
    const read = readProject(raw)
    return read.ok ? read.project : null
  } catch {
    // Unavailable or damaged storage: start empty
    return null
  }
}

export function inputOfProject(project: Model2ApiProject): InputState {
  const { format, text, fileName } = project.input
  return { text, format, ...(fileName ? { fileName } : {}) }
}
