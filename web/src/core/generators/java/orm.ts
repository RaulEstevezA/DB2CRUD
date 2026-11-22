/**
 * What changes from one way of reaching the database to another in a Java project (Strategy pattern): JPA with
 * Hibernate, or SQL through JDBC. The data source and the entities, the database class of each repository, the
 * database unit of work, how the tests open their database, and the dependencies. Everything else (DTOs, services,
 * in-memory repositories, factories, tests, errors, pages) is written once, for both.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { OrmId } from '../../settings/settings.ts'
import type { Line } from '../types.ts'
import type { JavaImports } from './java.ts'
import type { Context, TableInfo } from './context.ts'
import type { Method } from './repositories.ts'

export interface JavaOrm {
  id: OrmId
  /** What holds the transaction in the caller's hands, for texts: `EntityManager`, `Connection` */
  holder: string
  /** `Database` and what else the data source needs */
  databaseFiles(context: Context): GeneratedFile[]
  /** The entity of a table */
  entityFile(context: Context, info: TableInfo): GeneratedFile
  /** The database repository of a table */
  repository: {
    doc(context: Context, info: TableInfo): string
    /** Its fields and constructor */
    head(context: Context, info: TableInfo, imports: JavaImports): Line[]
    body(context: Context, info: TableInfo, method: Method, imports: JavaImports): Line[]
    /** Members after the methods: helpers */
    tail(context: Context, info: TableInfo, imports: JavaImports): Line[]
  }
  /** The class SqlUnitOfWork, given the accessors of its repositories */
  unitOfWork(context: Context, imports: JavaImports, accessors: string[]): string[]
  /** TestDatabase, which opens the test database empty, and the test that proves which database ran */
  testDatabaseFiles(context: Context): GeneratedFile[]
  /** The fields and the @BeforeEach and @AfterEach of a test class that runs on the test database */
  testSession(context: Context, imports: JavaImports): Line[]
  /** The dependencies of pom.xml besides JUnit */
  dependencies(context: Context): (Line | Line[])[]
  readme: {
    /** What the project is made of, after "for a database that already exists: " */
    intro: string
    /** The line of the layout for Database.java and its neighbours */
    layout(context: Context): string[]
    /** The note on connections at the end */
    note: string
  }
}
