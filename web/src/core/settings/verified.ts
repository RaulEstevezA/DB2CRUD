/**
 * Stacks whose generated projects have been built and whose own tests have passed with their real tools, in
 * Docker (verification/run.sh). The interface shows a stack as verified only when it is listed here.
 *
 * Update this list after running the verification: one entry per database and execution that passed, with the
 * scenarios that proved it and their date.
 */
import type { Dialect } from '../schema/types.ts'
import type { Execution, LanguageId, OrmId } from './settings.ts'

export interface VerifiedStack {
  language: LanguageId
  orm: OrmId
  database: Dialect
  execution: Execution
  scenarios: readonly string[]
  date: string
}

export const VERIFIED: readonly VerifiedStack[] = [
  {
    language: 'python',
    orm: 'sqlalchemy',
    database: 'postgresql',
    execution: 'sync',
    scenarios: ['sqlalchemy-postgresql-sync', 'sqlalchemy-postgresql-services-tests-only'],
    date: '2026-11-11',
  },
  {
    language: 'python',
    orm: 'sqlalchemy',
    database: 'postgresql',
    execution: 'async',
    scenarios: ['sqlalchemy-postgresql-async-caller-by-table'],
    date: '2026-11-11',
  },
  {
    language: 'python',
    orm: 'sqlalchemy',
    database: 'mysql',
    execution: 'sync',
    scenarios: ['sqlalchemy-mysql-sync-pydantic'],
    date: '2026-11-11',
  },
  {
    language: 'python',
    orm: 'sqlalchemy',
    database: 'mysql',
    execution: 'async',
    scenarios: ['sqlalchemy-mysql-async-decided'],
    date: '2026-11-11',
  },
  {
    language: 'python',
    orm: 'sqlalchemy',
    database: 'mariadb',
    execution: 'sync',
    scenarios: ['sqlalchemy-mariadb-sync-decided'],
    date: '2026-11-11',
  },
  {
    language: 'python',
    orm: 'sqlalchemy',
    database: 'mariadb',
    execution: 'async',
    scenarios: ['sqlalchemy-mariadb-async-dataclass-cursor'],
    date: '2026-11-11',
  },
  {
    language: 'python',
    orm: 'sqlalchemy',
    database: 'sqlite',
    execution: 'sync',
    scenarios: ['sqlalchemy-sqlite-defaults', 'sqlalchemy-sqlite-database-services-get', 'sqlalchemy-sqlite-repositories-only'],
    date: '2026-11-11',
  },
  {
    language: 'python',
    orm: 'sqlalchemy',
    database: 'sqlite',
    execution: 'async',
    scenarios: ['sqlalchemy-sqlite-async-repository-commits'],
    date: '2026-11-11',
  },
]

/** Whether this stack has passed the verification. */
export function isVerified(stack: Pick<VerifiedStack, 'language' | 'orm' | 'database' | 'execution'>): boolean {
  return VERIFIED.some(
    (item) =>
      item.language === stack.language && item.orm === stack.orm && item.database === stack.database && item.execution === stack.execution,
  )
}
