/**
 * Interface texts in English and Spanish.
 *
 * `en` defines the shape of the texts; `es` must have exactly the same keys, which the `Messages` type
 * checks. To add a text, add it to both. Texts that depend on a value are functions.
 */

import type { Direction } from '../core/matching/matching.ts'
import type { WorkspacePart } from '../app/workspaceParts.ts'
import type { Confidence, Reason } from '../core/decisions/decision.ts'
import type { ChildrenPolicy, OperationCheck, OperationDesign, PolicyDecisionKind, QueryKind, TableRole } from '../core/crud/types.ts'
import type { DatabaseReadError } from '../app/workspace.ts'
import type { DbNote, Dialect } from '../core/schema/types.ts'
import type {
  Architecture,
  DtoKind,
  Updates,
  EntitiesMode,
  ErrorStyle,
  Execution,
  LanguageId,
  ModelsSource,
  Paging,
  ServiceTypes,
  Tests,
  Transactions,
  Verbs,
} from '../core/settings/settings.ts'
import type { ExampleId } from '../examples/index.ts'

type Params = Record<string, string | number> | undefined
const p = (params: Params, key: string) => String(params?.[key] ?? '')

/** A number with the language's thousands separator. */
const number = (locale: string) => (value: number) => value.toLocaleString(locale)
const en$ = number('en')
const es$ = number('es')

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/** Languages of the interface, in the order the language switcher shows them. */
export const languages = ['en', 'es'] as const

export type Language = (typeof languages)[number]

