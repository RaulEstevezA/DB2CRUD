/**
 * What changes from one TypeScript ORM to another (Strategy pattern): the data source and the entities, the
 * bodies of the repositories that reach the database, the unit of work over them, how the tests open the
 * database, and the dependencies. Everything else (DTOs, services, in-memory repositories, factories, tests,
 * errors, pages) is written once, in common/, for every ORM.
 */
import type { QueryDesign } from '../../../crud/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import type { OrmId } from '../../../settings/settings.ts'
import type { Line } from '../../types.ts'
import type { TsImports } from '../typescript.ts'
import type { Context, TableInfo } from './context.ts'

export interface RepositoryMethod {
  query: QueryDesign
  name: string
  params: { name: string; type: string }[]
  returns: string
  doc: string
}

export interface TsOrm {
  id: OrmId
  /** `TypeORM 0.3`, for texts */
  label: string
  /** The data source and the entities */
  databaseFiles(context: Context): GeneratedFile[]
  /** The database repository of a table: its doc comment, its fields and constructor, and each method's body */
  repository: {
    doc(context: Context, info: TableInfo): string
    init(context: Context, imports: TsImports): Line[]
    body(context: Context, info: TableInfo, method: RepositoryMethod, imports: TsImports): Line[]
  }
  /** The class SqlUnitOfWork: the database repositories and the transaction of each operation */
  unitOfWork(context: Context, imports: TsImports): Line[]
  /** A condition true while a property of a new entity has no value of its own */
  unset(target: string): string
  /** test/database.ts, whose `useTestDatabase()` opens the test database (TEST_DATABASE_URL, or SQLite in
   * memory) empty for every test and returns its SqlUnitOfWork; and the test that proves which database ran */
  testDatabase(context: Context): GeneratedFile[]
  dependencies(context: Context): Record<string, string>
  devDependencies(context: Context): Record<string, string>
  defaultUrl(context: Context): string
  /** Lines of the README layout for the database module */
  layout(context: Context): string[]
}
