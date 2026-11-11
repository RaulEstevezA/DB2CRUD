"""One error format for the whole API: {"error": {"code", "message", "details"}}, as described in openapi.yaml."""

import logging
from typing import Any

from django.db import IntegrityError
from django.db.models import ProtectedError
from django.http import Http404, HttpRequest, JsonResponse
from rest_framework import exceptions, status
from rest_framework.response import Response

logger = logging.getLogger(__name__)


class ApiError(exceptions.APIException):
    """An error the API answers with a status, a code and a message."""

    def __init__(self, status_code: int, code: str, message: str, details: list[dict[str, str]] | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = code
        self.details = details or []


class InvalidRequestError(ApiError):
    def __init__(self, field: str, message: str) -> None:
        super().__init__(400, "validation_error", "The request is not valid", [{"field": field, "message": message}])


class NotFoundError(ApiError):
    def __init__(self, what: str) -> None:
        super().__init__(404, "not_found", f"No {what} has this key")


class ConflictError(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(409, "conflict", message)


def require(model: Any, key: Any, field: str) -> None:
    """A reference must point to a stored item."""
    if key is not None and not model.objects.filter(pk=key).exists():
        raise InvalidRequestError(field, f"No {model.__name__} has this key")


def _body(code: str, message: str, details: list[dict[str, str]] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details:
        error["details"] = details
    return {"error": error}


def _flatten(detail: Any, prefix: str = "") -> list[dict[str, str]]:
    """Validation errors of nested fields, with their place: `address.city`, `lines.0.quantity`."""
    if isinstance(detail, dict):
        return [item for key, value in detail.items() for item in _flatten(value, f"{prefix}.{key}" if prefix else str(key))]
    if isinstance(detail, list) and detail and not all(isinstance(item, str) for item in detail):
        return [item for index, value in enumerate(detail) for item in _flatten(value, f"{prefix}.{index}" if prefix else str(index))]
    messages = detail if isinstance(detail, list) else [detail]
    return [{"field": prefix or "body", "message": str(message)} for message in messages]


def exception_handler(error: Exception, context: dict[str, Any]) -> Response | None:
    """Answers every error with the common format and the status of openapi.yaml."""
    if isinstance(error, ApiError):
        return Response(_body(error.error_code, str(error.detail), error.details), status=error.status_code)
    if isinstance(error, exceptions.ValidationError):
        return Response(_body("validation_error", "The request is not valid", _flatten(error.detail)), status=400)
    if isinstance(error, exceptions.ParseError):
        return Response(_body("validation_error", "The body is not valid JSON"), status=400)
    if isinstance(error, (exceptions.NotAuthenticated, exceptions.AuthenticationFailed)):
        response = Response(_body("unauthorized", "Missing or invalid credentials"), status=401)
        authenticator = context["request"].authenticators[0] if context["request"].authenticators else None
        response["WWW-Authenticate"] = authenticator.authenticate_header(context["request"]) if authenticator else "Bearer"
        return response
    if isinstance(error, exceptions.PermissionDenied):
        return Response(_body("forbidden", "The credentials do not allow this operation"), status=403)
    if isinstance(error, (exceptions.NotFound, Http404)):
        return Response(_body("not_found", "No item has this key"), status=404)
    if isinstance(error, exceptions.MethodNotAllowed):
        return Response(_body("method_not_allowed", "This path does not accept this method"), status=405)
    if isinstance(error, exceptions.UnsupportedMediaType):
        return Response(_body("validation_error", "The body must be JSON"), status=400)
    if isinstance(error, NotImplementedError):
        return Response(_body("not_implemented", str(error) or "The logic of this operation is not written yet"), status=501)
    if isinstance(error, (ProtectedError, IntegrityError)):
        # A key already used, or an item other items still refer to. The cause stays in the log
        logger.warning("Integrity error: %s", error)
        return Response(_body("conflict", "The change conflicts with the stored data"), status=409)
    logger.exception("Unexpected error", exc_info=error)
    return Response(_body("internal_error", "Something went wrong on the server"), status=status.HTTP_500_INTERNAL_SERVER_ERROR)


def not_found(request: HttpRequest, exception: Exception | None = None) -> JsonResponse:
    """Routes that do not exist answer with the common format too."""
    return JsonResponse(_body("not_found", "No route matches this request"), status=404)
