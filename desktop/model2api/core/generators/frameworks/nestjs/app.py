"""Application files of the NestJS project that do not belong to one resource: the entry point and root module,
the error format (exception filter and validation pipe), authentication guards, list queries, validators and
column transformers, configuration and the database connection. Mirrors
web/src/core/generators/frameworks/nestjs/app.ts.
"""

from ....openapi.build import GENERAL_ERROR_CODES
from ...common.text import file_text, lines
from ...languages.typescript.typescript import TsImports, ts_doc, ts_string
from .context import NestContext, import_path, names, resource_path


def main_file() -> dict:
    content = lines(
        ts_doc("Entry point: starts the API on PORT (3000 by default)."),
        "",
        "import 'reflect-metadata'",
        "import { NestFactory } from '@nestjs/core'",
        "import { AppModule } from './app.module'",
        "import { configure } from './app.setup'",
        "",
        "async function bootstrap(): Promise<void> {",
        "  const app = configure(await NestFactory.create(AppModule))",
        "  const port = Number(process.env.PORT ?? 3000)",
        "  await app.listen(port)",
        "  console.log(`API listening on http://localhost:${port}`)",
        "}",
        "",
        "void bootstrap()",
    )
    return {"path": "src/main.ts", "content": file_text(content)}


def setup_file() -> dict:
    """The validation and error setup, shared by the entry point and the tests."""
    content = lines(
        ts_doc("How the application validates requests and answers errors: the same in production and in the tests."),
        "",
        "import type { INestApplication } from '@nestjs/common'",
        "import { ErrorsFilter, validationPipe } from './common/errors'",
        "",
        "export function configure(app: INestApplication): INestApplication {",
        "  app.useGlobalPipes(validationPipe())",
        "  app.useGlobalFilters(new ErrorsFilter())",
        "  app.getHttpAdapter().getInstance().disable('x-powered-by')",
        "  return app",
        "}",
    )
    return {"path": "src/app.setup.ts", "content": file_text(content)}


def app_module_file(context: NestContext) -> dict:
    path = "src/app.module.ts"
    imports = TsImports().add("@nestjs/common", "Module")
    modules = []
    for resource in context.spec["resources"]:
        imports.add(import_path(path, resource_path(resource, "module")), names(resource)["module"])
        modules.append(names(resource)["module"])
    if context.typeorm:
        imports.add("@nestjs/typeorm", "TypeOrmModule")
        imports.add("./database", "databaseOptions")
    every = [*(["TypeOrmModule.forRoot(databaseOptions())"] if context.typeorm else []), *modules]
    content = lines(
        ts_doc("Root module: every resource module, and the database connection when there is one."),
        "",
        imports.render(),
        "",
        "@Module({",
        f"  imports: [{', '.join(every)}],",
        "})",
        "export class AppModule {}",
    )
    return {"path": path, "content": file_text(content)}


def database_file(context: NestContext) -> dict | None:
    if not context.typeorm:
        return None
    database = context.settings["database"]
    kind = ts_string("mariadb" if database == "mariadb" else "mysql" if database == "mysql" else "postgres")
    content = lines(
        ts_doc(
            "Connection to the database, from DATABASE_URL. The tests use TEST_DATABASE_URL, or an in-memory SQLite (sql.js)."
        ),
        "",
        "import type { TypeOrmModuleOptions } from '@nestjs/typeorm'",
        "",
        "export function databaseOptions(): TypeOrmModuleOptions {",
        "  if (process.env.NODE_ENV === 'test') {",
        "    const url = process.env.TEST_DATABASE_URL",
        "    // A fresh schema for every test application",
        "    if (!url) return { type: 'sqljs', autoLoadEntities: true, synchronize: true }",
        f"    return {{ type: {kind}, url, autoLoadEntities: true, synchronize: true, dropSchema: true }}",
        "  }",
        "  return {",
        f"    type: {kind},",
        "    url: process.env.DATABASE_URL,",
        "    autoLoadEntities: true,",
        "    // Creates missing tables while you develop; set DATABASE_SYNCHRONIZE=false and use migrations for a real database",
        "    synchronize: process.env.DATABASE_SYNCHRONIZE !== 'false',",
        "  }",
        "}",
    )
    return {"path": "src/database.ts", "content": file_text(content)}


