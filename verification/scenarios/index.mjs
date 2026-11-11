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
  { id: 'django-sqlite-defaults', schema: 'shop', settings: { language: 'python', orm: 'django', database: 'sqlite' } },
  { id: 'django-postgresql-pydantic', schema: 'shop', settings: { language: 'python', orm: 'django', database: 'postgresql', serviceTypes: 'dtos' }, service: 'postgresql' },
  {
    id: 'django-mysql-decided-cursor-by-table',
    schema: 'shop',
    settings: { language: 'python', orm: 'django', database: 'mysql', paging: 'cursor', architecture: 'table' },
    decisions: OTHER_WAY,
    service: 'mysql',
  },
  {
    id: 'django-mariadb-caller-dataclass',
    schema: 'shop',
    settings: { language: 'python', orm: 'django', database: 'mariadb', transactions: 'caller', serviceTypes: 'dtos', dtoKind: 'dataclass', paging: 'none' },
    service: 'mariadb',
  },
  {
    id: 'django-postgresql-repository-commits',
    schema: 'shop',
    settings: { language: 'python', orm: 'django', database: 'postgresql', transactions: 'repository', repositoryInterfaces: false, memoryRepositories: false, verbs: 'get' },
    service: 'postgresql',
  },
  { id: 'typeorm-sqlite-defaults', schema: 'shop', settings: { language: 'typescript', orm: 'typeorm', database: 'sqlite' } },
  {
    id: 'typeorm-postgresql-class-dtos',
    schema: 'shop',
    settings: { language: 'typescript', orm: 'typeorm', database: 'postgresql', serviceTypes: 'dtos', dtoKind: 'class' },
    service: 'postgresql',
  },
  {
    id: 'typeorm-mysql-decided-cursor-by-table',
    schema: 'shop',
    settings: { language: 'typescript', orm: 'typeorm', database: 'mysql', paging: 'cursor', architecture: 'table' },
    decisions: OTHER_WAY,
    service: 'mysql',
  },
  {
    id: 'typeorm-mariadb-caller-interface-dtos',
    schema: 'shop',
    settings: { language: 'typescript', orm: 'typeorm', database: 'mariadb', transactions: 'caller', serviceTypes: 'dtos', dtoKind: 'interface', paging: 'none' },
    service: 'mariadb',
  },
  {
    id: 'typeorm-postgresql-repository-commits',
    schema: 'shop',
    settings: { language: 'typescript', orm: 'typeorm', database: 'postgresql', transactions: 'repository', repositoryInterfaces: false, memoryRepositories: false, verbs: 'get' },
    service: 'postgresql',
  },
  {
    id: 'typeorm-sqlite-no-interfaces-services-tests',
    schema: 'shop',
    settings: { language: 'typescript', orm: 'typeorm', database: 'sqlite', repositoryInterfaces: false, verbs: 'find', tests: 'services', entities: 'all' },
  },
  { id: 'typeorm-sqlite-repositories-only', schema: 'shop', settings: { language: 'typescript', orm: 'typeorm', database: 'sqlite', services: false } },
]