const en = {
  languageLabel: 'Language',
  processedLocally: 'Processed locally',
  tagline: 'Generate the repositories and services of a database you already have',
  introDescription:
    'Paste or open your database schema (a Model2DB project, ORM code, SQL DDL or MongoDB collections) and, if you have them, your application models. DB2CRUD proposes the repositories, the services and any missing entities, explains each proposal and lets you change it. Download the code with its tests.',
  linksLabel: 'Downloads and links',
  downloadDesktop: 'Download for desktop',
  downloadFor: (platform: string) => `Download for ${platform}`,
  otherPlatforms: 'Other platforms',
  otherArchitecture: (architecture: string) => `${architecture} version`,
  downloadNote: 'Desktop version for Windows, macOS and Linux. It is not signed, so the first time your system will show a warning.',
  howToOpen: 'How to open it',
  howToOpenUrl: 'https://github.com/RaulEstevezA/DB2CRUD/blob/main/desktop/README_en.md#opening-it-the-first-time',
  sourceCode: 'Source code',
  allTools: 'All tools',
  license: 'MIT License',
  workspaceLabel: 'Workspace',
  pendingCount: (count: number) => `${en$(count)} ${plural(count, 'item', 'items')} to review`,
  hasError: 'Something cannot be read',
  workspaceParts: { database: 'Database', design: 'Design', project: 'Project' } satisfies Record<WorkspacePart, string>,
  examplesLabel: 'Try an example',
  examples: { store: 'Online shop', library: 'Library', catalog: 'Catalogue' } satisfies Record<ExampleId, string>,
  exampleDescriptions: {
    store: 'Model2DB project for PostgreSQL: customers, products and orders with a password and an enum',
    library: 'Model2DB project with SQLAlchemy entities: authors and books with UUID keys',
    catalog: 'Model2DB project for MySQL: a catalogue of items in a category tree',
  } satisfies Record<ExampleId, string>,
  confirmReplace: 'Your current database and the decisions made on it will be replaced. Continue?',

  inputLabel: 'Database to read',
  inputPlaceholder:
    'Paste a Model2DB project (the .model2db.json file Model2DB saves) or ORM models (SQLAlchemy, SQLModel, Django, Tortoise, a Prisma schema, TypeORM entities, Sequelize models, a Drizzle schema, JPA entities, an EF Core model, Doctrine entities, Laravel migrations and Eloquent models, Mongoose schemas, Spring Data MongoDB or Beanie documents) or SQL DDL (CREATE TABLE…) or the validators or sample documents of MongoDB collections (they stay on your computer), or drop the file here…',
  openFile: 'Open',
  clear: 'Clear',
  dropFile: 'Drop the file to open it',
  fileTooLarge: (name: string) => `“${name}” is larger than 10 MB.`,
  fileError: (name: string) => `“${name}” could not be read.`,
  inputEmpty:
    'Paste or open a Model2DB project, ORM code, SQL DDL or MongoDB collections to start. To read a project of several files or a whole folder, download the desktop app.',
  note: (note: DbNote): string => {
    const { table = '', column = '', count = 0, types = '', target = '' } = note.params ?? {}
    const known: Record<string, string> = {
      'documents.unnamed': `Nothing says the name of the collection: it is read as “${table}”. Name the file like the collection, or paste db.name.find() with what it prints.`,
      'documents.few': `${table}: ${count} ${plural(Number(count), 'document', 'documents')}. With fewer than 5 nothing is taken as required.`,
      'documents.deduced': `${table}: deduced from ${count} documents. A field all of them have is required; unique values, limits and lists of values are not deduced.`,
      'documents.mixedTypes': `${table}.${column} has values of several types (${types}): any value is taken.`,
      'documents.onlyNull': `${table}.${column} is always empty: any value is taken.`,
      'documents.emptyList': `${table}.${column} is always an empty list: its items may be anything.`,
      'documents.dataKeys': `${table}.${column} seems to keep data in its keys: it is read as a free document.`,
      'documents.cut': `${table}.${column} is not printed whole ([Object]): it is read as a free document. Use mongoexport, or config.set('inspectDepth', Infinity) in mongosh.`,
      'documents.otherType': `${table}.${column} has a type without a common one: it is read as a free document.`,
      'documents.reference': `${table}.${column} points to ${target}: their identifiers match.`,
    }
    return known[note.code] ?? [note.code, ...Object.values(note.params ?? {})].join(' · ')
  },
  warningsCount: (count: number) => `${en$(count)} ${plural(count, 'note', 'notes')}`,
  readError: (error: DatabaseReadError, path?: string): string =>
    ({
      notJson: 'It is not JSON: paste the .model2db.json file Model2DB saves.',
      notProject: 'It is not a Model2DB project.',
      newerVersion: 'The project was saved by a newer version of Model2DB.',
      invalid: `The project is damaged${path ? ` (${path})` : ''}.`,
      unreadableInput: 'The models inside the project cannot be read.',
      noModels: 'The project has no models.',
      unsupportedDatabase: 'The project is for a database DB2CRUD does not support (Couchbase, Redis, Cassandra, ScyllaDB…).',
      unknownInput:
        'It is neither a Model2DB project, nor SQL DDL, nor ORM code it can read (SQLAlchemy, SQLModel, Django, Tortoise, Prisma, TypeORM, Sequelize, Drizzle, JPA/Hibernate, EF Core, Doctrine, Eloquent, Mongoose, Spring Data MongoDB and Beanie so far), nor validators or documents (with their _id) of MongoDB.',
      noTables:
        'The code declares no table: a SQLAlchemy class needs its __tablename__, a SQLModel one table=True, a Django or Tortoise one Model, a Prisma schema a model block, a TypeORM class @Entity(), Sequelize models Model.init() or sequelize.define(), a Drizzle schema pgTable(), mysqlTable() or sqliteTable(), a JPA class @Entity, an EF Core model a DbContext with its DbSet<…>, a Doctrine class #[ORM\\Entity], Eloquent the migrations with Schema::create, SQL DDL a CREATE TABLE, Mongoose a model(), a Spring Data MongoDB class @Document, Beanie a Document class, and MongoDB a createCollection() with its validator.',
    })[error],
  databaseSummary: (source: string, dialect: string | null, tables: number, columns: number) =>
    `${source} · ${dialect ?? 'any database'} · ${en$(tables)} ${plural(tables, 'table', 'tables')} · ${en$(columns)} ${plural(columns, 'column', 'columns')}`,
  // Design pane
  undo: 'Undo',
  redo: 'Redo',
  reset: 'Reset',
  undoTitle: 'Undo (Ctrl/Cmd+Z)',
  redoTitle: 'Redo (Ctrl/Cmd+Shift+Z)',
  resetTitle: 'Back to the proposal: every choice you made is discarded',
  confirmReset: 'Every choice you made on this design will be discarded. Continue?',
  designEmpty: 'The repositories and services proposed for each table will appear here once the database is read.',
  designSummary: (repositories: number, services: number) =>
    `${en$(repositories)} ${plural(repositories, 'repository', 'repositories')} · ${en$(services)} ${plural(services, 'service', 'services')}`,
  policyKinds: {
    role: 'Table',
    delete: 'Delete',
    concurrency: 'Concurrent changes',
    children: 'Rows that point here',
    hidden: 'Never returned',
  } satisfies Record<PolicyDecisionKind, string>,
  policySubject: (table: string, kind: string) => `${table}: ${kind.toLowerCase()}`,
  itemSubject: (table: string, kind: string, id: string) => `${table}: ${id === kind ? kind : id}`,
  fieldSubject: (table: string, name: string, model: string) => `${table}.${name}: ${model.toLowerCase()}`,
  roles: { entity: 'Read and written', join: 'Links two tables', readOnly: 'Read only' } satisfies Record<TableRole, string>,
  deleteHard: 'Remove the row',
  deleteSoft: (column: string) => `Mark it in “${column}”`,
  concurrencyNone: 'Last change wins',
  concurrencyVersion: (column: string) => `Check “${column}”`,
  childrenPolicies: { block: 'Refuse the delete', deleteFirst: 'Delete them first' } satisfies Record<ChildrenPolicy, string>,
  hiddenNone: 'Nothing hidden',
  entityMissing: 'entity written',
  queriesTitle: 'Repository',
  operationsTitle: (service: string) => service,
  queryDescription: (kind: QueryKind, columns: string[]): string =>
    ({
      getByKey: `one row by its key (${columns.join(', ')})`,
      findByUnique: `one row by ${columns.join(', ')}`,
      findAllBy: `rows by ${columns.join(', ')}`,
      listByParent: `rows that point to a ${columns.join(', ')}`,
      list: 'every row',
      insert: 'stores a new row',
      update: 'stores changes',
      delete: 'removes a row',
      addItem: `adds one item to ${columns.join(', ')}`,
      removeItem: `removes one item from ${columns.join(', ')}`,
    })[kind],
  operationDescription: (operation: OperationDesign): string => {
    const names: Record<OperationCheck, string> = {
      validate: 'the values',
      unique: 'unique values',
      parentExists: 'the rows it points to',
      version: 'the version',
      children: 'rows that point here',
    }
    const parts = [
      operation.checks.length > 0 && `checks ${operation.checks.map((check) => names[check]).join(', ')}`,
      operation.errors.length > 0 && `raises ${operation.errors.join(', ')}`,
    ]
    return parts.filter(Boolean).join(' · ')
  },
  // Project pane
  projectName: 'Project name',
  stackLabel: 'Language and library',
  languages: {
    python: 'Python',
    typescript: 'TypeScript',
    java: 'Java',
    csharp: 'C#',
    php: 'PHP',
    kotlin: 'Kotlin',
    rust: 'Rust',
    swift: 'Swift',
  } satisfies Record<LanguageId, string>,
  databaseLabel: 'Database',
  databases: {
    postgresql: 'PostgreSQL',
    mysql: 'MySQL',
    mariadb: 'MariaDB',
    sqlite: 'SQLite',
    sqlserver: 'SQL Server',
    oracle: 'Oracle',
    mongodb: 'MongoDB',
  } satisfies Record<Dialect, string>,
  executionLabel: 'Code',
  executions: { sync: 'Synchronous', async: 'Asynchronous' } satisfies Record<Execution, string>,
  entitiesLabel: 'Entities',
  entitiesModes: { missing: 'Only the missing ones', all: 'All, written again', none: 'None: import them' } satisfies Record<
    EntitiesMode,
    string
  >,
  entitiesModuleLabel: 'Module of the entities',
  modelsSourceLabel: 'Application model classes',
  modelsSources: { copy: 'Copied into the project', import: 'Imported from your module' } satisfies Record<ModelsSource, string>,
  modelsModuleLabel: 'Module of the models',
  conversionsLanguage: (models: string, project: string) =>
    `The application models are written in ${models} and the project in ${project}: the services keep their DTOs and no conversions are written. Choose ${models} as the language of the project to get them.`,
  servicesLabel: 'Services',
  yes: 'Yes',
  no: 'No',
  serviceTypesLabel: 'Services take and return',
  serviceTypes: { entities: 'The entities', dtos: 'DTOs' } satisfies Record<ServiceTypes, string>,
  dtoKindLabel: 'DTOs as',
  dtoKinds: {
    pydantic: 'Pydantic models',
    dataclass: 'Dataclasses',
    interface: 'Interfaces',
    class: 'Classes',
    record: 'Records',
    readonly: 'Readonly classes',
    data: 'Data classes',
    struct: 'Structs',
  } satisfies Record<DtoKind, string>,
  updatesLabel: 'Updates take',
  updatesModes: {
    partial: 'The changed fields',
    patch: 'Patch<T> per field',
    optional: 'Optional<T> per field',
    full: 'Every field (PUT)',
  } satisfies Record<Updates, string>,
  transactionsLabel: 'Transactions',
  transactions: {
    operation: 'One per operation',
    caller: 'The caller’s',
    repository: 'One per write',
  } satisfies Record<Transactions, string>,
  errorsLabel: 'Errors',
  errorStyles: { exceptions: 'Exceptions', results: 'Result values' } satisfies Record<ErrorStyle, string>,
  pagingLabel: 'Lists',
  pagings: { offset: 'Pages (offset)', cursor: 'Pages (cursor)', none: 'Every row' } satisfies Record<Paging, string>,
  architectureLabel: 'Folders',
  architectures: { layer: 'By layer', table: 'By table' } satisfies Record<Architecture, string>,
  verbsLabel: 'Reads named',
  verbs: { getFind: 'get / find', get: 'get', find: 'find' } satisfies Record<Verbs, string>,
  interfacesLabel: 'Repository interfaces',
  memoryLabel: 'In-memory repositories',
  testsLabel: 'Tests',
  testsModes: {
    all: 'Services and repositories',
    services: 'Services',
    repositories: 'Repositories',
    none: 'None',
  } satisfies Record<Tests, string>,
  experimental: 'experimental',
  stackVerified: 'Verified: a project with this language, library, database and code has passed its tests in Docker.',
  stackNotVerified: 'Not verified yet with this database and code: review it before using it.',
  projectEmpty: 'The files of the generated project will appear here.',
  fileLabel: (path: string) => `Content of ${path}`,
  copy: 'Copy',
  copied: 'Copied',
  // Hidden with its button in ProjectPane.tsx until CRUD2Controller is published
  // continueInCrud2Controller: 'Continue in CRUD2Controller',
  downloadFile: 'Download file',
  downloadZip: (count: number) => `Download .zip (${en$(count)} ${plural(count, 'file', 'files')})`,
  todoCount: (count: number) => `${en$(count)} TODO ${plural(count, 'mark', 'marks')} left for you`,
  status: {
    exact: 'Exact',
    high: 'High',
    probable: 'Likely',
    review: 'Review',
    conflict: 'Conflict',
    none: 'None',
    manual: 'Your choice',
  } satisfies Record<Confidence | 'manual', string>,
  accept: 'Confirm',
  acceptTitle: (subject: string) => `Confirm the suggestion for ${subject}`,
  reason: (reason: Reason): string => {
    const params = reason.params
    switch (reason.code) {
      case 'primaryKey':
        return `The primary key (${p(params, 'columns')}) identifies each row.`
      case 'uniqueConstraint':
        return `${p(params, 'columns')} is unique: at most one row has each value.`
      case 'nestedList':
        return `“${p(params, 'column')}” is a list inside each document: changing one item does not undo what others change in the rest.`
      case 'indexOnly':
        return `There is an index on ${p(params, 'columns')}, but it may exist only for speed: keep the query if the application looks rows up by it.`
      case 'foreignKey':
        return `Each row points to a row of ${p(params, 'table')}.`
      case 'readOnlyTable':
        return 'The table is read only.'
      case 'tableWithKey':
        return 'The table has a primary key: rows can be read, created, changed and deleted.'
      case 'noPrimaryKey':
        return 'The table has no primary key: a row cannot be told apart from another, so it is only read.'
      case 'joinTable':
        return `It only links ${p(params, 'tables')}: links are added and removed from them.`
      case 'softDeleteColumn':
        return `“${p(params, 'column')}” suggests rows are marked as deleted instead of removed.`
      case 'noSoftDeleteColumn':
        return 'No column marks rows as deleted: deleting removes the row.'
      case 'versionColumn':
        return `“${p(params, 'column')}” counts versions: a change made on an old version is refused.`
      case 'noVersionColumn':
        return 'No column counts versions.'
      case 'childrenWithoutAction':
        return `Rows of ${p(params, 'tables')} point here and the database does nothing on delete: refuse the delete while they exist, or delete them first.`
      case 'secretNamed':
        return `${p(params, 'columns')} looks like a secret: it is never returned.`
      case 'noSecrets':
        return 'No column looks like a secret.'
      case 'modelName':
        return `The model ${p(params, 'model')} has the name of the table.`
      case 'modelNames':
        return `Several models have the name of the table (${p(params, 'models')}): choose the one the service takes.`
      case 'noModel':
        return 'No model has the name of the table: the service works with the entity.'
      case 'fieldName':
        return `The field ${p(params, 'field')} has the name of the column.`
      case 'fieldWords':
        return `The field ${p(params, 'field')} has the name of the column in another convention.`
      case 'lookupUnique':
        return `${p(params, 'field')} names a row of ${p(params, 'table')} by its ${p(params, 'column')}, which is unique: the service looks the key up.`
      case 'lookupNotUnique':
        return `${p(params, 'field')} names a row of ${p(params, 'table')} by its ${p(params, 'column')}, but several rows may have it: check the lookup.`
      case 'generatedColumn':
        return 'The database fills the column: the model does not send it.'
      case 'noFieldRequired':
        return 'No field fills the column, and it needs a value: give it a field or a default.'
      case 'noField':
        return 'No field fills the column: it keeps its default or null.'
      case 'childRows':
        return `${p(params, 'field')} lists the rows of ${p(params, 'table')}.`
      case 'childTables':
        return `${p(params, 'field')} may list the rows of several tables (${p(params, 'tables')}): choose one.`
      case 'mapperModel':
        return `The Mapper project relates this table with the model (${p(params, 'mapping')}).`
      case 'mapperField':
        return `Mapper relates the column with ${p(params, 'fields')} (${p(params, 'transform')}), a relation that also works the other way.`
      case 'mapperOneWay':
        return `Mapper relates the column with ${p(params, 'fields')} (${p(params, 'transform')}) in one direction only: the other one is left as a TODO.`
      case 'mapperPending':
        return `Mapper suggests ${p(params, 'fields')} (${p(params, 'transform')}), but it was not confirmed there: check it.`
      case 'manual':
        return 'You chose it.'
    }
  },
  inputSourcesLabel: 'What to read',
  inputSources: { database: 'Database schema', models: 'Application models' },
  modelsLabel: 'Application models',
  modelsPlaceholder:
    'Optional: paste or open the models of your application (classes, DTOs, records… in TypeScript, Python, Java, C#, Kotlin, Dart, Go, Rust, PHP, Swift, Scala; JSON, JSON Schema, OpenAPI, GraphQL…). The services will take and return them.',
  modelsEmpty: 'No application models: the services take and return the entities.',
  modelsError: (code: string) =>
    code === 'unknownFormat'
      ? 'The format of these models is not one DB2CRUD reads.'
      : code === 'noModels'
        ? 'There is no model in this text.'
        : `These models cannot be read (${code}).`,
  modelsSummary: (format: string, count: number) => `${format} · ${en$(count)} ${plural(count, 'model', 'models')}`,
  mapperSummary: (source: string, target: string) => `Mapper project · ${source} → ${target}`,
  sourceMapper: (fields: string[], transform: string, output: boolean) =>
    `${output ? '→' : '←'} ${fields.join(' + ') || '—'} (Mapper: ${transform})`,
  modelTitles: { both: 'Application model', input: 'Model written', output: 'Model read' } satisfies Record<Direction, string>,
  noModel: 'none',
  sourceNone: 'no field',
  sourceField: (field: string) => `← ${field}`,
  sourceLookup: (field: string, table: string, by: string) => `← ${field}, looked up in ${table}.${by}`,
  targetField: (field: string) => `→ ${field}`,
  targetLookup: (field: string, table: string, by: string) => `→ ${field}, from ${table}.${by}`,
  sourceDatabase: 'filled by the database',
  sourceChildren: (table: string | null) => (table ? `rows of ${table}` : 'no table'),
  unusedFields: (fields: string[], direction: Direction) => `${direction === 'output' ? 'Not filled' : 'Not saved'}: ${fields.join(', ')}`,
  conflictLength: (model: number, column: number) => `the model allows ${en$(model)} characters, the column ${en$(column)}`,
  conflictNullable: 'optional in the model, required in the column',
  conflictNullableOutput: 'required in the model, may be null in the column',
  conflictType: (model: string, column: string) => `${model} in the model, ${column} in the column`,
  conflictValues: (missing: string[]) => `the column does not accept ${missing.join(', ')}`,
  conflictUnknownValues: (values: string[]) => `the model does not accept ${values.join(', ')}`,
  fileTreeLabel: 'Generated files',
}

