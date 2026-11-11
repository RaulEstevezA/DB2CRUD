/**
 * Interface texts in English and Spanish.
 *
 * `en` defines the shape of the texts; `es` must have exactly the same keys, which the `Messages` type
 * checks. To add a text, add it to both. Texts that depend on a value are functions.
 */

import type { WorkspacePart } from '../app/workspaceParts.ts'
import type { Confidence, Reason } from '../core/decisions/decision.ts'
import type { ChildrenPolicy, OperationCheck, OperationDesign, PolicyDecisionKind, QueryKind, TableRole } from '../core/crud/types.ts'
import type { Model2DBReadError } from '../core/interop/model2db/read.ts'
import type { Dialect } from '../core/schema/types.ts'
import type {
  Architecture,
  DtoKind,
  EntitiesMode,
  ErrorStyle,
  Execution,
  LanguageId,
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
    'Paste or open your database schema (a Model2DB project, ORM code or SQL DDL) and, if you have them, your application models. DB2CRUD proposes the repositories, the services and any missing ORM entities, explains each proposal and lets you change it. Download the code with its tests.',
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
  inputPlaceholder: 'Paste a Model2DB project (the .model2db.json file Model2DB saves) or drop it here…',
  openFile: 'Open',
  clear: 'Clear',
  dropFile: 'Drop the file to open it',
  fileTooLarge: (name: string) => `“${name}” is larger than 10 MB.`,
  fileError: (name: string) => `“${name}” could not be read.`,
  inputEmpty: 'Paste or open a Model2DB project to start. SQL DDL and ORM code are coming.',
  warningsCount: (count: number) => `${en$(count)} ${plural(count, 'note', 'notes')}`,
  readError: (error: Model2DBReadError, path?: string): string =>
    ({
      notJson: 'It is not JSON: paste the .model2db.json file Model2DB saves.',
      notProject: 'It is not a Model2DB project.',
      newerVersion: 'The project was saved by a newer version of Model2DB.',
      invalid: `The project is damaged${path ? ` (${path})` : ''}.`,
      unreadableInput: 'The models inside the project cannot be read.',
      noModels: 'The project has no models.',
      notRelational: 'The project is for a database without tables (MongoDB, Redis, Cassandra…): not supported yet.',
    })[error],
  databaseSummary: (source: string, dialect: string | null, tables: number, columns: number) =>
    `Model2DB (${source}) · ${dialect ?? '?'} · ${en$(tables)} ${plural(tables, 'table', 'tables')} · ${en$(columns)} ${plural(columns, 'column', 'columns')}`,
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
  stackLabel: 'Language and ORM',
  languages: { python: 'Python', typescript: 'TypeScript' } satisfies Record<LanguageId, string>,
  databaseLabel: 'Database',
  databases: {
    postgresql: 'PostgreSQL',
    mysql: 'MySQL',
    mariadb: 'MariaDB',
    sqlite: 'SQLite',
    sqlserver: 'SQL Server',
    oracle: 'Oracle',
  } satisfies Record<Dialect, string>,
  executionLabel: 'Code',
  executions: { sync: 'Synchronous', async: 'Asynchronous' } satisfies Record<Execution, string>,
  entitiesLabel: 'Entities',
  entitiesModes: { missing: 'Only the missing ones', all: 'All, written again', none: 'None: import them' } satisfies Record<
    EntitiesMode,
    string
  >,
  entitiesModuleLabel: 'Module of the entities',
  servicesLabel: 'Services',
  yes: 'Yes',
  no: 'No',
  serviceTypesLabel: 'Services take and return',
  serviceTypes: { entities: 'The entities', dtos: 'DTOs' } satisfies Record<ServiceTypes, string>,
  dtoKindLabel: 'DTOs as',
  dtoKinds: { pydantic: 'Pydantic models', dataclass: 'Dataclasses', interface: 'Interfaces', class: 'Classes' } satisfies Record<
    DtoKind,
    string
  >,
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
  stackVerified: 'Verified: a project with this language, ORM, database and code has passed its tests in Docker.',
  stackNotVerified: 'Not verified yet with this database and code: review it before using it.',
  projectEmpty: 'The files of the generated project will appear here.',
  fileLabel: (path: string) => `Content of ${path}`,
  copy: 'Copy',
  copied: 'Copied',
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
      case 'manual':
        return 'You chose it.'
    }
  },
  fileTreeLabel: 'Generated files',
}

