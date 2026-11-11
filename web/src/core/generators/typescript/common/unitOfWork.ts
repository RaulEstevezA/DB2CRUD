/**
 * `src/unit-of-work.ts`: what services depend on. It holds a repository per table and runs each operation in
 * `transaction(work)`: the database one (written by each ORM) and the in-memory one over the memory
 * repositories. Services never see the ORM.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { TsImports } from '../typescript.ts'
import { memoryRepositoryClass, moduleOf, repositoryInterface, sqlRepositoryClass, type Context } from './context.ts'

const HOW = {
  operation: 'Each service operation runs in `transaction()`: committed when it ends, rolled back when it fails.',
  caller: 'Services never commit: whoever holds the connection decides when the work is committed; `transaction()` only groups the code.',
  repository: 'Every repository write is committed at once; `transaction()` only groups the code.',
}

export function unitOfWorkFile(context: Context): GeneratedFile {
  const imports = new TsImports('src/unit-of-work')
  const interfaces = context.settings.repositoryInterfaces
  for (const info of context.tables) {
    const module = moduleOf(context, info, 'repository')
    imports.from(module, sqlRepositoryClass(info))
    if (interfaces) imports.type(module, repositoryInterface(info))
    if (context.settings.memoryRepositories) imports.from(module, memoryRepositoryClass(info))
  }
  // Without interfaces, the public methods of the database class: the in-memory class has the same ones
  const typeOf = (info: Context['tables'][number]) =>
    interfaces
      ? repositoryInterface(info)
      : context.settings.memoryRepositories
        ? `Pick<${sqlRepositoryClass(info)}, keyof ${sqlRepositoryClass(info)}>`
        : sqlRepositoryClass(info)
  // Written before the imports, which it adds to
  const database = context.orm.unitOfWork(context, imports)
  const content = lines(
    `/** The repositories of every table, and the transaction of each service operation. ${HOW[context.settings.transactions]} */`,
    imports.write(),
    '',
    '/** What services depend on: a repository per table and a transaction. */',
    'export interface UnitOfWork {',
    ...context.tables.map((info) => `  readonly ${info.attr}: ${typeOf(info)}`),
    '  /** Runs `work` with the repositories of the transaction; commits when it ends, rolls back when it throws. */',
    '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>',
    '}',
    '',
    ...database,
    context.settings.memoryRepositories && [
      '',
      '/** The in-memory repositories, for tests and for trying the services without a database. */',
      'export class MemoryUnitOfWork implements UnitOfWork {',
      ...context.tables.map((info) => `  readonly ${info.attr} = new ${memoryRepositoryClass(info)}()`),
      '',
      '  /** Memory has no transactions: changes are kept as they are made. */',
      '  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {',
      '    return work(this)',
      '  }',
      '}',
    ],
    '',
  )
  return { path: 'src/unit-of-work.ts', content }
}