def common_files(context: NestContext) -> list[dict]:
    errors = lines(
        ts_doc(
            'One error format for the whole API: {"error": {"code", "message", "details"}}, as described in openapi.yaml.'
        ),
        "",
        "import { ArgumentsHost, Catch, ExceptionFilter, HttpException, ValidationPipe } from '@nestjs/common'",
        "import type { ValidationError } from 'class-validator'",
        "import type { Response } from 'express'",
        "",
        "export interface ErrorDetail {",
        "  field: string",
        "  message: string",
        "}",
        "",
        "/** An error the API answers with a status, a code and a message. */",
        "export class ApiError extends Error {",
        "  constructor(",
        "    readonly status: number,",
        "    readonly code: string,",
        "    message: string,",
        "    readonly details: ErrorDetail[] = [],",
        "  ) {",
        "    super(message)",
        "  }",
        "}",
        "",
        "/** Thrown by code still to write: the API answers 501. */",
        "export class NotImplementedError extends Error {}",
        "",
        "export const invalid = (field: string, message: string) => new ApiError(400, 'validation_error', 'The request is not valid', [{ field, message }])",
        "export const notFound = (what: string) => new ApiError(404, 'not_found', `No ${what} has this key`)",
        "export const conflict = (message: string) => new ApiError(409, 'conflict', message)",
        "",
        "/** Every message of every invalid field, nested ones with their place: `address.city`, `lines.0.quantity`. */",
        "function details(errors: ValidationError[], prefix = ''): ErrorDetail[] {",
        "  return errors.flatMap((error) => {",
        "    const field = prefix ? `${prefix}.${error.property}` : error.property",
        "    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }))",
        "    return [...own, ...details(error.children ?? [], field)]",
        "  })",
        "}",
        "",
        "/** Validates bodies and queries with their DTOs; unknown fields are an error, as openapi.yaml says. */",
        "export function validationPipe(): ValidationPipe {",
        "  return new ValidationPipe({",
        "    whitelist: true,",
        "    forbidNonWhitelisted: true,",
        "    transform: true,",
        "    exceptionFactory: (errors) => new ApiError(400, 'validation_error', 'The request is not valid', details(errors)),",
        "  })",
        "}",
        "",
        "const CODES: Record<number, string> = {",
        "  400: 'validation_error',",
        "  401: 'unauthorized',",
        "  403: 'forbidden',",
        "  404: 'not_found',",
        f"  405: {ts_string(GENERAL_ERROR_CODES[0])},",
        "  409: 'conflict',",
        "}",
        "",
        "/** Answers every error with the common format and the status of openapi.yaml. */",
        "@Catch()",
        "export class ErrorsFilter implements ExceptionFilter {",
        "  catch(error: unknown, host: ArgumentsHost): void {",
        "    const response = host.switchToHttp().getResponse<Response>()",
        "    const answer = (status: number, code: string, message: string, items: ErrorDetail[] = []) =>",
        "      response.status(status).json({ error: { code, message, ...(items.length > 0 ? { details: items } : {}) } })",
        "    if (error instanceof ApiError) return void answer(error.status, error.code, error.message, error.details)",
        "    if (error instanceof NotImplementedError) return void answer(501, 'not_implemented', error.message || 'The logic of this operation is not written yet')",
        "    if (error instanceof HttpException) {",
        "      const status = error.getStatus()",
        "      const message = status === 404 ? 'No route matches this request' : status === 400 ? 'The request is not valid' : error.message",
        f"      return void answer(status, CODES[status] ?? {ts_string(GENERAL_ERROR_CODES[1])}, message)",
        "    }",
        "    console.error(error)",
        f"    answer(500, {ts_string(GENERAL_ERROR_CODES[1])}, 'Something went wrong on the server')",
        "  }",
        "}",
    )
    listing = lines(
        ts_doc("What a list asks the repositories for: equality filters, an order and a window of items."),
        "",
        "export interface ListQuery {",
        "  /** JSON field name → value every item must have */",
        "  filters: Record<string, unknown>",
        "  sort?: { field: string; descending: boolean }",
        "  offset: number",
        "  /** At most this many items; all of them when absent */",
        "  limit?: number",
        "}",
        "",
        "export interface ListResult<T> {",
        "  items: T[]",
        "  /** How many items match, whatever the window */",
        "  total: number",
        "}",
        "",
        '/** `"-createdAt"` → sort by createdAt, descending. */',
        "export function parseSort(sort: string | undefined): ListQuery['sort'] {",
        "  if (!sort) return undefined",
        "  return sort.startsWith('-') ? { field: sort.slice(1), descending: true } : { field: sort, descending: false }",
        "}",
    )
    validation = lines(
        ts_doc("Validators class-validator has no decorator for: bounds that exclude the limit."),
        "",
        "import { ValidateBy, type ValidationOptions } from 'class-validator'",
        "",
        "/** The value must be greater than `limit`. */",
        "export function GreaterThan(limit: number, options?: ValidationOptions): PropertyDecorator {",
        "  return ValidateBy({ name: 'greaterThan', validator: { validate: (value) => typeof value === 'number' && value > limit, defaultMessage: () => `must be greater than ${limit}` } }, options)",
        "}",
        "",
        "/** The value must be less than `limit`. */",
        "export function LessThan(limit: number, options?: ValidationOptions): PropertyDecorator {",
        "  return ValidateBy({ name: 'lessThan', validator: { validate: (value) => typeof value === 'number' && value < limit, defaultMessage: () => `must be less than ${limit}` } }, options)",
        "}",
    )
    files = [
        {"path": "src/common/errors.ts", "content": file_text(errors)},
        {"path": "src/common/listing.ts", "content": file_text(listing)},
        {"path": "src/common/validation.ts", "content": file_text(validation)},
    ]
    if context.typeorm:
        columns = lines(
            ts_doc(
                "Column transformers: exact numbers and big integers come back from the database as text, the API sends numbers."
            ),
            "",
            "import type { ValueTransformer } from 'typeorm'",
            "",
            "export const numeric: ValueTransformer = {",
            "  to: (value: number | null | undefined) => value,",
            "  from: (value: string | number | null) => (value === null || value === undefined ? value : Number(value)),",
            "}",
        )
        files.append({"path": "src/common/columns.ts", "content": file_text(columns)})
    security = _security_file(context)
    if security:
        files.append(security)
    return files


