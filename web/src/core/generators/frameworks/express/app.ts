/**
 * Application modules of the Express project that do not belong to one resource: configuration from the
 * environment, the error format and its middleware, authentication, list queries, and the application
 * factory that wires repositories, services and routes.
 */
import { GENERAL_ERROR_CODES } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { TsImports, tsDoc, tsString } from '../../languages/typescript/typescript.ts'
import { importPath, names, type ExpressContext } from './context.ts'
import { referencedResources } from './routes.ts'

export function configFile(context: ExpressContext): GeneratedFile {
  const { auth } = context.settings
  const content = lines(
    tsDoc('Configuration read from the environment. Nothing secret has a default: see .env.example.'),
    '',
    'export interface Settings {',
    '  port: number',
    auth === 'apiKey' && '  /** Accepted API keys; without any, every protected request is rejected */\n  apiKeys: string[]',
    auth === 'jwt' && [
      '  /** Secret that signs the tokens; without it, every protected request is rejected */',
      '  jwtSecret: string',
      "  jwtAlgorithm: 'HS256' | 'HS384' | 'HS512'",
      '  jwtAudience?: string',
      '  jwtIssuer?: string',
    ],
    '}',
    '',
    '/** Reads the settings on every call, so a changed environment (tests, reloads) is always seen. */',
    'export function getSettings(): Settings {',
    '  return {',
    '    port: Number(process.env.PORT ?? 3000),',
    auth === 'apiKey' && "    apiKeys: (process.env.API_KEYS ?? '').split(',').map((key) => key.trim()).filter(Boolean),",
    auth === 'jwt' && [
      "    jwtSecret: process.env.JWT_SECRET ?? '',",
      "    jwtAlgorithm: (process.env.JWT_ALGORITHM ?? 'HS256') as Settings['jwtAlgorithm'],",
      '    jwtAudience: process.env.JWT_AUDIENCE || undefined,',
      '    jwtIssuer: process.env.JWT_ISSUER || undefined,',
    ],
    '  }',
    '}',
  )
  return { path: 'src/config.ts', content: fileText(content) }
}

export function errorsFile(): GeneratedFile {
  const content = lines(
    tsDoc('One error format for the whole API: {"error": {"code", "message", "details"}}, as described in openapi.yaml.'),
    '',
    "import type { ErrorRequestHandler, RequestHandler } from 'express'",
    "import { ZodError } from 'zod'",
    '',
    'export interface ErrorDetail {',
    '  field: string',
    '  message: string',
    '}',
    '',
    '/** An error the API answers with a status, a code and a message. */',
    'export class ApiError extends Error {',
    '  constructor(',
    '    readonly status: number,',
    '    readonly code: string,',
    '    message: string,',
    '    readonly details?: ErrorDetail[],',
    '  ) {',
    '    super(message)',
    '  }',
    '}',
    '',
    '/** Thrown by code still to write: the API answers 501. */',
    'export class NotImplementedError extends Error {}',
    '',
    "export const invalid = (field: string, message: string) => new ApiError(400, 'validation_error', 'The request is not valid', [{ field, message }])",
    "export const unauthorized = () => new ApiError(401, 'unauthorized', 'Missing or invalid credentials')",
    "export const forbidden = () => new ApiError(403, 'forbidden', 'The credentials do not allow this operation')",
    "export const notFound = (what: string) => new ApiError(404, 'not_found', `No ${what} has this key`)",
    "export const conflict = (message: string) => new ApiError(409, 'conflict', message)",
    '',
    'export function errorBody(code: string, message: string, details?: ErrorDetail[]) {',
    '  return { error: { code, message, ...(details && details.length > 0 ? { details } : {}) } }',
    '}',
    '',
    '/** Answers routes that do not exist with the common format. */',
    'export const unknownRoute: RequestHandler = (_request, response) => {',
    "  response.status(404).json(errorBody('not_found', 'No route matches this request'))",
    '}',
    '',
    '/** Answers every error with the common format and the status of openapi.yaml. */',
    'export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {',
    '  if (error instanceof ApiError) {',
    '    response.status(error.status).json(errorBody(error.code, error.message, error.details))',
    '    return',
    '  }',
    '  if (error instanceof ZodError) {',
    "    const details = error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message }))",
    "    response.status(400).json(errorBody('validation_error', 'The request is not valid', details))",
    '    return',
    '  }',
    '  if (error instanceof NotImplementedError) {',
    "    response.status(501).json(errorBody('not_implemented', error.message || 'The logic of this operation is not written yet'))",
    '    return',
    '  }',
    "  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed') {",
    "    response.status(400).json(errorBody('validation_error', 'The body is not valid JSON'))",
    '    return',
    '  }',
    '  console.error(error)',
    `  response.status(500).json(errorBody(${tsString(GENERAL_ERROR_CODES[1])}, 'Something went wrong on the server'))`,
    '}',
  )
  return { path: 'src/errors.ts', content: fileText(content) }
}

