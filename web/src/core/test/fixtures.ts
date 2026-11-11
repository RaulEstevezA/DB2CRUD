/**
 * Fixtures shared by the core tests: the built-in examples read, proposed and resolved.
 */
import { EXAMPLES, type ExampleId } from '../../examples/index.ts'
import { type ApiSpec, resolveApi } from '../api/spec.ts'
import type { ApiDesign } from '../api/types.ts'
import { DEFAULT_SETTINGS, normalizeSettings, type ProjectSettings } from '../compatibility/stack.ts'
import { proposeDesign } from '../design/propose.ts'
import { parseInput } from '../importers/registry.ts'
import type { ModelSchema } from '../model/schema.ts'

export interface Fixture {
  schema: ModelSchema
  design: ApiDesign
  settings: ProjectSettings
  spec: ApiSpec
}

/**
 * Reads an example and resolves its proposed design.
 *
 * @param id The example.
 * @param settings Settings that differ from the defaults.
 * @param edit A change to the proposed design before it is resolved.
 */
export function example(id: ExampleId, settings: Partial<ProjectSettings> = {}, edit?: (design: ApiDesign) => ApiDesign): Fixture {
  const found = EXAMPLES.find((item) => item.id === id)!
  const outcome = parseInput(found.text, found.format)
  if (!outcome.ok) throw new Error(`Example ${id} does not parse: ${JSON.stringify(outcome.error)}`)
  const proposed = proposeDesign(outcome.schema)
  const design = edit ? edit(proposed) : proposed
  const resolved = normalizeSettings({ ...DEFAULT_SETTINGS, name: found.project, ...settings })
  return { schema: outcome.schema, design, settings: resolved, spec: resolveApi(outcome.schema, design, resolved) }
}
