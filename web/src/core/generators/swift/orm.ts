/**
 * What changes from one way of reaching the database to another in a Swift project (Strategy pattern): Fluent, or SQL
 * through SQLKit. The database and the entities, the database type of each repository, the transaction of the unit of work,
 * how the tests open their database, and the packages. Everything else (DTOs, services, in-memory repositories, factories,
 * tests, errors, pages) is written once, for both.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { OrmId } from '../../settings/settings.ts'
import type { Context, TableInfo } from './context.ts'
import type { Method } from './repositories.ts'

export interface SwiftOrm {
  id: OrmId
  /** What reaches the database, for texts: `Fluent` */
  label: string
  /** What repositories and the unit of work take, which holds the transaction: its type, as an optional, and its module */
  holder: { type: string; optional: string; modules: string[] }
  /** A list without items as the entities keep it, as a Swift expression */
  emptyList(context: Context): string
  /** `AppDatabase.swift` */
  databaseFile(context: Context): GeneratedFile
  /** The entity of a table, and what maps it */
  entityFiles(context: Context, info: TableInfo): GeneratedFile[]
  /** The database repository of a table, which reaches it through `database` */
  repository: {
    modules(context: Context, info: TableInfo): string[]
    body(context: Context, info: TableInfo, method: Method): string[]
    /** The pattern of a refusal of the database, after `catch` */
    refusal: string
    /** The functions after the type: how a row becomes an entity */
    functions(context: Context, info: TableInfo): string[]
  }
  /** The body of transaction() when every service operation has its transaction */
  transaction: string
  /** How the tests open the database, create it again and ask for its name */
  testDatabase(context: Context): {
    modules: string[]
    open: string[]
    recreate: string[]
    check: string
  }
  /** The lines of Package.swift: the packages, and the products the library and its tests use */
  packages(context: Context): { packages: string[]; products: string[]; testProducts: string[] }
  readme: {
    /** What the project is made of, after "for a database that already exists: " */
    intro: string
    /** The lines of the layout per layer and per table */
    entities: string
    table: string
  }
}
