/**
 * Interface texts in English and Spanish.
 *
 * `en` defines the shape of the texts; `es` must have exactly the same keys, which the `Messages` type
 * checks. To add a text, add it to both. Texts that depend on a value are functions.
 */

import type { WorkspacePart } from '../app/workspaceParts.ts'
import type { Confidence, Reason } from '../core/decisions/decision.ts'
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
  workspaceParts: { models: 'Models' } satisfies Record<WorkspacePart, string>,
  examplesLabel: 'Try an example',
  examples: { store: 'Online shop', library: 'Library', catalog: 'JPA catalogue' } satisfies Record<ExampleId, string>,
  exampleDescriptions: {
    store: 'TypeScript interfaces: references, value objects, lists, an enum and a password',
    library: 'Pydantic models with lengths, ranges, a pattern and UUID keys',
    catalog: 'JPA entities with Bean Validation and a category tree',
  } satisfies Record<ExampleId, string>,
  confirmReplace: 'Your current models and the decisions made on them will be replaced. Continue?',

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
    switch (reason.code) {
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
  workspaceParts: { models: 'Modelos' },
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
    switch (reason.code) {
      case 'manual':
        return 'Lo has elegido tú.'
    }
  },
  fileTreeLabel: 'Archivos generados',
}

/** Texts by language. */
export const messages: Record<Language, Messages> = { en, es }
