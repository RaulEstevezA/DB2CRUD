/**
 * Interface texts in English and Spanish.
 *
 * `en` defines the shape of the texts; `es` must have exactly the same keys, which the `Messages` type
 * checks. To add a text, add it to both. Texts that depend on a value are functions.
 */

import type { WorkspacePart } from '../app/workspaceParts.ts'
import type { Constraints } from '../core/analysis/constraints.ts'
import type {
  AccessChoice,
  Confidence,
  CustomInput,
  CustomOutput,
  EndpointAccess,
  ExposeChoice,
  KeyChoice,
  Reason,
  RelationChoice,
  UnknownTypeChoice,
} from '../core/api/types.ts'
import type { DesignIssue } from '../core/validation/design.ts'
import type { ArchitectureId, AuthId, DatabaseId, LanguageId, PersistenceId } from '../core/compatibility/stack.ts'
import type { ProjectError } from '../core/project/project.ts'
import type { ParseIssue } from '../core/importers/types.ts'
import type { ExampleId } from '../examples/index.ts'

type Params = Record<string, string | number> | undefined
const p = (params: Params, key: string) => String(params?.[key] ?? '')

/** A number with the language's thousands separator. */
const number = (locale: string) => (value: number) => value.toLocaleString(locale)
const en$ = number('en')
const es$ = number('es')

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/** Errors of the JSON reader, by detail code. */
const JSON_DETAIL_EN: Record<string, string> = {
  'json.unexpectedEnd': 'The JSON ends too early: something is not closed.',
  'json.unexpectedCharacter': 'Unexpected character.',
  'json.trailingComma': 'Comma before the end of a list or object: remove it.',
  'json.invalidNumber': 'Invalid number: JSON does not allow leading zeros or a dot without decimals.',
  'json.invalidEscape': 'Unknown escape sequence.',
  'json.controlCharacter': 'Line break or tab inside a text: write it as \\n or \\t.',
  'json.trailingContent': 'There is more text after the end of the JSON.',
  'json.tooDeep': 'The JSON is nested too deeply.',
  modelSchema: 'This model schema is not valid.',
}

const JSON_DETAIL_ES: Record<string, string> = {
  'json.unexpectedEnd': 'El JSON termina antes de tiempo: algo no está cerrado.',
  'json.unexpectedCharacter': 'Carácter inesperado.',
  'json.trailingComma': 'Coma antes del final de una lista u objeto: quítala.',
  'json.invalidNumber': 'Número no válido: JSON no admite ceros a la izquierda ni un punto sin decimales.',
  'json.invalidEscape': 'Secuencia de escape desconocida.',
  'json.controlCharacter': 'Salto de línea o tabulador dentro de un texto: escríbelo como \\n o \\t.',
  'json.trailingContent': 'Hay más texto después del final del JSON.',
  'json.tooDeep': 'El JSON tiene demasiados niveles.',
  modelSchema: 'Este esquema de modelos no es válido.',
}

/** Languages of the interface, in the order the language switcher shows them. */
export const languages = ['en', 'es'] as const

export type Language = (typeof languages)[number]

