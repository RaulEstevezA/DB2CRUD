/**
 * Contract every framework generator fulfils (Strategy pattern): it receives the resolved API and the
 * project settings and returns the files of a project. Generators never see the interface, the browser or
 * the input text; everything they need is in `GeneratorInput`.
 */
import type { ApiSpec } from '../../api/spec.ts'
import type { FrameworkId, ProjectSettings } from '../../compatibility/stack.ts'

/** One file of a generated project, with its path relative to the project folder. */
export interface GeneratedFile {
  path: string
  content: string
}

export interface GeneratorInput {
  spec: ApiSpec
  settings: ProjectSettings
  /** The OpenAPI contract as YAML, written by the registry so every framework ships the same one */
  openApi: string
}

export interface Generator {
  framework: FrameworkId
  /** Address the generated project listens on when it runs locally, for the contract's `servers` */
  serverUrl: string
  generate(input: GeneratorInput): GeneratedFile[]
}
