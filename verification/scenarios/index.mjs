/**
 * Combinations the verification generates and runs. Each scenario is a schema of the built-in fixtures, the
 * project settings that differ from the defaults, and optional decisions of the review (crud/edit.ts).
 * Together they cover every option of every setting, on every database.
 *
 * A stack is shown as verified in the interface only when a scenario with it passes
 * (web/src/core/settings/verified.ts).
 */

/** @typedef {{ table: string, decision: string, value: unknown }} Decision */
/** @typedef {{ id: string, schema: 'shop', settings: Record<string, unknown>, decisions?: Decision[], service?: 'postgresql' | 'mysql' | 'mariadb' }} Scenario */

/** Every pending decision of the shop taken the other way, so the code of the other options runs too. */
const OTHER_WAY = [
  { table: 'categories', decision: 'children', value: 'deleteFirst' },
  { table: 'customers', decision: 'children', value: 'deleteFirst' },
  { table: 'products', decision: 'delete', value: { mode: 'hard' } },
  { table: 'products', decision: 'children', value: 'deleteFirst' },
  { table: 'products', decision: 'concurrency', value: { mode: 'none' } },
  { table: 'customers', decision: 'hidden', value: [] },
  { table: 'product_tags', decision: 'role', value: 'entity' },
]

/** @type {Scenario[]} */
export const SCENARIOS = [
  { id: 'sqlalchemy-sqlite-defaults', schema: 'shop', settings: { database: 'sqlite' } },
  { id: 'sqlalchemy-postgresql-sync', schema: 'shop', settings: { database: 'postgresql' }, service: 'postgresql' },
  { id: 'sqlalchemy-mysql-sync-pydantic', schema: 'shop', settings: { database: 'mysql', serviceTypes: 'dtos' }, service: 'mysql' },
  {
    id: 'sqlalchemy-mariadb-async-dataclass-cursor',
    schema: 'shop',
    settings: { database: 'mariadb', execution: 'async', serviceTypes: 'dtos', dtoKind: 'dataclass', paging: 'cursor' },
    service: 'mariadb',
  },
  {
    id: 'sqlalchemy-postgresql-async-caller-by-table',
    schema: 'shop',
    settings: { database: 'postgresql', execution: 'async', transactions: 'caller', architecture: 'table', paging: 'none' },
    service: 'postgresql',
  },
  {
    id: 'sqlalchemy-sqlite-async-repository-commits',
    schema: 'shop',
    settings: { database: 'sqlite', execution: 'async', transactions: 'repository', repositoryInterfaces: false, verbs: 'find' },
  },
  { id: 'sqlalchemy-sqlite-database-services-get', schema: 'shop', settings: { database: 'sqlite', memoryRepositories: false, verbs: 'get', serviceTypes: 'dtos' } },
  { id: 'sqlalchemy-mysql-async-decided', schema: 'shop', settings: { database: 'mysql', execution: 'async' }, decisions: OTHER_WAY, service: 'mysql' },
  { id: 'sqlalchemy-mariadb-sync-decided', schema: 'shop', settings: { database: 'mariadb', paging: 'cursor', architecture: 'table' }, decisions: OTHER_WAY, service: 'mariadb' },
  { id: 'sqlalchemy-sqlite-repositories-only', schema: 'shop', settings: { database: 'sqlite', services: false } },
  { id: 'sqlalchemy-postgresql-services-tests-only', schema: 'shop', settings: { database: 'postgresql', tests: 'services', entities: 'all' }, service: 'postgresql' },
]
