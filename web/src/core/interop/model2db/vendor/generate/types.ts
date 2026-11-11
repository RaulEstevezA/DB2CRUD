import type { Design, StorageTarget } from '../design/types.ts'
import type { ModelSchema } from '../model/schema.ts'
import { toSnakeCase } from '../model/naming.ts'
import type {
  BuildOptions,
  Dialect,
  DocumentSchema,
  KeyValueSchema,
  NamingOptions,
  Note,
  PhysicalSchema,
  RelationalSchema,
  WideColumnSchema,
} from '../physical/types.ts'

/** Groups of the output selector */
export type OutputGroup = 'relational' | 'document' | 'keyvalue' | 'widecolumn' | 'python' | 'typescript' | 'jvm' | 'csharp' | 'php'

export interface GeneratedFile {
  /** Path inside the download (`models.py`, `migrations/0001_initial.py`) */
  name: string
  content: string
  /** Highlighting used by the result editor (utils/editorLanguages.ts) */
  editorLanguage: string
}

export interface OutputSettings {
  naming: NamingOptions
  strings: BuildOptions['strings']
  /** SQL engine of ORM outputs: types, migrations and connection settings depend on it */
  engine: Dialect
  /** Add the migration that creates the schema, where the output has migrations */
  migrations: boolean
}

export interface WriteContext {
  schema: ModelSchema
  design: Design
  settings: OutputSettings
  /** The model the schema is mainly about: names the files */
  title: string
  /** What the output could not write as the design says, shown with the result */
  note: (note: Note) => void
}

/** What a writer for tables needs: the physical schema of the chosen engine. */
export interface RelationalWriter {
  id: string
  label: string
  group: OutputGroup
  /** Engines the user can choose; plain SQL outputs have their own and no choice */
  engines?: readonly Dialect[]
  /** The output can add a migration (and the option is shown) */
  migrations?: boolean
  write(physical: RelationalSchema, context: WriteContext): GeneratedFile[]
}

/** What a writer for documents needs: the collections and their validators. */
export interface DocumentWriter {
  id: string
  label: string
  group: OutputGroup
  migrations?: boolean
  write(physical: DocumentSchema, context: WriteContext): GeneratedFile[]
}

/** What a writer for keys and values needs: the keys of each stored model. */
export interface KeyValueWriter {
  id: string
  label: string
  group: OutputGroup
  write(physical: KeyValueSchema, context: WriteContext): GeneratedFile[]
}

/** What a writer for Cassandra or ScyllaDB needs: the tables and user-defined types. */
export interface WideColumnWriter {
  id: string
  label: string
  group: OutputGroup
  write(physical: WideColumnSchema, context: WriteContext): GeneratedFile[]
}

/** An entry of the output selector, whatever kind of database it writes for. The interface reads only
 * this; how the physical schema is built is each kind's business (generate/outputs.ts). */
export interface Output {
  id: string
  label: string
  group: OutputGroup
  target: StorageTarget
  engines?: readonly Dialect[]
  migrations?: boolean
  generate(
    schema: ModelSchema,
    design: Design,
    settings: OutputSettings,
    title: string,
  ): { physical: PhysicalSchema; files: GeneratedFile[] }
}

/** Base of file names: the main model in snake_case (`order_line`). */
export function fileBase(title: string): string {
  return toSnakeCase(title) || 'schema'
}
