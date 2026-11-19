/**
 * What a reader of ORM code is: it says how likely some files are code of its ORM, and reads them into the
 * physical schema (`db-schema`). Each ORM has its own reader (Strategy pattern); the registry chooses one.
 */
import type { DbSchema } from '../../schema/types.ts'

/** One file of the input: several when the ORM writes a class per file (JPA, Doctrine, Eloquent). */
export interface SourceFile {
  name: string
  text: string
}

export interface OrmReader {
  /** The ORM, as the settings name it: `sqlalchemy` */
  id: string
  label: string
  /** The language of the code, for the editor's highlighting: `python` */
  language: string
  /** How likely these files are code of this ORM, from 0 to 1 */
  detect(files: SourceFile[]): number
  /** The tables the code declares; what it does not understand goes to the notes */
  read(files: SourceFile[]): DbSchema
}
