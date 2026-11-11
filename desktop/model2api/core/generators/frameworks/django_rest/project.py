"""Project files of the Django REST Framework project: the config package (settings, URLs, the error format,
authentication and validation helpers), manage.py, the apps, dependencies, the environment example, ignore rules
and the README. Mirrors web/src/core/generators/frameworks/djangoRest/project.ts.
"""

from ....openapi.build import GENERAL_ERROR_CODES
from ...common.text import file_text, lines
from ...languages.python.python import py_class, py_string
from ..fastapi.project import endpoint_rows
from .context import DjangoContext

_DATABASES = {
    "postgresql": {"url": "postgres://api:change-me@localhost:5432/api", "driver": "psycopg[binary]>=3.1,<4"},
    "mysql": {"url": "mysql://api:change-me@localhost:3306/api", "driver": "PyMySQL>=1.1,<2"},
    "mariadb": {"url": "mysql://api:change-me@localhost:3306/api", "driver": "PyMySQL>=1.1,<2"},
    "sqlite": {"url": "sqlite:///db.sqlite3"},
}


def config_files(context: DjangoContext) -> list[dict]:
    auth = context.settings["auth"]
    database = context.settings["database"]
    mysql = database in ("mysql", "mariadb")
    authentication = (
        '    "DEFAULT_AUTHENTICATION_CLASSES": [],'
        if auth == "none"
        else '    "DEFAULT_AUTHENTICATION_CLASSES": ["config.security.'
        + ("BearerTokenAuthentication" if auth == "jwt" else "ApiKeyAuthentication")
        + '"],'
    )
    database_url = py_string(_DATABASES[database or "sqlite"]["url"])
    settings = lines(
        '"""Settings of the API. Everything secret comes from the environment: see .env.example."""',
        "",
        "import os",
        "import secrets",
        "from pathlib import Path",
        "",
        "import dj_database_url",
        "",
        mysql
        and [
            "import pymysql",
            "",
            "# PyMySQL stands in for mysqlclient, which needs a compiler to install",
            'pymysql.version_info = (2, 2, 1, "final", 0)',
            "pymysql.install_as_MySQLdb()",
            "",
        ],
        "BASE_DIR = Path(__file__).resolve().parent.parent",
        "",
        "# Without DJANGO_SECRET_KEY a random key is used: fine to try the API, set your own before deploying it",
        'SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or secrets.token_urlsafe(50)',
        'DEBUG = os.environ.get("DJANGO_DEBUG", "false").lower() == "true"',
        'ALLOWED_HOSTS = [host.strip() for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if host.strip()]',
        "",
        "INSTALLED_APPS = [",
        '    "django.contrib.contenttypes",',
        '    "django.contrib.auth",',
        '    "rest_framework",',
        [f"    {py_string(app)}," for app in context.layout.apps()],
        "]",
        "",
        "MIDDLEWARE = [",
        '    "django.middleware.security.SecurityMiddleware",',
        '    "django.middleware.common.CommonMiddleware",',
        "]",
        "",
        "# Paths have no trailing slash, as openapi.yaml describes them",
        "APPEND_SLASH = False",
        'ROOT_URLCONF = "config.urls"',
        'WSGI_APPLICATION = "config.wsgi.application"',
        "",
        "# DATABASE_URL, for example postgres://user:password@host:5432/name; TEST_DATABASE_URL replaces it in the tests",
        "DATABASES = {",
        f'    "default": dj_database_url.parse(os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL", {database_url})),',
        "}",
        'DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"',
        "",
        "USE_TZ = True",
        'TIME_ZONE = "UTC"',
        "",
        auth == "apiKey"
        and [
            "# Accepted API keys, separated by commas. Without any, every protected request is rejected",
            'API_KEYS = [key.strip() for key in os.environ.get("API_KEYS", "").split(",") if key.strip()]',
            "",
        ],
        auth == "jwt"
        and [
            "# Secret, algorithm, audience and issuer of the tokens. Without JWT_SECRET, every protected request is rejected",
            'JWT_SECRET = os.environ.get("JWT_SECRET", "")',
            'JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")',
            'JWT_AUDIENCE = os.environ.get("JWT_AUDIENCE") or None',
            'JWT_ISSUER = os.environ.get("JWT_ISSUER") or None',
            "",
        ],
        "REST_FRAMEWORK = {",
        '    "EXCEPTION_HANDLER": "config.errors.exception_handler",',
        authentication,
        '    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],',
        '    "UNAUTHENTICATED_USER": None,',
        '    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],',
        '    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],',
        "}",
    )
    errors = lines(
        '"""One error format for the whole API: {"error": {"code", "message", "details"}}, as described in openapi.yaml."""',
        "",
        "import logging",
        "from typing import Any",
        "",
        "from django.db import IntegrityError",
        "from django.db.models import ProtectedError",
        "from django.http import Http404, HttpRequest, JsonResponse",
        "from rest_framework import exceptions, status",
        "from rest_framework.response import Response",
        "",
        "logger = logging.getLogger(__name__)",
        "",
        "",
        "class ApiError(exceptions.APIException):",
        '    """An error the API answers with a status, a code and a message."""',
        "",
        "    def __init__(self, status_code: int, code: str, message: str, details: list[dict[str, str]] | None = None) -> None:",
        "        super().__init__(message)",
        "        self.status_code = status_code",
        "        self.error_code = code",
        "        self.details = details or []",
        "",
        "",
        "class InvalidRequestError(ApiError):",
        "    def __init__(self, field: str, message: str) -> None:",
        '        super().__init__(400, "validation_error", "The request is not valid", [{"field": field, "message": message}])',
        "",
        "",
        "class NotFoundError(ApiError):",
        "    def __init__(self, what: str) -> None:",
        '        super().__init__(404, "not_found", f"No {what} has this key")',
        "",
        "",
        "class ConflictError(ApiError):",
        "    def __init__(self, message: str) -> None:",
        '        super().__init__(409, "conflict", message)',
        "",
        "",
        "def require(model: Any, key: Any, field: str) -> None:",
        '    """A reference must point to a stored item."""',
        "    if key is not None and not model.objects.filter(pk=key).exists():",
        '        raise InvalidRequestError(field, f"No {model.__name__} has this key")',
        "",
        "",
        "def _body(code: str, message: str, details: list[dict[str, str]] | None = None) -> dict[str, Any]:",
        '    error: dict[str, Any] = {"code": code, "message": message}',
        "    if details:",
        '        error["details"] = details',
        '    return {"error": error}',
        "",
        "",
        'def _flatten(detail: Any, prefix: str = "") -> list[dict[str, str]]:',
        '    """Validation errors of nested fields, with their place: `address.city`, `lines.0.quantity`."""',
        "    if isinstance(detail, dict):",
        '        return [item for key, value in detail.items() for item in _flatten(value, f"{prefix}.{key}" if prefix else str(key))]',
        "    if isinstance(detail, list) and detail and not all(isinstance(item, str) for item in detail):",
        '        return [item for index, value in enumerate(detail) for item in _flatten(value, f"{prefix}.{index}" if prefix else str(index))]',
        "    messages = detail if isinstance(detail, list) else [detail]",
        '    return [{"field": prefix or "body", "message": str(message)} for message in messages]',
        "",
        "",
        "def exception_handler(error: Exception, context: dict[str, Any]) -> Response | None:",
        '    """Answers every error with the common format and the status of openapi.yaml."""',
        "    if isinstance(error, ApiError):",
        "        return Response(_body(error.error_code, str(error.detail), error.details), status=error.status_code)",
        "    if isinstance(error, exceptions.ValidationError):",
        '        return Response(_body("validation_error", "The request is not valid", _flatten(error.detail)), status=400)',
        "    if isinstance(error, exceptions.ParseError):",
        '        return Response(_body("validation_error", "The body is not valid JSON"), status=400)',
        "    if isinstance(error, (exceptions.NotAuthenticated, exceptions.AuthenticationFailed)):",
        '        response = Response(_body("unauthorized", "Missing or invalid credentials"), status=401)',
        '        authenticator = context["request"].authenticators[0] if context["request"].authenticators else None',
        '        response["WWW-Authenticate"] = authenticator.authenticate_header(context["request"]) if authenticator else "Bearer"',
        "        return response",
        "    if isinstance(error, exceptions.PermissionDenied):",
        '        return Response(_body("forbidden", "The credentials do not allow this operation"), status=403)',
        "    if isinstance(error, (exceptions.NotFound, Http404)):",
        '        return Response(_body("not_found", "No item has this key"), status=404)',
        "    if isinstance(error, exceptions.MethodNotAllowed):",
        f'        return Response(_body({py_string(GENERAL_ERROR_CODES[0])}, "This path does not accept this method"), status=405)',
        "    if isinstance(error, exceptions.UnsupportedMediaType):",
        '        return Response(_body("validation_error", "The body must be JSON"), status=400)',
        "    if isinstance(error, NotImplementedError):",
        '        return Response(_body("not_implemented", str(error) or "The logic of this operation is not written yet"), status=501)',
        "    if isinstance(error, (ProtectedError, IntegrityError)):",
        "        # A key already used, or an item other items still refer to. The cause stays in the log",
        '        logger.warning("Integrity error: %s", error)',
        '        return Response(_body("conflict", "The change conflicts with the stored data"), status=409)',
        '    logger.exception("Unexpected error", exc_info=error)',
        f'    return Response(_body({py_string(GENERAL_ERROR_CODES[1])}, "Something went wrong on the server"), status=status.HTTP_500_INTERNAL_SERVER_ERROR)',
        "",
        "",
        "def not_found(request: HttpRequest, exception: Exception | None = None) -> JsonResponse:",
        '    """Routes that do not exist answer with the common format too."""',
        '    return JsonResponse(_body("not_found", "No route matches this request"), status=404)',
    )
    validation = lines(
        '"""Base serializer and validators shared by every serializer."""',
        "",
        "from typing import Any",
        "",
        "from rest_framework import serializers",
        "",
        "",
        "class StrictSerializer(serializers.Serializer):",
        '    """Rejects fields the client may not send, as openapi.yaml does."""',
        "",
        "    def to_internal_value(self, data: Any) -> Any:",
        "        if isinstance(data, dict):",
        "            accepted = {name for name, field in self.fields.items() if not field.read_only}",
        "            unknown = sorted(set(data) - accepted)",
        "            if unknown:",
        '                raise serializers.ValidationError({name: ["This field is not accepted."] for name in unknown})',
        "        return super().to_internal_value(data)",
        "",
        "",
        "def greater_than(limit: float):  # type: ignore[no-untyped-def]",
        '    """A value must be greater than `limit`."""',
        "",
        "    def check(value: float) -> None:",
        "        if value <= limit:",
        '            raise serializers.ValidationError(f"Ensure this value is greater than {limit}.")',
        "",
        "    return check",
        "",
        "",
        "def less_than(limit: float):  # type: ignore[no-untyped-def]",
        '    """A value must be less than `limit`."""',
        "",
        "    def check(value: float) -> None:",
        "        if value >= limit:",
        '            raise serializers.ValidationError(f"Ensure this value is less than {limit}.")',
        "",
        "    return check",
    )
    apps = list(dict.fromkeys(context.layout.app(resource) for resource in context.spec["resources"]))
    urls = lines(
        '"""URLs of the API: the routes of every app."""',
        "",
        "from django.urls import include, path",
        "",
        "urlpatterns = [",
        [f'    path("", include({py_string(app + ".urls")})),' for app in apps],
        "]",
        "",
        'handler404 = "config.errors.not_found"',
    )
    wsgi = lines(
        '"""WSGI entry point, for servers such as Gunicorn: gunicorn config.wsgi."""',
        "",
        "import os",
        "",
        "from django.core.wsgi import get_wsgi_application",
        "",
        'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")',
        "application = get_wsgi_application()",
    )
    manage = lines(
        "#!/usr/bin/env python",
        '"""Django\'s command line: runserver, test, makemigrations, migrate…"""',
        "",
        "import os",
        "import sys",
        "",
        'if __name__ == "__main__":',
        '    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")',
        "    from django.core.management import execute_from_command_line",
        "",
        "    execute_from_command_line(sys.argv)",
    )
    files = [
        {"path": "config/__init__.py", "content": ""},
        {"path": "config/settings.py", "content": file_text(settings)},
        {"path": "config/errors.py", "content": file_text(errors)},
        {"path": "config/validation.py", "content": file_text(validation)},
        {"path": "config/urls.py", "content": file_text(urls)},
        {"path": "config/wsgi.py", "content": file_text(wsgi)},
        {"path": "manage.py", "content": file_text(manage)},
    ]
    security = _security_file(context)
    if security:
        files.append(security)
    for app in context.layout.apps():
        app_config = lines(
            f'"""The {app} app."""',
            "",
            "from django.apps import AppConfig",
            "",
            "",
            f"class {py_class(app)}Config(AppConfig):",
            f"    name = {py_string(app)}",
            '    default_auto_field = "django.db.models.BigAutoField"',
        )
        files.extend(
            [
                {"path": f"{app}/__init__.py", "content": ""},
                {"path": f"{app}/apps.py", "content": file_text(app_config)},
            ]
        )
    return files


