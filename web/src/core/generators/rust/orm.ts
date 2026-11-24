/**
 * What changes from one way of reaching the database to another in a Rust project (Strategy pattern): SeaORM, or SQL
 * through sqlx. The database and the entities, the database struct of each repository, the transactions of the unit of
 * work, how the tests open their database, and the crates. Everything else (DTOs, services, in-memory repositories,
 * factories, tests, errors, pages) is written once, for both.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { OrmId } from '../../settings/settings.ts'
import type { Context, Crate, TableInfo } from './context.ts'
import type { Method } from './repositories.ts'
import type { RsUses } from './rust.ts'

export interface RustOrm {
  id: OrmId
  /** What reaches the database, for texts: `SeaORM` */
  label: string
  /** The error of the database: `sea_orm::DbErr` */
  error: string
  /** A list without items as the entities keep it, as a Rust expression */
  emptyList(context: Context): string
  /** `database.rs` */
  databaseFile(context: Context): GeneratedFile
  /** The entity of a table, and what maps it */
  entityFiles(context: Context, info: TableInfo): GeneratedFile[]
  /** The database repository of a table, over `db: &Db` */
  repository: {
    /** What every repository uses, besides the entity, the errors and Db */
    uses(context: Context, info: TableInfo): string[]
    body(context: Context, info: TableInfo, method: Method, uses: RsUses): string[]
    /** The functions after the struct: how rows become entities, and how a refusal becomes a Conflict */
    helpers(context: Context, info: TableInfo, methods: Method[], uses: RsUses): string[]
  }
  /** How the unit of work opens and commits transactions */
  unitOfWork(context: Context): {
    uses: string[]
    /** The functions of `impl SqlUnitOfWork` */
    constructors: string[]
    /** The body of begin() and of commit() */
    begin: string[]
    commit: string[]
  }
  /** tests/data/database.rs, which opens the test database empty and proves which database ran */
  testDatabaseFile(context: Context): GeneratedFile
  /** The lines of Cargo.toml for the database, with the crates of the column types in use */
  dependencies(context: Context, crates: Set<Crate>): string[]
  readme: {
    /** What the project is made of, after "for a database that already exists: " */
    intro: string
    /** The lines of the layout per layer and per table */
    entities: string
    table: string
    /** What the folder of the entities holds */
    folder: string
  }
}
