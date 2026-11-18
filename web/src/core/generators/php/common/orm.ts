/**
 * What changes from one PHP ORM to another (Strategy pattern): how an entity names and types its properties, the
 * entities themselves and the connection, the bodies of the repositories that reach the database, the unit of work
 * over them, how the tests open the database, and the packages. Everything else (DTOs, services, in-memory
 * repositories, factories, tests, errors, pages) is written once, in common/, for every ORM.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbColumn, DbType } from '../../../schema/types.ts'
import type { OrmId } from '../../../settings/settings.ts'
import type { Line } from '../../types.ts'
import type { Context, TableInfo } from './context.ts'
import type { PhpUses } from './php.ts'
import type { RepositoryMethod } from './repositories.ts'

export interface PhpOrm {
  id: OrmId
  /** `Doctrine ORM 3`, for texts */
  label: string
  /** The property of the entity that holds a column: `passwordHash`, or the column itself for Eloquent's attributes */
  property(column: DbColumn): string
  /** The PHP type of a value of the column, without null: `int`, `string`, `\DateTimeImmutable` */
  phpType(type: DbType): string
  /** The entity of a table */
  entityFile(context: Context, info: TableInfo): GeneratedFile
  /** `Database.php` and any other file the connection needs */
  databaseFiles(context: Context): GeneratedFile[]
  repository: {
    /** What the database repository says it does, after `Keeps <table> rows in the database` */
    doc(context: Context): string
    /** Its constructor, or nothing when it needs none */
    init(context: Context, uses: PhpUses): Line[]
    body(context: Context, info: TableInfo, method: RepositoryMethod, uses: PhpUses): Line[]
    /** Its private methods, after the public ones */
    helpers(context: Context, info: TableInfo, uses: PhpUses): Line[]
  }
  /** The SqlUnitOfWork class: the database repositories and the transaction of each operation */
  unitOfWork(context: Context, uses: PhpUses): Line[]
  /** How the tests forget the rows the ORM keeps, so the next read goes to the database (or null) */
  forget(uow: string): string | null
  /** How a test opens the transaction of the caller on the test database */
  begin(uow: string): string
  /** How a test closes the test database */
  close(uow: string): string
  /** tests/TestDatabase.php, whose `open()` returns the SqlUnitOfWork of the test database (TEST_DATABASE_URL, or SQLite
   * in memory) with every table dropped and created again; and the test that proves which database ran */
  testDatabase(context: Context): GeneratedFile[]
  require(context: Context): Record<string, string>
  defaultUrl(context: Context): string
  /** Lines of the README layout for the entities and the connection */
  layout(context: Context): string[]
}