def _security_file(context: NestContext) -> dict | None:
    auth = context.settings["auth"]
    if auth == "none":
        return None
    if auth == "apiKey":
        content = lines(
            ts_doc(
                "API key authentication: the key in the X-API-Key header must be one of API_KEYS. Without API_KEYS, no request passes."
            ),
            "",
            "import { timingSafeEqual } from 'node:crypto'",
            "import { type CanActivate, type ExecutionContext } from '@nestjs/common'",
            "import type { Request } from 'express'",
            "import { ApiError } from './errors'",
            "",
            "/** Compares in constant time, so the answer time says nothing about the key. */",
            "function same(a: string, b: string): boolean {",
            "  const left = Buffer.from(a)",
            "  const right = Buffer.from(b)",
            "  return left.length === right.length && timingSafeEqual(left, right)",
            "}",
            "",
            "export class ApiKeyGuard implements CanActivate {",
            "  canActivate(context: ExecutionContext): boolean {",
            "    const key = context.switchToHttp().getRequest<Request>().header('X-API-Key')",
            "    const keys = (process.env.API_KEYS ?? '').split(',').map((item) => item.trim()).filter(Boolean)",
            "    if (!key || !keys.some((valid) => same(key, valid))) throw new ApiError(401, 'unauthorized', 'Missing or invalid credentials')",
            "    return true",
            "  }",
            "}",
        )
        return {"path": "src/common/security.ts", "content": file_text(content)}
    content = lines(
        ts_doc(
            'Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them with\nJWT_SECRET (and JWT_AUDIENCE / JWT_ISSUER when set), requires an expiry and reads the roles from the "roles" claim.',
        ),
        "",
        "import { type CanActivate, type ExecutionContext } from '@nestjs/common'",
        "import type { Request } from 'express'",
        "import jwt from 'jsonwebtoken'",
        "import { ApiError } from './errors'",
        "",
        "const unauthorized = () => new ApiError(401, 'unauthorized', 'Missing or invalid credentials')",
        "",
        "/** Lets the request through with a valid token, and, when roles are given, only with one of them. */",
        "export class JwtGuard implements CanActivate {",
        "  constructor(private readonly roles: string[] = []) {}",
        "",
        "  canActivate(context: ExecutionContext): boolean {",
        "    const header = context.switchToHttp().getRequest<Request>().header('Authorization') ?? ''",
        "    const token = header.startsWith('Bearer ') ? header.slice(7) : ''",
        "    const secret = process.env.JWT_SECRET ?? ''",
        "    if (!token || !secret) throw unauthorized()",
        "    let claims: jwt.JwtPayload",
        "    try {",
        "      const decoded = jwt.verify(token, secret, {",
        "        algorithms: [(process.env.JWT_ALGORITHM ?? 'HS256') as jwt.Algorithm],",
        "        audience: process.env.JWT_AUDIENCE || undefined,",
        "        issuer: process.env.JWT_ISSUER || undefined,",
        "      })",
        "      if (typeof decoded === 'string' || typeof decoded.exp !== 'number') throw unauthorized()",
        "      claims = decoded",
        "    } catch {",
        "      throw unauthorized()",
        "    }",
        "    const roles = Array.isArray(claims.roles) ? claims.roles.map(String) : typeof claims.roles === 'string' ? [claims.roles] : []",
        "    if (this.roles.length > 0 && !roles.some((role) => this.roles.includes(role))) throw new ApiError(403, 'forbidden', 'The credentials do not allow this operation')",
        "    return true",
        "  }",
        "}",
    )
    return {"path": "src/common/security.ts", "content": file_text(content)}
