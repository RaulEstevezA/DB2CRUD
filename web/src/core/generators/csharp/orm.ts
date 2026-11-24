/**
 * What changes from one way of reaching the database to another in a C# project (Strategy pattern): EF Core, or SQL
 * through ADO.NET. The database and the entities, the database class of each repository, the database unit of work, how
 * the tests open their database, and the packages. Everything else (DTOs, services, in-memory repositories, factories,
 * tests, errors, pages) is written once, for both.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { OrmId } from '../../settings/settings.ts'
import type { Line } from '../types.ts'
import type { CsUsings } from './csharp.ts'
import type { Context, TableInfo } from './context.ts'
import type { Method } from './repositories.ts'

export interface CsharpOrm {
  id: OrmId
  /** The class that holds the connection and its transaction, which repositories and the unit of work take: `AppDbContext` */
  holder: string
  /** The statement that makes the tests read again from the database what the unit of work keeps, when it keeps something */
  forget: string | null
  /** A list without items as the entities keep it, as a C# expression */
  emptyList(context: Context): string
  /** `Database` and what else reaches the database */
  databaseFiles(context: Context): (GeneratedFile | null)[]
  /** The entity of a table */
  entityFile(context: Context, info: TableInfo): GeneratedFile
  /** The database repository of a table, a class whose primary constructor takes the holder as `db` */
  repository: {
    /** The namespaces every repository uses, besides the entity's and the project's */
    usings: string[]
    doc(context: Context, info: TableInfo): string
    /** Members before the methods */
    head(context: Context, info: TableInfo): Line[]
    body(context: Context, info: TableInfo, method: Method, usings: CsUsings): Line[]
    /** Members after the methods: helpers */
    tail(context: Context, info: TableInfo, usings: CsUsings): Line[]
  }
  /** The body of TransactionAsync when every service operation has its transaction */
  transaction: string[]
  /** TestDatabase, which opens the test database empty, and the test that proves which database ran */
  testDatabaseFiles(context: Context): GeneratedFile[]
  /** The fields, setup and teardown of a test class over the test database */
  testMembers(context: Context): Line[]
  /** The packages of App.csproj, with their versions */
  packages(context: Context): [string, string][]
  readme: {
    /** What the project is made of, after "for a database that already exists: " */
    intro: string
    /** The lines of the layout for Database.cs and its neighbours */
    layout: string[]
    /** What the tests do to the database they are given */
    reset: string
  }
}
