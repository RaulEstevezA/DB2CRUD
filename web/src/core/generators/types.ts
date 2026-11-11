/**
 * Contract every generator fulfils (Strategy pattern): it receives the physical schema, the reviewed CRUD
 * design and the project settings, and returns the files of a project. Generators never see the interface,
 * the browser or the input text.
 */
import type { CrudDesign } from '../crud/types.ts'
import type { GeneratedFile } from '../export/files.ts'
import type { DbSchema } from '../schema/types.ts'
import type { LanguageId, OrmId, ProjectSettings } from '../settings/settings.ts'

export interface GeneratorInput {
  schema: DbSchema
  design: CrudDesign
  settings: ProjectSettings
}

export interface Generator {
  language: LanguageId
  orm: OrmId
  generate(input: GeneratorInput): GeneratedFile[]
}

/** A line of code, or `false` / `null` / `undefined` for a line that does not apply. */
export type Line = string | false | null | undefined

/** Joins the lines that apply. */
export function lines(...items: (Line | Line[])[]): string {
  return items
    .flat()
    .filter((line): line is string => typeof line === 'string')
    .join('\n')
}

/** Indents every non-empty line of a block. */
export function indent(text: string, spaces = 4): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n')
}