_COMMON = [
    "",
    "",
    "@dataclass(frozen=True)",
    "class Principal:",
    '    """Who made the request."""',
    "",
    "    subject: str",
    "    roles: frozenset[str]",
    "    is_authenticated: bool = True",
]


def _security_file(context: DjangoContext) -> dict | None:
    auth = context.settings["auth"]
    if auth == "none":
        return None
    if auth == "apiKey":
        content = lines(
            '"""API key authentication: the key in the X-API-Key header must be one of API_KEYS."""',
            "",
            "from dataclasses import dataclass",
            "from secrets import compare_digest",
            "",
            "from django.conf import settings",
            "from rest_framework.authentication import BaseAuthentication",
            "from rest_framework.request import Request",
            _COMMON,
            "",
            "",
            "class ApiKeyAuthentication(BaseAuthentication):",
            '    """Authenticates a request with a configured key. Without API_KEYS, no request is."""',
            "",
            "    def authenticate(self, request: Request) -> tuple[Principal, str] | None:",
            '        key = request.headers.get("X-API-Key")',
            "        if key and any(compare_digest(key, valid) for valid in settings.API_KEYS):",
            '            return Principal(subject="api-key", roles=frozenset()), key',
            "        return None",
            "",
            "    def authenticate_header(self, request: Request) -> str:",
            "        # Makes DRF answer 401, not 403, to a request without credentials",
            '        return "ApiKey"',
        )
        return {"path": "config/security.py", "content": file_text(content)}
    content = lines(
        '"""Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them',
        'with JWT_SECRET (and JWT_AUDIENCE / JWT_ISSUER when set) and reads the roles from the "roles" claim."""',
        "",
        "from dataclasses import dataclass",
        "from typing import Any",
        "",
        "import jwt",
        "from django.conf import settings",
        "from rest_framework.authentication import BaseAuthentication",
        "from rest_framework.exceptions import AuthenticationFailed",
        "from rest_framework.permissions import BasePermission",
        "from rest_framework.request import Request",
        _COMMON,
        "",
        "",
        "class BearerTokenAuthentication(BaseAuthentication):",
        '    """Verifies the token: signature, expiry (required) and, when configured, audience and issuer."""',
        "",
        "    def authenticate(self, request: Request) -> tuple[Principal, str] | None:",
        '        header = request.headers.get("Authorization", "")',
        '        if not header.startswith("Bearer "):',
        "            return None",
        "        token = header[7:]",
        "        if not settings.JWT_SECRET:",
        "            raise AuthenticationFailed()",
        "        try:",
        "            claims: dict[str, Any] = jwt.decode(",
        "                token,",
        "                settings.JWT_SECRET,",
        "                algorithms=[settings.JWT_ALGORITHM],",
        "                audience=settings.JWT_AUDIENCE,",
        "                issuer=settings.JWT_ISSUER,",
        '                options={"require": ["exp"]},',
        "            )",
        "        except jwt.PyJWTError as error:",
        "            raise AuthenticationFailed() from error",
        '        roles = claims.get("roles", [])',
        "        if isinstance(roles, str):",
        "            roles = [roles]",
        '        return Principal(subject=str(claims.get("sub", "")), roles=frozenset(str(role) for role in roles)), token',
        "",
        "    def authenticate_header(self, request: Request) -> str:",
        "        # Makes DRF answer 401, not 403, to a request without credentials",
        '        return "Bearer"',
        "",
        "",
        "class HasAnyRole(BasePermission):",
        '    """Lets the request through only if the token has one of the roles."""',
        "",
        "    def __init__(self, *roles: str) -> None:",
        "        self.roles = frozenset(roles)",
        "",
        "    def has_permission(self, request: Request, view: Any) -> bool:",
        "        user = request.user",
        '        return user is not None and bool(getattr(user, "roles", frozenset()) & self.roles)',
    )
    return {"path": "config/security.py", "content": file_text(content)}