const en = {
  languageLabel: 'Language',
  processedLocally: 'Processed locally',
  tagline: 'Turn data models into the code of a REST API you can run',
  introDescription:
    'Paste or open your models. Model2API proposes the endpoints of the API, explains each proposal and lets you change them. Choose the framework and download a project ready to run, with its tests and OpenAPI contract.',
  linksLabel: 'Downloads and links',
  downloadDesktop: 'Download for desktop',
  downloadFor: (platform: string) => `Download for ${platform}`,
  otherPlatforms: 'Other platforms',
  otherArchitecture: (architecture: string) => `${architecture} version`,
  downloadNote: 'Desktop version for Windows, macOS and Linux. It is not signed, so the first time your system will show a warning.',
  howToOpen: 'How to open it',
  howToOpenUrl: 'https://github.com/RaulEstevezA/Model2API/blob/main/desktop/README_en.md#opening-it-the-first-time',
  sourceCode: 'Source code',
  allTools: 'All tools',
  license: 'MIT License',
  workspaceLabel: 'Workspace',
  pendingCount: (count: number) => `${en$(count)} ${plural(count, 'item', 'items')} to review`,
  hasError: 'Something cannot be read',
  workspaceParts: { models: 'Models', endpoints: 'Endpoints', project: 'Project' } satisfies Record<WorkspacePart, string>,
  modelsEmpty: 'The models you paste or open will appear here.',
  endpointsEmpty: 'The proposed resources and endpoints will appear here once the models are read.',
  projectEmpty: 'The files of the generated project will appear here.',

  // Examples
  examplesLabel: 'Try an example',
  examples: { store: 'Online shop', library: 'Library', catalog: 'JPA catalogue' } satisfies Record<ExampleId, string>,
  exampleDescriptions: {
    store: 'TypeScript interfaces: references, value objects, lists, an enum and a password',
    library: 'Pydantic models with lengths, ranges, a pattern and UUID keys',
    catalog: 'JPA entities with Bean Validation and a category tree',
  } satisfies Record<ExampleId, string>,
  confirmReplace: 'Your current models and the decisions made on them will be replaced. Continue?',

  // Input
  inputLabel: 'Models to analyze',
  inputPlaceholder: 'Paste classes, DTOs, JSON or a schema here, or drop a file…',
  openFile: 'Open',
  clear: 'Clear',
  formatLabel: 'Format',
  formatAuto: (detected: string | null) => (detected ? `Detect (${detected})` : 'Detect automatically'),
  dropFile: 'Drop the file to open it',
  fileTooLarge: (name: string) => `“${name}” is larger than 10 MB.`,
  fileError: (name: string) => `“${name}” could not be read.`,
  receivedFrom: (tool: string) => `Models received from ${tool}.`,
  inputEmpty: 'Paste or open your models to start.',
  undetected: 'The format could not be detected: choose it in the list.',
  inputSummary: (format: string, models: number, fields: number) =>
    `${format} · ${en$(models)} ${plural(models, 'model', 'models')} · ${en$(fields)} ${plural(fields, 'field', 'fields')}`,
  warningsCount: (count: number) => `${en$(count)} ${plural(count, 'note', 'notes')}`,
  errorPosition: (line: number, column: number) => `Line ${en$(line)}, column ${en$(column)}`,
  parseIssue: (issue: ParseIssue): string => {
    const params = issue.params
    switch (issue.code) {
      case 'empty':
        return 'There is nothing to read.'
      case 'syntax':
        return params?.detail
          ? (JSON_DETAIL_EN[String(params.detail)] ?? String(params.detail)) + (params.path ? ` (${p(params, 'path')})` : '')
          : params?.message
            ? `It cannot be read as this format: ${p(params, 'message')}`
            : 'It cannot be read as this format.'
      case 'unexpectedToken':
        return `Unexpected “${p(params, 'token')}”.`
      case 'unterminatedString':
        return 'A text is not closed.'
      case 'unterminatedComment':
        return 'A comment is not closed.'
      case 'unclosedBlock':
        return 'A block is not closed: a “}” is missing.'
      case 'noModels':
        return 'No model was found. Check the format or paste the declarations.'
      case 'unknownType':
        return `“${p(params, 'type')}” is not declared here: you will choose its type.`
      case 'mixedTypes':
        return `“${p(params, 'field')}” has values of different types.`
      case 'duplicateField':
        return `“${p(params, 'field')}” is declared twice.`
      case 'duplicateModel':
        return `“${p(params, 'model')}” is declared twice.`
      case 'emptyModel':
        return `“${p(params, 'model')}” has no fields.`
      case 'truncatedRows':
        return `Only the first ${p(params, 'count')} rows were read.`
    }
  },
  // Endpoints pane
  undo: 'Undo',
  redo: 'Redo',
  reset: 'Reset',
  undoTitle: 'Undo (Ctrl/Cmd+Z)',
  redoTitle: 'Redo (Ctrl/Cmd+Shift+Z)',
  resetTitle: 'Back to the proposal: every choice you made is discarded',
  confirmReset: 'Every choice you made on this design will be discarded. Continue?',
  designSummary: (resources: number, endpoints: number) =>
    `${en$(resources)} ${plural(resources, 'resource', 'resources')} · ${en$(endpoints)} ${plural(endpoints, 'endpoint', 'endpoints')}`,
  issuesSummary: (errors: number, warnings: number) =>
    [
      errors > 0 && `${en$(errors)} ${plural(errors, 'endpoint left out of the code', 'problems leave endpoints out of the code')}`,
      warnings > 0 && `${en$(warnings)} ${plural(warnings, 'warning', 'warnings')}`,
    ]
      .filter(Boolean)
      .join(' · '),
  noResources: 'No model has endpoints of its own yet: make one of them a resource.',
  embeddedSection: 'Inside other resources',
  embeddedHint: 'These models have no endpoints: they travel inside the resources that contain them.',
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
      case 'entityDeclared':
        return 'The input declares it as a stored entity.'
      case 'hasKey':
        return `“${p(params, 'field')}” identifies it, so it gets endpoints of its own.`
      case 'standalone':
        return 'No other model contains it, so it gets endpoints of its own.'
      case 'valueObject':
        return `It has no key and “${p(params, 'model')}” contains it: it travels inside it.`
      case 'keyDeclared':
        return `The input declares “${p(params, 'field')}” as its key.`
      case 'keyNamed':
        return `“${p(params, 'field')}” is named like a key.`
      case 'keyCandidates':
        return `Fields that could identify it: ${p(params, 'fields')}.`
      case 'keyMissing':
        return 'The input declares no key: choose a field, or let the server generate one.'
      case 'targetIsResource':
        return `“${p(params, 'model')}” has endpoints of its own: the client sends its key.`
      case 'targetIsValue':
        return `“${p(params, 'model')}” has no endpoints of its own: it travels inside.`
      case 'selfReference':
        return 'It points to another item of the same resource: the client sends its key.'
      case 'listOfResources':
        return `A list of “${p(params, 'model')}”, which has endpoints of its own: the client sends their keys.`
      case 'keyGenerated':
        return 'The server assigns the key: clients only read it.'
      case 'keyFromClient':
        return 'The client chooses the key when it creates an item.'
      case 'generatedValue':
        return 'The input says it is generated: clients only read it.'
      case 'secretNamed':
        return 'Its name says it is a secret: clients send it but never read it.'
      case 'auditNamed':
        return 'A timestamp the server keeps: clients only read it.'
      case 'plainField':
        return 'Clients send it and read it.'
      case 'unknownType':
        return `The input does not define “${p(params, 'type')}”: choose how it travels.`
      case 'manual':
        return 'You chose it.'
    }
  },
  exposeLabel: 'Endpoints',
  keyLabel: 'Key',
  exposeSubject: (model: string) => `${model}: endpoints`,
  keySubject: (model: string) => `${model}: key`,
  accessSubject: (field: string) => `${field}: access`,
  relationSubject: (field: string) => `${field}: how it travels`,
  unknownTypeSubject: (field: string) => `${field}: type`,
  exposeOptions: { resource: 'A resource with endpoints', embedded: 'Only inside other resources' } satisfies Record<ExposeChoice, string>,
  keyOption: (value: KeyChoice) =>
    value.kind === 'field'
      ? `Field “${value.field}”`
      : value.type === 'uuid'
        ? 'A UUID the server generates'
        : 'A number the server generates',
  accessOptions: { readWrite: 'Send and read', readOnly: 'Read only', writeOnly: 'Send only' } satisfies Record<AccessChoice, string>,
  relationOptions: { reference: 'Its key', embedded: 'The whole item' } satisfies Record<RelationChoice, string>,
  unknownTypeOptions: { any: 'Any JSON value', string: 'Text' } satisfies Record<UnknownTypeChoice, string>,
  resourcePathLabel: (model: string) => `Path of ${model}`,
  fieldsSummary: (total: number, included: number) =>
    included === total ? `${en$(total)} ${plural(total, 'field', 'fields')}` : `${en$(included)} of ${en$(total)} fields in the API`,
  endpointsCount: (enabled: number, total: number) => `${en$(enabled)} of ${en$(total)} endpoints on`,
  fieldInclude: 'In the API',
  fieldName: 'Field',
  fieldAccess: 'Clients can',
  fieldTravels: 'Travels as',
  fieldValidations: 'Validations',
  includeField: (field: string) => `Include “${field}” in the API`,
  keyAlwaysIncluded: 'The key is always in the API',
  keyBadge: 'key',
  travelsAsValue: 'Its value',
  describeConstraints: (c: Constraints): string => {
    const parts: string[] = []
    if (c.minLength !== undefined || c.maxLength !== undefined)
      parts.push(
        c.maxLength === undefined
          ? `≥ ${c.minLength} chars`
          : c.minLength === undefined
            ? `≤ ${c.maxLength} chars`
            : `${c.minLength}–${c.maxLength} chars`,
      )
    if (c.minItems !== undefined || c.maxItems !== undefined)
      parts.push(
        c.maxItems === undefined
          ? `≥ ${c.minItems} items`
          : c.minItems === undefined
            ? `≤ ${c.maxItems} items`
            : `${c.minItems}–${c.maxItems} items`,
      )
    if (c.minimum !== undefined) parts.push(`≥ ${c.minimum}`)
    if (c.exclusiveMinimum !== undefined) parts.push(`> ${c.exclusiveMinimum}`)
    if (c.maximum !== undefined) parts.push(`≤ ${c.maximum}`)
    if (c.exclusiveMaximum !== undefined) parts.push(`< ${c.exclusiveMaximum}`)
    if (c.format) parts.push(c.format)
    if (c.pattern) parts.push(`/${c.pattern}/`)
    return parts.join(' · ') || '—'
  },
  enableEndpoint: (endpoint: string) => `Generate ${endpoint}`,
  customBadge: 'business',
  endpointOff: 'off',
  notGenerated: 'not generated',
  edit: 'Edit',
  done: 'Done',
  addEndpoint: 'Add a business endpoint',
  removeEndpoint: 'Remove',
  methodLabel: 'Method',
  pathLabel: 'Path',
  nameLabel: 'Operation name',
  summaryLabel: 'Summary (in the code, in English)',
  accessLabel: 'Who may call it',
  endpointAccess: {
    default: 'Project default',
    public: 'Anyone',
    authenticated: 'Clients with credentials',
    roles: 'Some roles',
  } satisfies Record<EndpointAccess, string>,
  rolesLabel: 'Roles, separated by commas',
  statusLabel: 'Success status',
  statusDefault: 'Usual one',
  inputBodyLabel: 'Body',
  outputLabel: 'Returns',
  customInput: { none: 'Nothing', resource: 'A whole item', partial: 'Some fields' } satisfies Record<CustomInput, string>,
  customOutput: { none: 'Nothing', resource: 'The item', list: 'A list of items' } satisfies Record<CustomOutput, string>,
  paginationLabel: 'In pages (page and size)',
  filtersLabel: 'Filters',
  sortLabel: 'Sort by',
  accessNeedsAuth: 'The project has no authentication: this protection has no effect until you choose one.',
  customNote: 'The code gets the route and a service method marked with TODO; it answers 501 until you write its logic.',
  issue: (issue: DesignIssue): string => {
    const params = issue.params
    switch (issue.code) {
      case 'duplicateRoute':
        return `Same method and path as ${p(params, 'other')}: change one of them.`
      case 'duplicateName':
        return `Same operation name as ${p(params, 'other')}: names must be unique.`
      case 'invalidName':
        return `“${p(params, 'name')}” cannot be an operation name: use letters, digits and “_”, not starting with a digit.`
      case 'invalidPath':
        return `“${p(params, 'path')}” is not a valid path: segments of letters, digits, “-”, “_” and “.”, and each {parameter} once.`
      case 'missingKeyParam':
        return `The path needs {${p(params, 'param')}} to know which item.`
      case 'unexpectedParam':
        return `This operation cannot use {${p(params, 'params')}} in its path.`
      case 'invalidFilter':
        return `These fields cannot be filtered: ${p(params, 'fields')}.`
      case 'invalidSort':
        return `These fields cannot be sorted by: ${p(params, 'fields')}.`
      case 'noRoles':
        return 'Write at least one role, or choose another access.'
      case 'bodyOnGet':
        return 'A GET request has no body: choose another method or no body.'
      case 'invalidStatus':
        return `${p(params, 'status')} is not a success status: use one from 200 to 299.`
      case 'protectionIgnored':
        return params?.auth === 'apiKey'
          ? 'API keys carry no roles: any valid key can call it.'
          : 'The project has no authentication: anyone can call it.'
      case 'noEndpoints':
        return 'Every endpoint is off: the resource has no routes.'
    }
  },
  // Project pane
  projectName: 'Project name',
  frameworkLabel: 'Framework',
  languages: {
    python: 'Python',
    typescript: 'TypeScript',
    java: 'Java',
    php: 'PHP',
    csharp: 'C#',
    kotlin: 'Kotlin',
    rust: 'Rust',
    swift: 'Swift',
  } satisfies Record<LanguageId, string>,
  notWrittenYet: (framework: string) => `${framework} · not available yet`,
  architectureLabel: 'Architecture',
  architectures: { layered: 'By layers', modular: 'One folder per resource' } satisfies Record<ArchitectureId, string>,
  persistenceLabel: 'Storage',
  persistence: {
    memory: 'In memory, to try it',
    none: 'Interfaces to implement',
    sqlalchemy: 'SQLAlchemy',
    djangoOrm: 'Django ORM',
    prisma: 'Prisma',
    mongoose: 'Mongoose',
    typeorm: 'TypeORM',
    jpa: 'JPA / Hibernate',
    eloquent: 'Eloquent',
    doctrine: 'Doctrine ORM',
    efCore: 'Entity Framework Core',
    exposed: 'Exposed',
    seaOrm: 'SeaORM',
    fluent: 'Fluent',
  } satisfies Record<PersistenceId, string>,
  databaseLabel: 'Database',
  databases: { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite', mongodb: 'MongoDB' } satisfies Record<
    DatabaseId,
    string
  >,
  authLabel: 'Authentication',
  auth: { none: 'None: every endpoint is public', apiKey: 'API key (X-API-Key)', jwt: 'JWT bearer token' } satisfies Record<AuthId, string>,
  defaultAccessLabel: 'By default, endpoints are for',
  javaPackageLabel: 'JVM package',
  fileTreeLabel: 'Generated files',
  fileLabel: (path: string) => `Content of ${path}`,
  copy: 'Copy',
  copied: 'Copied',
  downloadFile: 'Download file',
  downloadOpenApi: 'OpenAPI',
  downloadZip: (count: number) => `Download .zip (${en$(count)} ${plural(count, 'file', 'files')})`,
  todoCount: (count: number) => `${en$(count)} TODO ${plural(count, 'mark', 'marks')} left for you`,
  // Projects
  projectActions: 'Project file',
  openProject: 'Open project',
  saveProject: 'Save project',
  remember: 'Remember in this browser',
  rememberHint:
    'Keeps your models, decisions and settings in this browser only, so you can continue another day. Nothing is sent anywhere.',
  clearSaved: 'Delete the saved work',
  clearSavedConfirm: 'The work kept in this browser will be deleted. Continue?',
  restored: 'Your work kept in this browser has been restored.',
  savedCleared: 'The work kept in this browser has been deleted.',
  projectLoaded: (name: string) => `“${name}” opened.`,
  projectError: (error: ProjectError) =>
    ({
      notJson: 'The file is not a Model2API project: it is not JSON.',
      notProject: 'The file is not a Model2API project.',
      newerVersion: 'The project was saved by a newer version of Model2API.',
      noInput: 'The project holds no models.',
    })[error],
}

