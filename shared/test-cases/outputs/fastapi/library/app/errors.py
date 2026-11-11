"""One error format for the whole API: {"error": {"code", "message", "details"}}, as described in openapi.yaml."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    """An error the API answers with a status, a code and a message."""

    def __init__(self, status: int, code: str, message: str, details: list[dict[str, str]] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class InvalidRequestError(ApiError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(400, "validation_error", "The request is not valid", [{"field": field, "message": message}])


class UnauthorizedError(ApiError):
    def __init__(self) -> None:
        super().__init__(401, "unauthorized", "Missing or invalid credentials")


class ForbiddenError(ApiError):
    def __init__(self) -> None:
        super().__init__(403, "forbidden", "The credentials do not allow this operation")


class NotFoundError(ApiError):
    def __init__(self, what: str) -> None:
        super().__init__(404, "not_found", f"No {what} has this key")


class ConflictError(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(409, "conflict", message)


def error_body(code: str, message: str, details: list[dict[str, str]] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details:
        error["details"] = details
    return {"error": error}


_HTTP_CODES = {400: "validation_error", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed"}


def _field_of(location: tuple[Any, ...]) -> str:
    """`("body", "address", "city")` → `address.city`: the place of the error in what the client sent."""
    parts = [str(part) for part in location if part not in ("body", "query", "path", "header")]
    return ".".join(parts) or "body"


def register_error_handlers(app: FastAPI) -> None:
    """Answers every error with the common format and the status of openapi.yaml."""

    @app.exception_handler(ApiError)
    async def api_error(_: Request, error: ApiError) -> JSONResponse:
        return JSONResponse(error_body(error.code, error.message, error.details), status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, error: RequestValidationError) -> JSONResponse:
        # Validation errors are 400, the same in every framework Model2API writes (FastAPI uses 422 by default)
        details = [{"field": _field_of(tuple(item["loc"])), "message": item["msg"]} for item in error.errors()]
        return JSONResponse(error_body("validation_error", "The request is not valid", details), status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, error: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(error.status_code, "internal_error")
        return JSONResponse(error_body(code, str(error.detail)), status_code=error.status_code, headers=getattr(error, "headers", None))

    @app.exception_handler(NotImplementedError)
    async def not_implemented(_: Request, error: NotImplementedError) -> JSONResponse:
        message = str(error) or "The logic of this operation is not written yet"
        return JSONResponse(error_body("not_implemented", message), status_code=501)