def requirements_files(context: DjangoContext) -> list[dict]:
    database = context.settings["database"] or "sqlite"
    runtime = lines(
        "Django>=5.2,<7",
        "djangorestframework>=3.16,<4",
        "dj-database-url>=2.2,<4",
        _DATABASES[database].get("driver"),
        database in ("mysql", "mariadb") and "cryptography>=42",
        context.settings["auth"] == "jwt" and "PyJWT>=2.8,<3",
    )
    return [
        {"path": "requirements.txt", "content": file_text(runtime)},
        {"path": "requirements-dev.txt", "content": file_text(lines("-r requirements.txt"))},
    ]


def env_example_file(context: DjangoContext) -> dict:
    auth = context.settings["auth"]
    database = context.settings["database"]
    content = lines(
        "# Copy this file to .env, fill in your own values and export them before running the API. Never commit .env.",
        "",
        '# A long random value: python -c "import secrets; print(secrets.token_urlsafe(50))"',
        "DJANGO_SECRET_KEY=",
        "DJANGO_DEBUG=false",
        "DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1",
        "",
        "# Database connection",
        f"DATABASE_URL={_DATABASES[database or 'sqlite']['url']}",
        auth == "apiKey" and ["", "# Accepted API keys, separated by commas. Use long random values.", "API_KEYS="],
        auth == "jwt"
        and [
            "",
            "# Secret that signs the tokens of your identity provider. Without it every protected request is rejected.",
            "JWT_SECRET=",
            "JWT_ALGORITHM=HS256",
            "JWT_AUDIENCE=",
            "JWT_ISSUER=",
        ],
    )
    return {"path": ".env.example", "content": file_text(content)}