export function securityFile(context: ExpressContext): GeneratedFile | null {
  const { auth } = context.settings
  if (auth === 'none') return null
  if (auth === 'apiKey') {
    const content = lines(
      tsDoc('API key authentication: the key in the X-API-Key header must be one of API_KEYS.'),
      '',
      "import { timingSafeEqual } from 'node:crypto'",
      "import type { RequestHandler } from 'express'",
      "import { getSettings } from './config.js'",
      "import { unauthorized } from './errors.js'",
      '',
      '/** Compares in constant time, so the answer time says nothing about the key. */',
      'function same(a: string, b: string): boolean {',
      '  const left = Buffer.from(a)',
      '  const right = Buffer.from(b)',
      '  return left.length === right.length && timingSafeEqual(left, right)',
      '}',
      '',
      '/** Lets the request through only with a configured key. Without API_KEYS, every request is rejected. */',
      'export const requireApiKey: RequestHandler = (request, _response, next) => {',
      "  const key = request.header('X-API-Key')",
      '  if (!key || !getSettings().apiKeys.some((valid) => same(key, valid))) throw unauthorized()',
      '  next()',
      '}',
    )
    return { path: 'src/security.ts', content: fileText(content) }
  }
  const content = lines(
    tsDoc(
      'Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them\nwith JWT_SECRET (and JWT_AUDIENCE / JWT_ISSUER when set) and reads the roles from the "roles" claim.',
    ),
    '',
    "import type { Request, RequestHandler } from 'express'",
    "import jwt from 'jsonwebtoken'",
    "import { getSettings } from './config.js'",
    "import { forbidden, unauthorized } from './errors.js'",
    '',
    '/** Who made the request, as the token says. */',
    'export interface Principal {',
    '  subject: string',
    '  roles: string[]',
    '}',
    '',
    '/** Verifies the token: signature, expiry (required) and, when configured, audience and issuer. */',
    'function principalOf(request: Request): Principal {',
    '  const settings = getSettings()',
    "  const header = request.header('Authorization') ?? ''",
    "  const token = header.startsWith('Bearer ') ? header.slice(7) : ''",
    '  if (!token || !settings.jwtSecret) throw unauthorized()',
    '  let claims: jwt.JwtPayload',
    '  try {',
    '    const decoded = jwt.verify(token, settings.jwtSecret, {',
    '      algorithms: [settings.jwtAlgorithm],',
    '      audience: settings.jwtAudience,',
    '      issuer: settings.jwtIssuer,',
    '    })',
    "    if (typeof decoded === 'string' || typeof decoded.exp !== 'number') throw unauthorized()",
    '    claims = decoded',
    '  } catch {',
    '    throw unauthorized()',
    '  }',
    '  const roles = claims.roles',
    "  return { subject: String(claims.sub ?? ''), roles: Array.isArray(roles) ? roles.map(String) : typeof roles === 'string' ? [roles] : [] }",
    '}',
    '',
    '/** Lets the request through only with a valid token. */',
    'export const authenticate: RequestHandler = (request, _response, next) => {',
    '  principalOf(request)',
    '  next()',
    '}',
    '',
    '/** Lets the request through only if the token has one of `roles`. */',
    'export function requireRoles(...roles: string[]): RequestHandler {',
    '  return (request, _response, next) => {',
    '    const principal = principalOf(request)',
    '    if (!principal.roles.some((role) => roles.includes(role))) throw forbidden()',
    '    next()',
    '  }',
    '}',
  )
  return { path: 'src/security.ts', content: fileText(content) }
}

