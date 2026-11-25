/**
 * What changes from one way of reaching the database to another in a Kotlin project (Strategy pattern): Exposed, or SQL
 * through JDBC. The database and the entities, the database class of each repository, the database unit of work, how the
 * tests open their database, and the dependencies. Everything else (DTOs, services, in-memory repositories, factories,
 * tests, errors, pages) is written once, for both.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { OrmId } from '../../settings/settings.ts'
import type { KtImports } from './kotlin.ts'
import type { Context, TableInfo } from './context.ts'
import type { Method } from './repositories.ts'

export interface KotlinOrm {
  id: OrmId
  /** Columns may hold documents and lists of them, as classes of their own; the entities are always the project's */
  documents?: boolean
  /** What the names of the database classes start with, when it is not `Sql`: `MongoUnitOfWork` */
  prefix?: string
  /** The address of the database, when it is not a JDBC URL */
  url?: string
  /** What repositories and the unit of work take, which holds the transaction: its name, its type and what to import */
  holder: { name: string; type: string; ktImport: string; text: string }
  /** A list without items as the entities keep it, as a Kotlin expression */
  emptyList(context: Context): string
  /** `AppDatabase` and what else reaches the database */
  databaseFiles(context: Context): (GeneratedFile | null)[]
  /** The entity of a table, and what maps it */
  entityFiles(context: Context, info: TableInfo): GeneratedFile[]
  /** The database repository of a table */
  repository: {
    /** What every repository imports, besides the entity and the holder */
    imports(context: Context, info: TableInfo): string[]
    doc(context: Context): string
    /** The members before the methods; the holder may be null in a class that can be extended in memory */
    head(context: Context, info: TableInfo): string[]
    /** The name of the property that keeps the holder */
    kept(context: Context): string
    body(context: Context, info: TableInfo, method: Method, imports: KtImports): string[]
    /** Members after the methods: helpers */
    helpers(context: Context, info: TableInfo, imports: KtImports): string[]
  }
  /** The transaction() of the unit of work when every service operation has its transaction */
  transaction(imports: KtImports): string[]
  /** TestDatabase, which opens the test database empty, and the test that proves which database ran */
  testDatabaseFiles(context: Context): GeneratedFile[]
  /** What a test does with the unit of work after opening it, and when it ends */
  openTest(context: Context): string[]
  closeTest: string[]
  /** The dependencies of build.gradle.kts besides kotlin.test and JUnit */
  dependencies(context: Context, driver: string): string[]
  readme: {
    /** What the project is made of, after "for a database that already exists: " */
    intro: string
    /** The lines of the layout for AppDatabase.kt and its neighbours */
    layout: string[]
    /** What is written per table, in the folder of the entities and in the folder of a table */
    entities: string
    table: string
  }
}
