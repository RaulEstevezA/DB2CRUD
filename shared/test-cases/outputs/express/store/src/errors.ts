/**
 * One error format for the whole API: {"error": {"code", "message", "details"}}, as described in openapi.yaml.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'

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
    readonly details?: ErrorDetail[],
  ) {
    super(message)
  }
}

/** Thrown by code still to write: the API answers 501. */
export class NotImplementedError extends Error {}

export const invalid = (field: string, message: string) => new ApiError(400, 'validation_error', 'The request is not valid', [{ field, message }])
export const unauthorized = () => new ApiError(401, 'unauthorized', 'Missing or invalid credentials')
export const forbidden = () => new ApiError(403, 'forbidden', 'The credentials do not allow this operation')
export const notFound = (what: string) => new ApiError(404, 'not_found', `No ${what} has this key`)
export const conflict = (message: string) => new ApiError(409, 'conflict', message)

export function errorBody(code: string, message: string, details?: ErrorDetail[]) {
  return { error: { code, message, ...(details && details.length > 0 ? { details } : {}) } }
}

/** Answers routes that do not exist with the common format. */
export const unknownRoute: RequestHandler = (_request, response) => {
  response.status(404).json(errorBody('not_found', 'No route matches this request'))
}

/** Answers every error with the common format and the status of openapi.yaml. */
export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ApiError) {
    response.status(error.status).json(errorBody(error.code, error.message, error.details))
    return
  }
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message }))
    response.status(400).json(errorBody('validation_error', 'The request is not valid', details))
    return
  }
  if (error instanceof NotImplementedError) {
    response.status(501).json(errorBody('not_implemented', error.message || 'The logic of this operation is not written yet'))
    return
  }
  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed') {
    response.status(400).json(errorBody('validation_error', 'The body is not valid JSON'))
    return
  }
  console.error(error)
  response.status(500).json(errorBody('internal_error', 'Something went wrong on the server'))
}