/** Every text of the interface in one language. */
export type Messages = typeof en

const es: Messages = {
  languageLabel: 'Idioma',
  processedLocally: 'Procesado en local',
  tagline: 'Genera los repositorios y servicios de una base de datos que ya tienes',
  introDescription:
    'Pega o abre el esquema de tu base de datos (un proyecto de Model2DB, código ORM, DDL de SQL o colecciones de MongoDB) y, si los tienes, tus modelos de aplicación. DB2CRUD propone los repositorios, los servicios y las entidades que falten, explica cada propuesta y te deja cambiarla. Descarga el código con sus pruebas.',
  linksLabel: 'Descargas y enlaces',
  downloadDesktop: 'Descargar para escritorio',
  downloadFor: (platform) => `Descargar para ${platform}`,
  otherPlatforms: 'Otras plataformas',
  otherArchitecture: (architecture) => `Versión ${architecture}`,
  downloadNote: 'Versión de escritorio para Windows, macOS y Linux. No está firmada, así que la primera vez el sistema mostrará un aviso.',
  howToOpen: 'Cómo abrirla',
  howToOpenUrl: 'https://github.com/RaulEstevezA/DB2CRUD/blob/main/desktop/README_es.md#abrirla-la-primera-vez',
  sourceCode: 'Código fuente',
  allTools: 'Todas las herramientas',
  license: 'Licencia MIT',
  workspaceLabel: 'Área de trabajo',
  pendingCount: (count) => `${es$(count)} ${plural(count, 'elemento', 'elementos')} por revisar`,
  hasError: 'Hay algo que no se puede leer',
  workspaceParts: { database: 'Base de datos', design: 'Diseño', project: 'Proyecto' },
  examplesLabel: 'Prueba un ejemplo',
  examples: { store: 'Tienda online', library: 'Biblioteca', catalog: 'Catálogo' },
  exampleDescriptions: {
    store: 'Proyecto de Model2DB para PostgreSQL: clientes, productos y pedidos con una contraseña y un enum',
    library: 'Proyecto de Model2DB con entidades de SQLAlchemy: autores y libros con claves UUID',
    catalog: 'Proyecto de Model2DB para MySQL: un catálogo de artículos en un árbol de categorías',
  },
  confirmReplace: 'Se sustituirán tu base de datos actual y las decisiones tomadas sobre ella. ¿Continuar?',

  inputLabel: 'Base de datos que leer',
  inputPlaceholder:
    'Pega un proyecto de Model2DB (el archivo .model2db.json que guarda Model2DB) o modelos de un ORM (SQLAlchemy, SQLModel, Django, Tortoise, un schema de Prisma, entidades de TypeORM, modelos de Sequelize, un schema de Drizzle, entidades JPA, un modelo de EF Core, entidades de Doctrine, migraciones de Laravel y modelos de Eloquent, esquemas de Mongoose, documentos de Spring Data MongoDB o Beanie) o DDL de SQL (CREATE TABLE…) o los validadores o documentos de ejemplo de colecciones de MongoDB (no salen de tu equipo), o suelta aquí el archivo…',
  openFile: 'Abrir',
  clear: 'Limpiar',
  dropFile: 'Suelta el archivo para abrirlo',
  fileTooLarge: (name) => `«${name}» ocupa más de 10 MB.`,
  fileError: (name) => `No se ha podido leer «${name}».`,
  inputEmpty:
    'Pega o abre un proyecto de Model2DB, código ORM, DDL de SQL o colecciones de MongoDB para empezar. Para leer un proyecto de varios archivos o una carpeta entera, descarga la app de escritorio.',
  note: (note) => {
    const { table = '', column = '', count = 0, types = '', target = '' } = note.params ?? {}
    const known: Record<string, string> = {
      'documents.unnamed': `Nada dice el nombre de la colección: se lee como «${table}». Llama al archivo como la colección, o pega db.nombre.find() con lo que imprime.`,
      'documents.few': `${table}: ${count} ${plural(Number(count), 'documento', 'documentos')}. Con menos de 5 no se da nada por obligatorio.`,
      'documents.deduced': `${table}: deducida de ${count} documentos. Un campo que todos tienen es obligatorio; no se deducen valores únicos, límites ni listas de valores.`,
      'documents.mixedTypes': `${table}.${column} tiene valores de varios tipos (${types}): se acepta cualquiera.`,
      'documents.onlyNull': `${table}.${column} está siempre vacío: se acepta cualquier valor.`,
      'documents.emptyList': `${table}.${column} es siempre una lista vacía: sus elementos pueden ser cualquier cosa.`,
      'documents.dataKeys': `${table}.${column} parece guardar datos en sus claves: se lee como un documento libre.`,
      'documents.cut': `${table}.${column} no está impreso entero ([Object]): se lee como un documento libre. Usa mongoexport, o config.set('inspectDepth', Infinity) en mongosh.`,
      'documents.otherType': `${table}.${column} tiene un tipo sin equivalente común: se lee como un documento libre.`,
      'documents.reference': `${table}.${column} apunta a ${target}: sus identificadores coinciden.`,
    }
    return known[note.code] ?? [note.code, ...Object.values(note.params ?? {})].join(' · ')
  },
  warningsCount: (count) => `${es$(count)} ${plural(count, 'nota', 'notas')}`,
  readError: (error, path) =>
    ({
      notJson: 'No es JSON: pega el archivo .model2db.json que guarda Model2DB.',
      notProject: 'No es un proyecto de Model2DB.',
      newerVersion: 'El proyecto se guardó con una versión más reciente de Model2DB.',
      invalid: `El proyecto está dañado${path ? ` (${path})` : ''}.`,
      unreadableInput: 'No se pueden leer los modelos del proyecto.',
      noModels: 'El proyecto no tiene modelos.',
      unsupportedDatabase: 'El proyecto es para una base de datos que DB2CRUD no admite (Couchbase, Redis, Cassandra, ScyllaDB…).',
      unknownInput:
        'No es un proyecto de Model2DB, ni DDL de SQL, ni código ORM que sepa leer (por ahora, SQLAlchemy, SQLModel, Django, Tortoise, Prisma, TypeORM, Sequelize, Drizzle, JPA/Hibernate, EF Core, Doctrine, Eloquent, Mongoose, Spring Data MongoDB y Beanie), ni validadores ni documentos (con su _id) de MongoDB.',
      noTables:
        'El código no declara ninguna tabla: una clase de SQLAlchemy necesita su __tablename__; una de SQLModel, table=True, una de Django o Tortoise, Model; un schema de Prisma, un bloque model, una clase de TypeORM, @Entity(), los modelos de Sequelize, Model.init() o sequelize.define(), un schema de Drizzle, pgTable(), mysqlTable() o sqliteTable(), una clase JPA, @Entity, un modelo de EF Core, un DbContext con sus DbSet<…>, una clase de Doctrine, #[ORM\\Entity]; Eloquent, las migraciones con Schema::create, el DDL de SQL, un CREATE TABLE; Mongoose, un model(), una clase de Spring Data MongoDB, @Document; Beanie, una clase Document, y MongoDB, un createCollection() con su validador.',
    })[error],
  databaseSummary: (source, dialect, tables, columns) =>
    `${source} · ${dialect ?? 'cualquier base de datos'} · ${es$(tables)} ${plural(tables, 'tabla', 'tablas')} · ${es$(columns)} ${plural(columns, 'columna', 'columnas')}`,
  undo: 'Deshacer',
  redo: 'Rehacer',
  reset: 'Restablecer',
  undoTitle: 'Deshacer (Ctrl/Cmd+Z)',
  redoTitle: 'Rehacer (Ctrl/Cmd+Mayús+Z)',
  resetTitle: 'Volver a la propuesta: se descartan todas tus elecciones',
  confirmReset: 'Se descartarán todas las elecciones que has hecho en este diseño. ¿Continuar?',
  designEmpty: 'Aquí aparecerán los repositorios y servicios propuestos para cada tabla en cuanto se lea la base de datos.',
  designSummary: (repositories, services) =>
    `${es$(repositories)} ${plural(repositories, 'repositorio', 'repositorios')} · ${es$(services)} ${plural(services, 'servicio', 'servicios')}`,
  policyKinds: {
    role: 'Tabla',
    delete: 'Borrado',
    concurrency: 'Cambios a la vez',
    children: 'Filas que apuntan aquí',
    hidden: 'Nunca se devuelve',
  },
  policySubject: (table, kind) => `${table}: ${kind.toLowerCase()}`,
  itemSubject: (table, kind, id) => `${table}: ${id === kind ? kind : id}`,
  fieldSubject: (table, name, model) => `${table}.${name}: ${model.toLowerCase()}`,
  roles: { entity: 'Se lee y se escribe', join: 'Relaciona dos tablas', readOnly: 'Solo lectura' },
  deleteHard: 'Eliminar la fila',
  deleteSoft: (column) => `Marcarla en «${column}»`,
  concurrencyNone: 'Gana el último cambio',
  concurrencyVersion: (column) => `Comprobar «${column}»`,
  childrenPolicies: { block: 'Rechazar el borrado', deleteFirst: 'Borrarlas antes' },
  hiddenNone: 'Nada oculto',
  entityMissing: 'entidad generada',
  queriesTitle: 'Repositorio',
  operationsTitle: (service) => service,
  queryDescription: (kind, columns) =>
    ({
      getByKey: `una fila por su clave (${columns.join(', ')})`,
      findByUnique: `una fila por ${columns.join(', ')}`,
      findAllBy: `filas por ${columns.join(', ')}`,
      listByParent: `filas que apuntan a un ${columns.join(', ')}`,
      list: 'todas las filas',
      insert: 'guarda una fila nueva',
      update: 'guarda cambios',
      delete: 'elimina una fila',
      addItem: `añade un elemento a ${columns.join(', ')}`,
      removeItem: `quita un elemento de ${columns.join(', ')}`,
    })[kind],
  operationDescription: (operation) => {
    const names: Record<OperationCheck, string> = {
      validate: 'los valores',
      unique: 'los valores únicos',
      parentExists: 'las filas a las que apunta',
      version: 'la versión',
      children: 'las filas que apuntan aquí',
    }
    const parts = [
      operation.checks.length > 0 && `comprueba ${operation.checks.map((check) => names[check]).join(', ')}`,
      operation.errors.length > 0 && `lanza ${operation.errors.join(', ')}`,
    ]
    return parts.filter(Boolean).join(' · ')
  },
  projectName: 'Nombre del proyecto',
  stackLabel: 'Lenguaje y librería',
  languages: {
    python: 'Python',
    typescript: 'TypeScript',
    java: 'Java',
    csharp: 'C#',
    php: 'PHP',
    kotlin: 'Kotlin',
    rust: 'Rust',
    swift: 'Swift',
  },
  databaseLabel: 'Base de datos',
  databases: {
    postgresql: 'PostgreSQL',
    mysql: 'MySQL',
    mariadb: 'MariaDB',
    sqlite: 'SQLite',
    sqlserver: 'SQL Server',
    oracle: 'Oracle',
    mongodb: 'MongoDB',
  },
  executionLabel: 'Código',
  executions: { sync: 'Síncrono', async: 'Asíncrono' },
  entitiesLabel: 'Entidades',
  entitiesModes: { missing: 'Solo las que faltan', all: 'Todas, escritas de nuevo', none: 'Ninguna: se importan' },
  entitiesModuleLabel: 'Módulo de las entidades',
  modelsSourceLabel: 'Clases de los modelos de aplicación',
  modelsSources: { copy: 'Copiadas en el proyecto', import: 'Importadas de tu módulo' },
  modelsModuleLabel: 'Módulo de los modelos',
  conversionsLanguage: (models, project) =>
    `Los modelos de aplicación están escritos en ${models} y el proyecto en ${project}: los servicios siguen con sus DTO y no se escriben conversiones. Elige ${models} como lenguaje del proyecto para tenerlas.`,
  servicesLabel: 'Servicios',
  yes: 'Sí',
  no: 'No',
  serviceTypesLabel: 'Los servicios reciben y devuelven',
  serviceTypes: { entities: 'Las entidades', dtos: 'DTOs' },
  dtoKindLabel: 'DTOs como',
  dtoKinds: {
    pydantic: 'Modelos de Pydantic',
    dataclass: 'Dataclasses',
    interface: 'Interfaces',
    class: 'Clases',
    record: 'Records',
    readonly: 'Clases readonly',
    data: 'Data classes',
    struct: 'Structs',
  },
  updatesLabel: 'Las actualizaciones reciben',
  updatesModes: {
    partial: 'Los campos que cambian',
    patch: 'Patch<T> por campo',
    optional: 'Optional<T> por campo',
    full: 'Todos los campos (PUT)',
  },
  transactionsLabel: 'Transacciones',
  transactions: { operation: 'Una por operación', caller: 'Las de quien llama', repository: 'Una por escritura' },
  errorsLabel: 'Errores',
  errorStyles: { exceptions: 'Excepciones', results: 'Valores de resultado' },
  pagingLabel: 'Listas',
  pagings: { offset: 'Páginas (desplazamiento)', cursor: 'Páginas (cursor)', none: 'Todas las filas' },
  architectureLabel: 'Carpetas',
  architectures: { layer: 'Por capa', table: 'Por tabla' },
  verbsLabel: 'Lecturas con',
  verbs: { getFind: 'get / find', get: 'get', find: 'find' },
  interfacesLabel: 'Interfaces de repositorio',
  memoryLabel: 'Repositorios en memoria',
  testsLabel: 'Pruebas',
  testsModes: { all: 'Servicios y repositorios', services: 'Servicios', repositories: 'Repositorios', none: 'Ninguna' },
  experimental: 'experimental',
  stackVerified: 'Verificado: un proyecto con este lenguaje, librería, base de datos y código ha pasado sus pruebas en Docker.',
  stackNotVerified: 'Todavía sin verificar con esta base de datos y este código: revísalo antes de usarlo.',
  projectEmpty: 'Aquí aparecerán los archivos del proyecto generado.',
  fileLabel: (path) => `Contenido de ${path}`,
  copy: 'Copiar',
  copied: 'Copiado',
  // Hidden with its button in ProjectPane.tsx until CRUD2Controller is published
  // continueInCrud2Controller: 'Continuar en CRUD2Controller',
  downloadFile: 'Descargar archivo',
  downloadZip: (count) => `Descargar .zip (${es$(count)} ${plural(count, 'archivo', 'archivos')})`,
  todoCount: (count) => `${es$(count)} ${plural(count, 'marca', 'marcas')} TODO para ti`,
  status: {
    exact: 'Exacta',
    high: 'Alta',
    probable: 'Probable',
    review: 'Revisar',
    conflict: 'Conflicto',
    none: 'Ninguna',
    manual: 'Elegida por ti',
  },
  accept: 'Confirmar',
  acceptTitle: (subject) => `Confirmar la sugerencia para ${subject}`,
  reason: (reason) => {
    const params = reason.params
    switch (reason.code) {
      case 'primaryKey':
        return `La clave primaria (${p(params, 'columns')}) identifica cada fila.`
      case 'uniqueConstraint':
        return `${p(params, 'columns')} es único: como mucho una fila tiene cada valor.`
      case 'nestedList':
        return `«${p(params, 'column')}» es una lista dentro de cada documento: cambiar un elemento no deshace lo que otros cambien en el resto.`
      case 'indexOnly':
        return `Hay un índice en ${p(params, 'columns')}, pero puede existir solo por rendimiento: mantén la consulta si la aplicación busca filas por él.`
      case 'foreignKey':
        return `Cada fila apunta a una fila de ${p(params, 'table')}.`
      case 'readOnlyTable':
        return 'La tabla es de solo lectura.'
      case 'tableWithKey':
        return 'La tabla tiene clave primaria: sus filas se pueden leer, crear, cambiar y borrar.'
      case 'noPrimaryKey':
        return 'La tabla no tiene clave primaria: no se puede distinguir una fila de otra, así que solo se lee.'
      case 'joinTable':
        return `Solo relaciona ${p(params, 'tables')}: los vínculos se añaden y se quitan desde ellas.`
      case 'softDeleteColumn':
        return `«${p(params, 'column')}» indica que las filas se marcan como borradas en lugar de eliminarse.`
      case 'noSoftDeleteColumn':
        return 'Ninguna columna marca filas como borradas: borrar elimina la fila.'
      case 'versionColumn':
        return `«${p(params, 'column')}» cuenta versiones: se rechaza un cambio hecho sobre una versión antigua.`
      case 'noVersionColumn':
        return 'Ninguna columna cuenta versiones.'
      case 'childrenWithoutAction':
        return `Filas de ${p(params, 'tables')} apuntan aquí y la base de datos no hace nada al borrar: rechaza el borrado mientras existan, o bórralas antes.`
      case 'secretNamed':
        return `${p(params, 'columns')} parece un secreto: nunca se devuelve.`
      case 'noSecrets':
        return 'Ninguna columna parece un secreto.'
      case 'modelName':
        return `El modelo ${p(params, 'model')} tiene el nombre de la tabla.`
      case 'modelNames':
        return `Varios modelos tienen el nombre de la tabla (${p(params, 'models')}): elige el que recibe el servicio.`
      case 'noModel':
        return 'Ningún modelo tiene el nombre de la tabla: el servicio trabaja con la entidad.'
      case 'fieldName':
        return `El campo ${p(params, 'field')} tiene el nombre de la columna.`
      case 'fieldWords':
        return `El campo ${p(params, 'field')} tiene el nombre de la columna en otra convención.`
      case 'lookupUnique':
        return `${p(params, 'field')} nombra una fila de ${p(params, 'table')} por su ${p(params, 'column')}, que es único: el servicio busca la clave.`
      case 'lookupNotUnique':
        return `${p(params, 'field')} nombra una fila de ${p(params, 'table')} por su ${p(params, 'column')}, pero varias filas pueden tenerlo: revisa la búsqueda.`
      case 'generatedColumn':
        return 'La base de datos rellena la columna: el modelo no la envía.'
      case 'noFieldRequired':
        return 'Ningún campo rellena la columna, y necesita un valor: dale un campo o un valor por defecto.'
      case 'noField':
        return 'Ningún campo rellena la columna: se queda con su valor por defecto o nulo.'
      case 'childRows':
        return `${p(params, 'field')} enumera las filas de ${p(params, 'table')}.`
      case 'childTables':
        return `${p(params, 'field')} puede enumerar las filas de varias tablas (${p(params, 'tables')}): elige una.`
      case 'mapperModel':
        return `El proyecto de Mapper relaciona esta tabla con el modelo (${p(params, 'mapping')}).`
      case 'mapperField':
        return `Mapper relaciona la columna con ${p(params, 'fields')} (${p(params, 'transform')}), una relación que también sirve en el otro sentido.`
      case 'mapperOneWay':
        return `Mapper relaciona la columna con ${p(params, 'fields')} (${p(params, 'transform')}) en un solo sentido: el otro queda como TODO.`
      case 'mapperPending':
        return `Mapper propone ${p(params, 'fields')} (${p(params, 'transform')}), pero no se confirmó allí: revísalo.`
      case 'manual':
        return 'Lo has elegido tú.'
    }
  },
  inputSourcesLabel: 'Qué leer',
  inputSources: { database: 'Esquema de la base de datos', models: 'Modelos de aplicación' },
  modelsLabel: 'Modelos de aplicación',
  modelsPlaceholder:
    'Opcional: pega o abre los modelos de tu aplicación (clases, DTOs, records… en TypeScript, Python, Java, C#, Kotlin, Dart, Go, Rust, PHP, Swift, Scala; JSON, JSON Schema, OpenAPI, GraphQL…). Los servicios los recibirán y devolverán.',
  modelsEmpty: 'Sin modelos de aplicación: los servicios reciben y devuelven las entidades.',
  modelsError: (code) =>
    code === 'unknownFormat'
      ? 'DB2CRUD no lee el formato de estos modelos.'
      : code === 'noModels'
        ? 'Este texto no tiene ningún modelo.'
        : `No se pueden leer estos modelos (${code}).`,
  modelsSummary: (format, count) => `${format} · ${es$(count)} ${plural(count, 'modelo', 'modelos')}`,
  mapperSummary: (source, target) => `Proyecto de Mapper · ${source} → ${target}`,
  sourceMapper: (fields, transform, output) => `${output ? '→' : '←'} ${fields.join(' + ') || '—'} (Mapper: ${transform})`,
  modelTitles: { both: 'Modelo de aplicación', input: 'Modelo que se escribe', output: 'Modelo que se lee' },
  noModel: 'ninguno',
  sourceNone: 'sin campo',
  sourceField: (field) => `← ${field}`,
  sourceLookup: (field, table, by) => `← ${field}, buscado en ${table}.${by}`,
  targetField: (field) => `→ ${field}`,
  targetLookup: (field, table, by) => `→ ${field}, desde ${table}.${by}`,
  sourceDatabase: 'la rellena la base de datos',
  sourceChildren: (table) => (table ? `filas de ${table}` : 'ninguna tabla'),
  unusedFields: (fields, direction) => `${direction === 'output' ? 'No se rellenan' : 'No se guardan'}: ${fields.join(', ')}`,
  conflictLength: (model, column) => `el modelo admite ${es$(model)} caracteres; la columna, ${es$(column)}`,
  conflictNullable: 'opcional en el modelo, obligatoria en la columna',
  conflictNullableOutput: 'obligatorio en el modelo, la columna admite nulos',
  conflictType: (model, column) => `${model} en el modelo, ${column} en la columna`,
  conflictValues: (missing) => `la columna no admite ${missing.join(', ')}`,
  conflictUnknownValues: (values) => `el modelo no admite ${values.join(', ')}`,
  fileTreeLabel: 'Archivos generados',
}

/** Texts by language. */
export const messages: Record<Language, Messages> = { en, es }
