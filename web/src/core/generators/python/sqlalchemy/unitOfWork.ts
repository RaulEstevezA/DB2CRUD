/**
 * `app/unit_of_work.py`: what services depend on. It holds a repository per table and, depending on the
 * settings, the transaction of each operation: the SQLAlchemy one over a session, the in-memory one over
 * the memory repositories. Services never see a session.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { lines } from '../../types.ts'
import { Imports } from '../python.ts'
import { memoryRepositoryClass, moduleOf, repositoryClass, sqlRepositoryClass, type Context } from './context.ts'

export function unitOfWorkFile(context: Context): GeneratedFile {
  const imports = new Imports().from('typing', 'Protocol')
  const sessionType = context.async ? 'AsyncSession' : 'Session'
  imports.from(context.async ? 'sqlalchemy.ext.asyncio' : 'sqlalchemy.orm', sessionType)
  const tables = context.tables
  const contextManager = context.async ? 'asynccontextmanager' : 'contextmanager'
  const iterator = context.async ? 'AsyncIterator' : 'Iterator'
  const managerType = context.async ? 'AbstractAsyncContextManager' : 'AbstractContextManager'
  imports.from('contextlib', contextManager, managerType).from('collections.abc', iterator)
  for (const info of tables) {
    const module = moduleOf(context, info, 'repository')
    imports.from(module, sqlRepositoryClass(info))
    if (context.settings.repositoryInterfaces) imports.from(module, repositoryClass(info))
    if (context.settings.memoryRepositories) imports.from(module, memoryRepositoryClass(info))
  }
  const typeOf = (info: (typeof tables)[number]) =>
    context.settings.repositoryInterfaces ? repositoryClass(info) : sqlRepositoryClass(info)
  const a = context.async ? 'await ' : ''
  const def = context.async ? 'async def' : 'def'
  const how = {
    operation: 'Each service operation runs in `transaction()`: committed when it ends, rolled back when it fails.',
    caller: 'Services never commit: whoever holds the session decides when the work is committed.',
    repository: 'Every repository write is committed at once; `transaction()` only groups the code.',
  }[context.settings.transactions]
  const content = lines(
    `"""The repositories of every table, and the transaction of each service operation. ${how}"""`,
    '',
    imports.write('app'),
    '',
    '',
    'class UnitOfWork(Protocol):',
    '    """What services depend on: a repository per table and a transaction."""',
    '',
    ...tables.map((info) => `    ${info.attr}: ${typeOf(info)}`),
    '',
    `    def transaction(self) -> ${managerType}[None]:`,
    '        """Commits what runs inside it, or rolls it back if it fails."""',
    '        ...',
    '',
    '',
    'class SqlUnitOfWork:',
    `    """The repositories over one ${sessionType}."""`,
    '',
    `    def __init__(self, session: ${sessionType}) -> None:`,
    '        self.session = session',
    ...tables.map((info) => `        self.${info.attr} = ${sqlRepositoryClass(info)}(session)`),
    '',
    `    @${contextManager}`,
    `    ${def} transaction(self) -> ${iterator}[None]:`,
    '        """Commits what runs inside it, or rolls it back if it fails."""',
    '        try:',
    '            yield',
    '        except BaseException:',
    `            ${a}self.session.rollback()`,
    '            raise',
    context.settings.transactions === 'operation'
      ? `        ${a}self.session.commit()`
      : '        # The commit belongs to whoever holds the session',
    context.settings.memoryRepositories && [
      '',
      '',
      'class MemoryUnitOfWork:',
      '    """The in-memory repositories, for tests and for trying the services without a database."""',
      '',
      '    def __init__(self) -> None:',
      ...tables.map((info) => `        self.${info.attr} = ${memoryRepositoryClass(info)}()`),
      '',
      `    @${contextManager}`,
      `    ${def} transaction(self) -> ${iterator}[None]:`,
      '        """Memory has no transactions: changes are kept as they are made."""',
      '        yield',
    ],
    '',
  )
  return { path: 'app/unit_of_work.py', content }
}