/** Every text of the interface in one language. */
export type Messages = typeof en

const es: Messages = {
  languageLabel: 'Idioma',
  processedLocally: 'Procesado en local',
  tagline: 'Convierte modelos de datos en el código de una API REST que puedes ejecutar',
  introDescription:
    'Pega o abre tus modelos. Model2API propone los endpoints de la API, explica cada propuesta y te deja cambiarlos. Elige el framework y descarga un proyecto listo para ejecutar, con sus pruebas y su contrato OpenAPI.',
  linksLabel: 'Descargas y enlaces',
  downloadDesktop: 'Descargar para escritorio',
  downloadFor: (platform) => `Descargar para ${platform}`,
  otherPlatforms: 'Otras plataformas',
  otherArchitecture: (architecture) => `Versión ${architecture}`,
  downloadNote: 'Versión de escritorio para Windows, macOS y Linux. No está firmada, así que la primera vez el sistema mostrará un aviso.',
  howToOpen: 'Cómo abrirla',
  howToOpenUrl: 'https://github.com/RaulEstevezA/Model2API/blob/main/desktop/README_es.md#abrirla-la-primera-vez',
  sourceCode: 'Código fuente',
  allTools: 'Todas las herramientas',
  license: 'Licencia MIT',
  workspaceLabel: 'Área de trabajo',
  pendingCount: (count) => `${es$(count)} ${plural(count, 'elemento', 'elementos')} por revisar`,
  hasError: 'Hay algo que no se puede leer',
  workspaceParts: { models: 'Modelos', endpoints: 'Endpoints', project: 'Proyecto' },
  modelsEmpty: 'Los modelos que pegues o abras aparecerán aquí.',
  endpointsEmpty: 'Los recursos y endpoints propuestos aparecerán aquí cuando se lean los modelos.',
  projectEmpty: 'Los archivos del proyecto generado aparecerán aquí.',

  examplesLabel: 'Prueba un ejemplo',
  examples: { store: 'Tienda online', library: 'Biblioteca', catalog: 'Catálogo JPA' },
  exampleDescriptions: {
    store: 'Interfaces de TypeScript: referencias, objetos de valor, listas, un enum y una contraseña',
    library: 'Modelos de Pydantic con longitudes, rangos, un patrón y claves UUID',
    catalog: 'Entidades JPA con Bean Validation y un árbol de categorías',
  },
  confirmReplace: 'Se sustituirán tus modelos actuales y las decisiones tomadas sobre ellos. ¿Continuar?',

  inputLabel: 'Modelos para analizar',
  inputPlaceholder: 'Pega aquí clases, DTOs, JSON o un esquema, o suelta un archivo…',
  openFile: 'Abrir',
  clear: 'Limpiar',
  formatLabel: 'Formato',
  formatAuto: (detected) => (detected ? `Detectar (${detected})` : 'Detectar automáticamente'),
  dropFile: 'Suelta el archivo para abrirlo',
  fileTooLarge: (name) => `«${name}» supera los 10 MB.`,
  fileError: (name) => `«${name}» no se ha podido leer.`,
  receivedFrom: (tool) => `Modelos recibidos de ${tool}.`,
  inputEmpty: 'Pega o abre tus modelos para empezar.',
  undetected: 'No se ha podido detectar el formato: elígelo en la lista.',
  inputSummary: (format, models, fields) =>
    `${format} · ${es$(models)} ${plural(models, 'modelo', 'modelos')} · ${es$(fields)} ${plural(fields, 'campo', 'campos')}`,
  warningsCount: (count) => `${es$(count)} ${plural(count, 'nota', 'notas')}`,
  errorPosition: (line, column) => `Línea ${es$(line)}, columna ${es$(column)}`,
  parseIssue: (issue) => {
    const params = issue.params
    switch (issue.code) {
      case 'empty':
        return 'No hay nada que leer.'
      case 'syntax':
        return params?.detail
          ? (JSON_DETAIL_ES[String(params.detail)] ?? String(params.detail)) + (params.path ? ` (${p(params, 'path')})` : '')
          : params?.message
            ? `No se puede leer con este formato: ${p(params, 'message')}`
            : 'No se puede leer con este formato.'
      case 'unexpectedToken':
        return `No se esperaba «${p(params, 'token')}».`
      case 'unterminatedString':
        return 'Hay un texto sin cerrar.'
      case 'unterminatedComment':
        return 'Hay un comentario sin cerrar.'
      case 'unclosedBlock':
        return 'Hay un bloque sin cerrar: falta una «}».'
      case 'noModels':
        return 'No se ha encontrado ningún modelo. Revisa el formato o pega las declaraciones.'
      case 'unknownType':
        return `«${p(params, 'type')}» no está declarado aquí: elegirás su tipo.`
      case 'mixedTypes':
        return `«${p(params, 'field')}» tiene valores de tipos distintos.`
      case 'duplicateField':
        return `«${p(params, 'field')}» está declarado dos veces.`
      case 'duplicateModel':
        return `«${p(params, 'model')}» está declarado dos veces.`
      case 'emptyModel':
        return `«${p(params, 'model')}» no tiene campos.`
      case 'truncatedRows':
        return `Solo se han leído las primeras ${p(params, 'count')} filas.`
    }
  },
  undo: 'Deshacer',
  redo: 'Rehacer',
  reset: 'Restablecer',
  undoTitle: 'Deshacer (Ctrl/Cmd+Z)',
  redoTitle: 'Rehacer (Ctrl/Cmd+Mayús+Z)',
  resetTitle: 'Volver a la propuesta: se descartan todas tus elecciones',
  confirmReset: 'Se descartarán todas las elecciones que has hecho en este diseño. ¿Continuar?',
  designSummary: (resources, endpoints) =>
    `${es$(resources)} ${plural(resources, 'recurso', 'recursos')} · ${es$(endpoints)} ${plural(endpoints, 'endpoint', 'endpoints')}`,
  issuesSummary: (errors, warnings) =>
    [
      errors > 0 &&
        `${es$(errors)} ${plural(errors, 'problema deja un endpoint fuera del código', 'problemas dejan endpoints fuera del código')}`,
      warnings > 0 && `${es$(warnings)} ${plural(warnings, 'aviso', 'avisos')}`,
    ]
      .filter(Boolean)
      .join(' · '),
  noResources: 'Ningún modelo tiene todavía endpoints propios: convierte alguno en recurso.',
  embeddedSection: 'Dentro de otros recursos',
  embeddedHint: 'Estos modelos no tienen endpoints: viajan dentro de los recursos que los contienen.',
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
      case 'entityDeclared':
        return 'La entrada lo declara como entidad almacenada.'
      case 'hasKey':
        return `«${p(params, 'field')}» lo identifica, así que tiene endpoints propios.`
      case 'standalone':
        return 'Ningún otro modelo lo contiene, así que tiene endpoints propios.'
      case 'valueObject':
        return `No tiene clave y «${p(params, 'model')}» lo contiene: viaja dentro de él.`
      case 'keyDeclared':
        return `La entrada declara «${p(params, 'field')}» como su clave.`
      case 'keyNamed':
        return `«${p(params, 'field')}» tiene nombre de clave.`
      case 'keyCandidates':
        return `Campos que podrían identificarlo: ${p(params, 'fields')}.`
      case 'keyMissing':
        return 'La entrada no declara clave: elige un campo o deja que el servidor genere una.'
      case 'targetIsResource':
        return `«${p(params, 'model')}» tiene endpoints propios: el cliente envía su clave.`
      case 'targetIsValue':
        return `«${p(params, 'model')}» no tiene endpoints propios: viaja dentro.`
      case 'selfReference':
        return 'Apunta a otro elemento del mismo recurso: el cliente envía su clave.'
      case 'listOfResources':
        return `Una lista de «${p(params, 'model')}», que tiene endpoints propios: el cliente envía sus claves.`
      case 'keyGenerated':
        return 'El servidor asigna la clave: los clientes solo la leen.'
      case 'keyFromClient':
        return 'El cliente elige la clave al crear un elemento.'
      case 'generatedValue':
        return 'La entrada dice que se genera: los clientes solo lo leen.'
      case 'secretNamed':
        return 'Su nombre dice que es un secreto: los clientes lo envían pero nunca lo leen.'
      case 'auditNamed':
        return 'Una marca de tiempo que mantiene el servidor: los clientes solo la leen.'
      case 'plainField':
        return 'Los clientes lo envían y lo leen.'
      case 'unknownType':
        return `La entrada no define «${p(params, 'type')}»: elige cómo viaja.`
      case 'manual':
        return 'Lo has elegido tú.'
    }
  },
  exposeLabel: 'Endpoints',
  keyLabel: 'Clave',
  exposeSubject: (model) => `${model}: endpoints`,
  keySubject: (model) => `${model}: clave`,
  accessSubject: (field) => `${field}: acceso`,
  relationSubject: (field) => `${field}: cómo viaja`,
  unknownTypeSubject: (field) => `${field}: tipo`,
  exposeOptions: { resource: 'Un recurso con endpoints', embedded: 'Solo dentro de otros recursos' },
  keyOption: (value) =>
    value.kind === 'field'
      ? `Campo «${value.field}»`
      : value.type === 'uuid'
        ? 'Un UUID que genera el servidor'
        : 'Un número que genera el servidor',
  accessOptions: { readWrite: 'Enviar y leer', readOnly: 'Solo leer', writeOnly: 'Solo enviar' },
  relationOptions: { reference: 'Su clave', embedded: 'El elemento completo' },
  unknownTypeOptions: { any: 'Cualquier valor JSON', string: 'Texto' },
  resourcePathLabel: (model) => `Ruta de ${model}`,
  fieldsSummary: (total, included) =>
    included === total ? `${es$(total)} ${plural(total, 'campo', 'campos')}` : `${es$(included)} de ${es$(total)} campos en la API`,
  endpointsCount: (enabled, total) => `${es$(enabled)} de ${es$(total)} endpoints activos`,
  fieldInclude: 'En la API',
  fieldName: 'Campo',
  fieldAccess: 'Los clientes pueden',
  fieldTravels: 'Viaja como',
  fieldValidations: 'Validaciones',
  includeField: (field) => `Incluir «${field}» en la API`,
  keyAlwaysIncluded: 'La clave siempre está en la API',
  keyBadge: 'clave',
  travelsAsValue: 'Su valor',
  describeConstraints: (c) => {
    const parts: string[] = []
    if (c.minLength !== undefined || c.maxLength !== undefined)
      parts.push(
        c.maxLength === undefined
          ? `≥ ${c.minLength} car.`
          : c.minLength === undefined
            ? `≤ ${c.maxLength} car.`
            : `${c.minLength}–${c.maxLength} car.`,
      )
    if (c.minItems !== undefined || c.maxItems !== undefined)
      parts.push(
        c.maxItems === undefined
          ? `≥ ${c.minItems} elem.`
          : c.minItems === undefined
            ? `≤ ${c.maxItems} elem.`
            : `${c.minItems}–${c.maxItems} elem.`,
      )
    if (c.minimum !== undefined) parts.push(`≥ ${c.minimum}`)
    if (c.exclusiveMinimum !== undefined) parts.push(`> ${c.exclusiveMinimum}`)
    if (c.maximum !== undefined) parts.push(`≤ ${c.maximum}`)
    if (c.exclusiveMaximum !== undefined) parts.push(`< ${c.exclusiveMaximum}`)
    if (c.format) parts.push(c.format)
    if (c.pattern) parts.push(`/${c.pattern}/`)
    return parts.join(' · ') || '—'
  },
  enableEndpoint: (endpoint) => `Generar ${endpoint}`,
  customBadge: 'negocio',
  endpointOff: 'desactivado',
  notGenerated: 'no se genera',
  edit: 'Editar',
  done: 'Hecho',
  addEndpoint: 'Añadir un endpoint de negocio',
  removeEndpoint: 'Quitar',
  methodLabel: 'Método',
  pathLabel: 'Ruta',
  nameLabel: 'Nombre de la operación',
  summaryLabel: 'Resumen (en el código, en inglés)',
  accessLabel: 'Quién puede llamarlo',
  endpointAccess: { default: 'Lo del proyecto', public: 'Cualquiera', authenticated: 'Clientes con credenciales', roles: 'Algunos roles' },
  rolesLabel: 'Roles, separados por comas',
  statusLabel: 'Estado de éxito',
  statusDefault: 'El habitual',
  inputBodyLabel: 'Cuerpo',
  outputLabel: 'Devuelve',
  customInput: { none: 'Nada', resource: 'Un elemento completo', partial: 'Algunos campos' },
  customOutput: { none: 'Nada', resource: 'El elemento', list: 'Una lista de elementos' },
  paginationLabel: 'Por páginas (page y size)',
  filtersLabel: 'Filtros',
  sortLabel: 'Ordenar por',
  accessNeedsAuth: 'El proyecto no tiene autenticación: esta protección no tiene efecto hasta que elijas una.',
  customNote: 'El código recibe la ruta y un método del servicio marcado con TODO; responde 501 hasta que escribas su lógica.',
  issue: (issue) => {
    const params = issue.params
    switch (issue.code) {
      case 'duplicateRoute':
        return `Mismo método y ruta que ${p(params, 'other')}: cambia uno de los dos.`
      case 'duplicateName':
        return `Mismo nombre de operación que ${p(params, 'other')}: los nombres no se pueden repetir.`
      case 'invalidName':
        return `«${p(params, 'name')}» no puede ser un nombre de operación: usa letras, dígitos y «_», sin empezar por un dígito.`
      case 'invalidPath':
        return `«${p(params, 'path')}» no es una ruta válida: segmentos de letras, dígitos, «-», «_» y «.», y cada {parámetro} una vez.`
      case 'missingKeyParam':
        return `La ruta necesita {${p(params, 'param')}} para saber de qué elemento se trata.`
      case 'unexpectedParam':
        return `Esta operación no puede usar {${p(params, 'params')}} en su ruta.`
      case 'invalidFilter':
        return `Estos campos no se pueden filtrar: ${p(params, 'fields')}.`
      case 'invalidSort':
        return `No se puede ordenar por estos campos: ${p(params, 'fields')}.`
      case 'noRoles':
        return 'Escribe al menos un rol o elige otro acceso.'
      case 'bodyOnGet':
        return 'Una petición GET no tiene cuerpo: elige otro método o ningún cuerpo.'
      case 'invalidStatus':
        return `${p(params, 'status')} no es un estado de éxito: usa uno entre 200 y 299.`
      case 'protectionIgnored':
        return params?.auth === 'apiKey'
          ? 'Las claves de API no llevan roles: cualquier clave válida puede llamarlo.'
          : 'El proyecto no tiene autenticación: cualquiera puede llamarlo.'
      case 'noEndpoints':
        return 'Todos los endpoints están desactivados: el recurso no tiene rutas.'
    }
  },
  projectName: 'Nombre del proyecto',
  frameworkLabel: 'Framework',
  languages: {
    python: 'Python',
    typescript: 'TypeScript',
    java: 'Java',
    php: 'PHP',
    csharp: 'C#',
    kotlin: 'Kotlin',
    rust: 'Rust',
    swift: 'Swift',
  },
  notWrittenYet: (framework) => `${framework} · todavía no disponible`,
  architectureLabel: 'Arquitectura',
  architectures: { layered: 'Por capas', modular: 'Una carpeta por recurso' },
  persistenceLabel: 'Almacenamiento',
  persistence: {
    memory: 'En memoria, para probarla',
    none: 'Interfaces por implementar',
    sqlalchemy: 'SQLAlchemy',
    djangoOrm: 'Django ORM',
    prisma: 'Prisma',
    mongoose: 'Mongoose',
    typeorm: 'TypeORM',
    jpa: 'JPA / Hibernate',
    eloquent: 'Eloquent',
    doctrine: 'Doctrine ORM',
    efCore: 'Entity Framework Core',
    exposed: 'Exposed',
    seaOrm: 'SeaORM',
    fluent: 'Fluent',
  },
  databaseLabel: 'Base de datos',
  databases: { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite', mongodb: 'MongoDB' },
  authLabel: 'Autenticación',
  auth: { none: 'Ninguna: todos los endpoints son públicos', apiKey: 'Clave de API (X-API-Key)', jwt: 'Token JWT (bearer)' },
  defaultAccessLabel: 'Por defecto, los endpoints son para',
  javaPackageLabel: 'Paquete JVM',
  fileTreeLabel: 'Archivos generados',
  fileLabel: (path) => `Contenido de ${path}`,
  copy: 'Copiar',
  copied: 'Copiado',
  downloadFile: 'Descargar archivo',
  downloadOpenApi: 'OpenAPI',
  downloadZip: (count) => `Descargar .zip (${es$(count)} ${plural(count, 'archivo', 'archivos')})`,
  todoCount: (count) => `${es$(count)} ${plural(count, 'marca', 'marcas')} TODO para ti`,
  projectActions: 'Archivo de proyecto',
  openProject: 'Abrir proyecto',
  saveProject: 'Guardar proyecto',
  remember: 'Recordar en este navegador',
  rememberHint: 'Guarda tus modelos, decisiones y ajustes solo en este navegador, para seguir otro día. No se envía nada a ningún sitio.',
  clearSaved: 'Borrar el trabajo guardado',
  clearSavedConfirm: 'Se borrará el trabajo guardado en este navegador. ¿Continuar?',
  restored: 'Se ha recuperado el trabajo guardado en este navegador.',
  savedCleared: 'Se ha borrado el trabajo guardado en este navegador.',
  projectLoaded: (name) => `«${name}» abierto.`,
  projectError: (error) =>
    ({
      notJson: 'El archivo no es un proyecto de Model2API: no es JSON.',
      notProject: 'El archivo no es un proyecto de Model2API.',
      newerVersion: 'El proyecto se guardó con una versión más reciente de Model2API.',
      noInput: 'El proyecto no contiene modelos.',
    })[error],
}

/** Texts by language. */
export const messages: Record<Language, Messages> = { en, es }