export function listingFile(): GeneratedFile {
  const content = lines(
    tsDoc('What a list asks the repositories for: equality filters, an order and a window of items.'),
    '',
    'export interface ListQuery {',
    '  /** JSON field name → value every item must have */',
    '  filters: Record<string, unknown>',
    '  sort?: { field: string; descending: boolean }',
    '  offset: number',
    '  /** At most this many items; all of them when absent */',
    '  limit?: number',
    '}',
    '',
    'export interface ListResult<T> {',
    '  items: T[]',
    '  /** How many items match, whatever the window */',
    '  total: number',
    '}',
    '',
    '/** `"-createdAt"` → sort by createdAt, descending. */',
    "export function parseSort(sort: string | undefined): ListQuery['sort'] {",
    '  if (!sort) return undefined',
    "  return sort.startsWith('-') ? { field: sort.slice(1), descending: true } : { field: sort, descending: false }",
    '}',
  )
  return { path: 'src/listing.ts', content: fileText(content) }
}

/** The application factory: the only place that decides which repository each service uses. */
export function appFile(context: ExpressContext): GeneratedFile {
  const path = 'src/app.ts'
  const imports = new TsImports()
  imports.add('express', 'default express')
  imports.addType('express', 'Express')
  imports.add('./errors.js', 'errorHandler', 'unknownRoute')
  const repositories: string[] = []
  const services: string[] = []
  const routes: string[] = []
  for (const resource of context.spec.resources) {
    const name = names(resource)
    const repositoryPath = importPath(path, context.layout.resource(resource, 'repository'))
    const implementation = context.pending ? name.pendingRepository : name.memory
    imports.add(repositoryPath, implementation)
    imports.add(importPath(path, context.layout.resource(resource, 'service')), name.service)
    imports.add(importPath(path, context.layout.resource(resource, 'routes')), name.routes)
    repositories.push(`  const ${name.many} = new ${implementation}()`)
    const needs = referencedResources(context, resource).map((target) => names(target).many)
    services.push(`  const ${name.one}Service = new ${name.service}(${[name.many, ...needs].join(', ')})`)
    routes.push(`  app.use(${name.routes}(${name.one}Service))`)
  }
  const content = lines(
    tsDoc('Builds the application: storage, the rules of each resource, its routes and the error format.'),
    '',
    imports.render(),
    '',
    '/** A new application with its own storage: tests create one each. */',
    'export function createApp(): Express {',
    context.pending
      ? '  // Storage to write: every repository answers 501 until it is implemented'
      : '  // Data kept in memory while the application runs; restarting it starts empty',
    repositories,
    services,
    '',
    '  const app = express()',
    "  app.disable('x-powered-by')",
    '  app.use(express.json())',
    routes,
    '  app.use(unknownRoute)',
    '  app.use(errorHandler)',
    '  return app',
    '}',
  )
  return { path, content: fileText(content) }
}

export function serverFile(): GeneratedFile {
  const content = lines(
    tsDoc('Entry point: starts the API on PORT (3000 by default).'),
    '',
    "import { createApp } from './app.js'",
    "import { getSettings } from './config.js'",
    '',
    'const { port } = getSettings()',
    'createApp().listen(port, () => {',
    '  console.log(`API listening on http://localhost:${port}`)',
    '})',
  )
  return { path: 'src/server.ts', content: fileText(content) }
}
