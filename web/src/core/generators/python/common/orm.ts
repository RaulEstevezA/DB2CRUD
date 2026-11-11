/**
 * What changes from one Python ORM to another (Strategy pattern): the database layer and the entities, the
 * bodies of the repositories that reach the database, the unit of work over them, the test fixtures and the
 * dependencies. Everything else of a Python project (DTOs, services, in-memory repositories, factories, the
 * tests of services and repositories, errors, pages) is written once, in common/, for every ORM.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { OrmId } from '../../../settings/settings.ts'
import type { Line } from '../../types.ts'
import type { Imports } from '../python.ts'
import type { Context, TableInfo } from './context.ts'

/** A repository method, with its Python signature, as common/repositories.ts describes it. */
export interface RepositoryMethod {
  query: import('../../../crud/types.ts').QueryDesign
  name: string
  params: { name: string; type: string }[]
  returns: string
  doc: string
}

export interface PythonOrm {
  id: OrmId
  /** `SQLAlchemy 2`, for texts */
  label: string
  /** Connection, settings and entities: every file of the database layer */
  databaseFiles(context: Context): GeneratedFile[]
  /** The database repository of a table: its docstring, the lines of its __init__ and each method's body */
  repository: {
    doc(context: Context, info: TableInfo): string
    init(context: Context, imports: Imports): Line[]
    body(context: Context, info: TableInfo, method: RepositoryMethod, imports: Imports): Line[]
  }
  /** The class SqlUnitOfWork: the database repositories and the transaction of each operation */
  unitOfWork(context: Context, imports: Imports): Line[]
  /** tests/conftest.py, and the test that proves which database the tests ran on */
  conftest(context: Context): GeneratedFile
  databaseTest(context: Context): GeneratedFile
  /** The fixture the repository tests take, as `name: Type` */
  databaseFixture: string
  dependencies(context: Context): string[]
  devDependencies(context: Context): string[]
  /** Lines of [tool.pytest.ini_options] beyond the common ones */
  pytestOptions(context: Context): Line[]
  /** The database URL the project starts with, in .env.example and the README */
  defaultUrl(context: Context): string
  /** Line of the README layout for the database module: `app/db.py   engine, sessions…` */
  layout(context: Context): string[]
}