def gitignore_file() -> dict:
    content = lines("__pycache__/", "*.py[cod]", ".venv/", ".env", "db.sqlite3", ".DS_Store")
    return {"path": ".gitignore", "content": file_text(content)}


def readme_file(context: DjangoContext) -> dict:
    settings = context.settings
    spec = context.spec
    pending: list[str] = []
    for resource in spec["resources"]:
        if resource.get("todo"):
            pending.append(f"- {resource['todo']}")
        for field in resource["fields"]:
            if field.get("todo"):
                pending.append(f"- {resource['name']}: {field['todo']}")
        for endpoint in resource["endpoints"]:
            if endpoint["operation"] == "custom":
                pending.append(
                    f"- `{endpoint['method']} {endpoint['path']}` ({endpoint['summary']}): write its logic in the "
                    "service; it answers 501 until then."
                )
    if settings["auth"] == "none":
        auth = "Every endpoint is public."
    elif settings["auth"] == "apiKey":
        auth = (
            "Protected endpoints need a key in the `X-API-Key` header, one of the comma-separated keys in `API_KEYS`. "
            "Without `API_KEYS`, every protected request is rejected."
        )
    else:
        auth = (
            "Protected endpoints need a bearer token issued by your identity provider. The API verifies it with "
            "`JWT_SECRET` (and `JWT_AUDIENCE` / `JWT_ISSUER` when set), requires an expiry, and reads the roles from "
            "the `roles` claim. It does not issue tokens."
        )
    if settings["architecture"] == "modular":
        layout = [
            "config/                settings, URLs, errors, authentication",
            "common/                enums and serializers of embedded objects",
            "<resource>/            models, serializers, services, views and URLs of one resource",
        ]
    else:
        layout = [
            "config/                settings, URLs, errors, authentication",
            "api/                   models, serializers, services, views and URLs",
        ]
    database = settings["database"] or "sqlite"
    content = lines(
        f"# {spec['title']}",
        "",
        "REST API generated by [Model2API](https://raulesteveza.github.io/tools/Model2API/) with Django REST "
        "Framework. It is a starting point: review it before using it in production.",
        "",
        "## Run it",
        "",
        "Requires Python 3.12 or later.",
        "",
        "```bash",
        "python -m venv .venv",
        "source .venv/bin/activate        # Windows: .venv\\Scripts\\activate",
        "pip install -r requirements-dev.txt",
        'export $(grep -v "^#" .env | xargs)   # after copying .env.example to .env and filling it in',
        "python manage.py makemigrations",
        "python manage.py migrate",
        "python manage.py runserver",
        "```",
        "",
        "The API listens on http://localhost:8000. Its contract is in `openapi.yaml`. The first `makemigrations` "
        "writes the migrations of the models; keep them in your repository.",
        "",
        "## Test it",
        "",
        "```bash",
        "python manage.py test",
        "```",
        "",
        "The tests create their own database (set `TEST_DATABASE_URL` to use a running server).",
        "",
        "## Endpoints",
        "",
        "| Method | Path | What it does | Success | Access |",
        "|---|---|---|---|---|",
        endpoint_rows(spec["resources"]),
        "",
        'Errors always have the same body: `{"error": {"code": "...", "message": "...", "details": [...]}}`. Invalid '
        "requests answer 400.",
        "",
        "## Storage",
        "",
        f"Django ORM on {database}. A reference to another resource is a foreign key that protects it: deleting an "
        "item others refer to answers 409. Embedded objects and lists are stored as JSON fields.",
        "",
        "## Authentication",
        "",
        auth,
        "",
        "## Structure",
        "",
        "```text",
        layout,
        "tests/                 one test file per resource",
        "openapi.yaml           the contract of the API",
        "```",
        "",
        "## Left to you",
        "",
        pending if pending else "- Nothing marked: review the generated code before using it.",
    )
    return {"path": "README.md", "content": file_text(content)}
