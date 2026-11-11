/**
 * One error format for the whole API: {"error": {"code", "message", "details"}}, as described in openapi.yaml.
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, ValidationPipe } from '@nestjs/common'
import type { ValidationError } from 'class-validator'
import type { Response } from 'express'

export interface ErrorDetail {
  field: string
  message: string
}

/** An error the API answers with a status, a code and a message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message)
  }
}

/** Thrown by code still to write: the API answers 501. */
export class NotImplementedError extends Error {}

export const invalid = (field: string, message: string) => new ApiError(400, 'validation_error', 'The request is not valid', [{ field, message }])
export const notFound = (what: string) => new ApiError(404, 'not_found', `No ${what} has this key`)
export const conflict = (message: string) => new ApiError(409, 'conflict', message)

/** Every message of every invalid field, nested ones with their place: `address.city`, `lines.0.quantity`. */
function details(errors: ValidationError[], prefix = ''): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = prefix ? `${prefix}.${error.property}` : error.property
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }))
    return [...own, ...details(error.children ?? [], field)]
  })
}

/** Validates bodies and queries with their DTOs; unknown fields are an error, as openapi.yaml says. */
export function validationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => new ApiError(400, 'validation_error', 'The request is not valid', details(errors)),
  })
}

const CODES: Record<number, string> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
}

/** Answers every error with the common format and the status of openapi.yaml. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    const answer = (status: number, code: string, message: string, items: ErrorDetail[] = []) =>
      response.status(status).json({ error: { code, message, ...(items.length > 0 ? { details: items } : {}) } })
    if (error instanceof ApiError) return void answer(error.status, error.code, error.message, error.details)
    if (error instanceof NotImplementedError) return void answer(501, 'not_implemented', error.message || 'The logic of this operation is not written yet')
    if (error instanceof HttpException) {
      const status = error.getStatus()
      const message = status === 404 ? 'No route matches this request' : status === 400 ? 'The request is not valid' : error.message
      return void answer(status, CODES[status] ?? 'internal_error', message)
    }
    console.error(error)
    answer(500, 'internal_error', 'Something went wrong on the server')
  }
}