/** Every text of the interface in one language. */
export type Messages = typeof en

const es: Messages = {
  languageLabel: 'Idioma',
  processedLocally: 'Procesado en local',
  tagline: 'Genera los repositorios y servicios de una base de datos que ya tienes',
  introDescription:
    'Pega o abre el esquema de tu base de datos (un proyecto de Model2DB, código ORM o DDL de SQL) y, si los tienes, tus modelos de aplicación. DB2CRUD propone los repositorios, los servicios y las entidades ORM que falten, explica cada propuesta y te deja cambiarla. Descarga el código con sus pruebas.',
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
  inputPlaceholder: 'Pega un proyecto de Model2DB (el archivo .model2db.json que guarda Model2DB) o suéltalo aquí…',
  openFile: 'Abrir',
  clear: 'Limpiar',
  dropFile: 'Suelta el archivo para abrirlo',
  fileTooLarge: (name) => `«${name}» ocupa más de 10 MB.`,
  fileError: (name) => `No se ha podido leer «${name}».`,
  inputEmpty: 'Pega o abre un proyecto de Model2DB para empezar. El DDL de SQL y el código ORM llegarán después.',
  warningsCount: (count) => `${es$(count)} ${plural(count, 'nota', 'notas')}`,
  readError: (error, path) =>
    ({
      notJson: 'No es JSON: pega el archivo .model2db.json que guarda Model2DB.',
      notProject: 'No es un proyecto de Model2DB.',
      newerVersion: 'El proyecto se guardó con una versión más reciente de Model2DB.',
      invalid: `El proyecto está dañado${path ? ` (${path})` : ''}.`,
      unreadableInput: 'No se pueden leer los modelos del proyecto.',
      noModels: 'El proyecto no tiene modelos.',
      notRelational: 'El proyecto es para una base de datos sin tablas (MongoDB, Redis, Cassandra…): todavía no se admite.',
    })[error],
  databaseSummary: (source, dialect, tables, columns) =>
    `Model2DB (${source}) · ${dialect ?? '?'} · ${es$(tables)} ${plural(tables, 'tabla', 'tablas')} · ${es$(columns)} ${plural(columns, 'columna', 'columnas')}`,
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
  stackLabel: 'Lenguaje y ORM',
  languages: { python: 'Python', typescript: 'TypeScript' },
  databaseLabel: 'Base de datos',
  databases: { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite', sqlserver: 'SQL Server', oracle: 'Oracle' },
  executionLabel: 'Código',
  executions: { sync: 'Síncrono', async: 'Asíncrono' },
  entitiesLabel: 'Entidades',
  entitiesModes: { missing: 'Solo las que faltan', all: 'Todas, escritas de nuevo', none: 'Ninguna: se importan' },
  entitiesModuleLabel: 'Módulo de las entidades',
  servicesLabel: 'Servicios',
  yes: 'Sí',
  no: 'No',
  serviceTypesLabel: 'Los servicios reciben y devuelven',
  serviceTypes: { entities: 'Las entidades', dtos: 'DTOs' },
  dtoKindLabel: 'DTOs como',
  dtoKinds: { pydantic: 'Modelos de Pydantic', dataclass: 'Dataclasses', interface: 'Interfaces', class: 'Clases' },
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
  stackVerified: 'Verificado: un proyecto con este lenguaje, ORM, base de datos y código ha pasado sus pruebas en Docker.',
  stackNotVerified: 'Todavía sin verificar con esta base de datos y este código: revísalo antes de usarlo.',
  projectEmpty: 'Aquí aparecerán los archivos del proyecto generado.',
  fileLabel: (path) => `Contenido de ${path}`,
  copy: 'Copiar',
  copied: 'Copiado',
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
      case 'manual':
        return 'Lo has elegido tú.'
    }
  },
  fileTreeLabel: 'Archivos generados',
}

/** Texts by language. */
export const messages: Record<Language, Messages> = { en, es }
