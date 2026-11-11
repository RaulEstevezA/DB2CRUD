/**
 * Stacks whose generated projects have been built, run and called with their real tools
 * (verification/run.sh, in Docker). The interface shows a stack as verified only when it is listed here.
 *
 * Update this list after running the verification: one entry per scenario that passed, with its date.
 */
import type { ArchitectureId, AuthId, DatabaseId, FrameworkId, PersistenceId, ProjectSettings } from './stack.ts'

export interface VerifiedStack {
  framework: FrameworkId
  architecture: ArchitectureId
  persistence: PersistenceId
  database: DatabaseId | null
  auth: AuthId
  /** Day the scenario passed */
  date: string
}

export const VERIFIED: readonly VerifiedStack[] = [
  { framework: 'fastapi', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-09' },
  { framework: 'fastapi', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-09' },
  { framework: 'fastapi', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-09' },
  { framework: 'fastapi', architecture: 'layered', persistence: 'sqlalchemy', database: 'sqlite', auth: 'apiKey', date: '2026-11-09' },
  { framework: 'fastapi', architecture: 'modular', persistence: 'sqlalchemy', database: 'sqlite', auth: 'none', date: '2026-11-09' },
  { framework: 'fastapi', architecture: 'layered', persistence: 'sqlalchemy', database: 'postgresql', auth: 'jwt', date: '2026-11-09' },
  { framework: 'fastapi', architecture: 'modular', persistence: 'sqlalchemy', database: 'mysql', auth: 'none', date: '2026-11-09' },
  { framework: 'fastapi', architecture: 'layered', persistence: 'sqlalchemy', database: 'mariadb', auth: 'apiKey', date: '2026-11-09' },
  { framework: 'express', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-09' },
  { framework: 'express', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-09' },
  { framework: 'express', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-09' },
  { framework: 'springBoot', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-09' },
  { framework: 'springBoot', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-09' },
  { framework: 'springBoot', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-09' },
  { framework: 'springBoot', architecture: 'layered', persistence: 'jpa', database: 'postgresql', auth: 'jwt', date: '2026-11-09' },
  { framework: 'springBoot', architecture: 'modular', persistence: 'jpa', database: 'mysql', auth: 'none', date: '2026-11-09' },
  { framework: 'springBoot', architecture: 'layered', persistence: 'jpa', database: 'mariadb', auth: 'apiKey', date: '2026-11-09' },
  { framework: 'djangoRest', architecture: 'layered', persistence: 'djangoOrm', database: 'sqlite', auth: 'none', date: '2026-11-09' },
  { framework: 'djangoRest', architecture: 'modular', persistence: 'djangoOrm', database: 'sqlite', auth: 'jwt', date: '2026-11-09' },
  {
    framework: 'djangoRest',
    architecture: 'layered',
    persistence: 'djangoOrm',
    database: 'postgresql',
    auth: 'apiKey',
    date: '2026-11-09',
  },
  { framework: 'djangoRest', architecture: 'modular', persistence: 'djangoOrm', database: 'mysql', auth: 'none', date: '2026-11-09' },
  { framework: 'djangoRest', architecture: 'layered', persistence: 'djangoOrm', database: 'mariadb', auth: 'jwt', date: '2026-11-09' },
  { framework: 'nestjs', architecture: 'modular', persistence: 'memory', database: null, auth: 'none', date: '2026-11-09' },
  { framework: 'nestjs', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-09' },
  { framework: 'nestjs', architecture: 'modular', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-09' },
  { framework: 'nestjs', architecture: 'modular', persistence: 'typeorm', database: 'postgresql', auth: 'jwt', date: '2026-11-09' },
  { framework: 'nestjs', architecture: 'modular', persistence: 'typeorm', database: 'mysql', auth: 'none', date: '2026-11-09' },
  { framework: 'nestjs', architecture: 'modular', persistence: 'typeorm', database: 'mariadb', auth: 'apiKey', date: '2026-11-09' },
  { framework: 'laravel', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-10' },
  { framework: 'laravel', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-10' },
  { framework: 'laravel', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-10' },
  { framework: 'laravel', architecture: 'layered', persistence: 'eloquent', database: 'sqlite', auth: 'apiKey', date: '2026-11-10' },
  { framework: 'laravel', architecture: 'modular', persistence: 'eloquent', database: 'sqlite', auth: 'none', date: '2026-11-10' },
  { framework: 'laravel', architecture: 'layered', persistence: 'eloquent', database: 'postgresql', auth: 'jwt', date: '2026-11-10' },
  { framework: 'laravel', architecture: 'modular', persistence: 'eloquent', database: 'mysql', auth: 'none', date: '2026-11-10' },
  { framework: 'laravel', architecture: 'layered', persistence: 'eloquent', database: 'mariadb', auth: 'apiKey', date: '2026-11-10' },
  { framework: 'symfony', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-10' },
  { framework: 'symfony', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-10' },
  { framework: 'symfony', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-10' },
  { framework: 'symfony', architecture: 'layered', persistence: 'doctrine', database: 'sqlite', auth: 'apiKey', date: '2026-11-10' },
  { framework: 'symfony', architecture: 'modular', persistence: 'doctrine', database: 'sqlite', auth: 'none', date: '2026-11-10' },
  { framework: 'symfony', architecture: 'layered', persistence: 'doctrine', database: 'postgresql', auth: 'jwt', date: '2026-11-10' },
  { framework: 'symfony', architecture: 'modular', persistence: 'doctrine', database: 'mysql', auth: 'none', date: '2026-11-10' },
  { framework: 'symfony', architecture: 'layered', persistence: 'doctrine', database: 'mariadb', auth: 'apiKey', date: '2026-11-10' },
  { framework: 'aspnetCore', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-10' },
  { framework: 'aspnetCore', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-10' },
  { framework: 'aspnetCore', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-10' },
  { framework: 'aspnetCore', architecture: 'layered', persistence: 'efCore', database: 'sqlite', auth: 'apiKey', date: '2026-11-10' },
  { framework: 'aspnetCore', architecture: 'modular', persistence: 'efCore', database: 'sqlite', auth: 'none', date: '2026-11-10' },
  { framework: 'aspnetCore', architecture: 'layered', persistence: 'efCore', database: 'postgresql', auth: 'jwt', date: '2026-11-10' },
  { framework: 'aspnetCore', architecture: 'modular', persistence: 'efCore', database: 'mysql', auth: 'none', date: '2026-11-10' },
  { framework: 'aspnetCore', architecture: 'layered', persistence: 'efCore', database: 'mariadb', auth: 'apiKey', date: '2026-11-10' },
  { framework: 'ktor', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-10' },
  { framework: 'ktor', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-10' },
  { framework: 'ktor', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-10' },
  { framework: 'ktor', architecture: 'layered', persistence: 'exposed', database: 'sqlite', auth: 'apiKey', date: '2026-11-10' },
  { framework: 'ktor', architecture: 'modular', persistence: 'exposed', database: 'sqlite', auth: 'none', date: '2026-11-10' },
  { framework: 'ktor', architecture: 'layered', persistence: 'exposed', database: 'postgresql', auth: 'jwt', date: '2026-11-10' },
  { framework: 'ktor', architecture: 'modular', persistence: 'exposed', database: 'mysql', auth: 'none', date: '2026-11-10' },
  { framework: 'ktor', architecture: 'layered', persistence: 'exposed', database: 'mariadb', auth: 'apiKey', date: '2026-11-10' },
  { framework: 'axum', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-11' },
  { framework: 'axum', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-11' },
  { framework: 'axum', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-11' },
  { framework: 'axum', architecture: 'layered', persistence: 'seaOrm', database: 'sqlite', auth: 'apiKey', date: '2026-11-11' },
  { framework: 'axum', architecture: 'modular', persistence: 'seaOrm', database: 'sqlite', auth: 'none', date: '2026-11-11' },
  { framework: 'axum', architecture: 'layered', persistence: 'seaOrm', database: 'postgresql', auth: 'jwt', date: '2026-11-11' },
  { framework: 'axum', architecture: 'modular', persistence: 'seaOrm', database: 'mysql', auth: 'none', date: '2026-11-11' },
  { framework: 'axum', architecture: 'layered', persistence: 'seaOrm', database: 'mariadb', auth: 'apiKey', date: '2026-11-11' },
  { framework: 'vapor', architecture: 'layered', persistence: 'memory', database: null, auth: 'none', date: '2026-11-11' },
  { framework: 'vapor', architecture: 'modular', persistence: 'memory', database: null, auth: 'jwt', date: '2026-11-11' },
  { framework: 'vapor', architecture: 'layered', persistence: 'none', database: null, auth: 'apiKey', date: '2026-11-11' },
  { framework: 'vapor', architecture: 'layered', persistence: 'fluent', database: 'sqlite', auth: 'apiKey', date: '2026-11-11' },
  { framework: 'vapor', architecture: 'modular', persistence: 'fluent', database: 'sqlite', auth: 'none', date: '2026-11-11' },
  { framework: 'vapor', architecture: 'layered', persistence: 'fluent', database: 'postgresql', auth: 'jwt', date: '2026-11-11' },
  { framework: 'vapor', architecture: 'modular', persistence: 'fluent', database: 'mysql', auth: 'none', date: '2026-11-11' },
  { framework: 'vapor', architecture: 'layered', persistence: 'fluent', database: 'mariadb', auth: 'apiKey', date: '2026-11-11' },
]

/** - `verified`: this exact stack passed
 * - `parts`: the persistence and database, the architecture and the authentication each passed with this
 *   framework, but not together
 * - `unverified`: some part never ran */
export type Verification = 'verified' | 'parts' | 'unverified'

/** How far a stack has been verified. */
export function verification(
  settings: Pick<ProjectSettings, 'framework' | 'architecture' | 'persistence' | 'database' | 'auth'>,
): Verification {
  const same = VERIFIED.filter((item) => item.framework === settings.framework)
  const exact = same.some(
    (item) =>
      item.architecture === settings.architecture &&
      item.persistence === settings.persistence &&
      item.database === settings.database &&
      item.auth === settings.auth,
  )
  if (exact) return 'verified'
  const storage = same.some((item) => item.persistence === settings.persistence && item.database === settings.database)
  const architecture = same.some((item) => item.architecture === settings.architecture)
  const auth = same.some((item) => item.auth === settings.auth)
  return storage && architecture && auth ? 'parts' : 'unverified'
}
