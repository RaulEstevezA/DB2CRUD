"""Application modules of the FastAPI project that do not belong to one resource: configuration from the
environment, the error format and its handlers, authentication, the database session, the wiring of
repositories and services, and the application factory. Mirrors
web/src/core/generators/frameworks/fastapi/app.ts.
"""

from ....openapi.build import GENERAL_ERROR_CODES
from ...common.text import file_text, lines
from ...languages.python.python import PyImports, py_docstring, py_string
from .context import FastApiContext, classes, names


def config_file(context: FastApiContext) -> dict:
    settings = context.settings
    fields: list[str] = []
    reads: list[str] = []
    if context.sql:
        fields.append("    database_url: str")
        reads.append('        database_url=os.environ.get("DATABASE_URL", "sqlite:///./app.db"),')
    if settings["auth"] == "apiKey":
        fields.append("    api_keys: tuple[str, ...]")
        reads.append(
            '        api_keys=tuple(key.strip() for key in os.environ.get("API_KEYS", "").split(",") if key.strip()),'
        )
    if settings["auth"] == "jwt":
        fields.extend(
            [
                "    jwt_secret: str",
                "    jwt_algorithm: str",
                "    jwt_audience: str | None",
                "    jwt_issuer: str | None",
            ]
        )
        reads.extend(
            [
                '        jwt_secret=os.environ.get("JWT_SECRET", ""),',
                '        jwt_algorithm=os.environ.get("JWT_ALGORITHM", "HS256"),',
                '        jwt_audience=os.environ.get("JWT_AUDIENCE") or None,',
                '        jwt_issuer=os.environ.get("JWT_ISSUER") or None,',
            ]
        )
    content = lines(
        py_docstring("Configuration read from the environment. Nothing secret has a default: see .env.example."),
        "",
        "import os",
        "from dataclasses import dataclass",
        "",
        "",
        "@dataclass(frozen=True)",
        "class Settings:",
        '    """Values the application needs from its environment."""',
        "",
        fields if fields else ["    pass"],
        "",
        "",
        "def get_settings() -> Settings:",
        '    """Reads the settings on every call, so a changed environment (tests, reloads) is always seen."""',
        ["    return Settings(", *reads, "    )"] if reads else "    return Settings()",
    )
    return {"path": "app/config.py", "content": file_text(content)}


def errors_file(context: FastApiContext) -> dict:
    imports = PyImports()
    imports.add("typing", "Any")
    imports.add("fastapi", "FastAPI", "Request")
    imports.add("fastapi.exceptions", "RequestValidationError")
    imports.add("fastapi.responses", "JSONResponse")
    imports.add("starlette.exceptions", "HTTPException as StarletteHTTPException")
    if context.sql:
        imports.add("sqlalchemy.exc", "IntegrityError")
        imports.add("logging")
    content = lines(
        py_docstring(
            'One error format for the whole API: {"error": {"code", "message", "details"}}, as described in openapi.yaml.'
        ),
        "",
        imports.render(),
        "",
        context.sql and ["logger = logging.getLogger(__name__)", "", ""],
        False if context.sql else "",
        "class ApiError(Exception):",
        '    """An error the API answers with a status, a code and a message."""',
        "",
        "    def __init__(self, status: int, code: str, message: str, details: list[dict[str, str]] | None = None) -> None:",
        "        super().__init__(message)",
        "        self.status = status",
        "        self.code = code",
        "        self.message = message",
        "        self.details = details",
        "",
        "",
        "class InvalidRequestError(ApiError):",
        "    def __init__(self, field: str, message: str) -> None:",
        '        super().__init__(400, "validation_error", "The request is not valid", [{"field": field, "message": message}])',
        "",
        "",
        "class UnauthorizedError(ApiError):",
        "    def __init__(self) -> None:",
        '        super().__init__(401, "unauthorized", "Missing or invalid credentials")',
        "",
        "",
        "class ForbiddenError(ApiError):",
        "    def __init__(self) -> None:",
        '        super().__init__(403, "forbidden", "The credentials do not allow this operation")',
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
        "def error_body(code: str, message: str, details: list[dict[str, str]] | None = None) -> dict[str, Any]:",
        '    error: dict[str, Any] = {"code": code, "message": message}',
        "    if details:",
        '        error["details"] = details',
        '    return {"error": error}',
        "",
        "",
        '_HTTP_CODES = {400: "validation_error", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: '
        + f"{py_string(GENERAL_ERROR_CODES[0])}}}",
        "",
        "",
        "def _field_of(location: tuple[Any, ...]) -> str:",
        '    """`("body", "address", "city")` → `address.city`: the place of the error in what the client sent."""',
        '    parts = [str(part) for part in location if part not in ("body", "query", "path", "header")]',
        '    return ".".join(parts) or "body"',
        "",
        "",
        "def register_error_handlers(app: FastAPI) -> None:",
        '    """Answers every error with the common format and the status of openapi.yaml."""',
        "",
        "    @app.exception_handler(ApiError)",
        "    async def api_error(_: Request, error: ApiError) -> JSONResponse:",
        "        return JSONResponse(error_body(error.code, error.message, error.details), status_code=error.status)",
        "",
        "    @app.exception_handler(RequestValidationError)",
        "    async def validation_error(_: Request, error: RequestValidationError) -> JSONResponse:",
        "        # Validation errors are 400, the same in every framework Model2API writes (FastAPI uses 422 by default)",
        '        details = [{"field": _field_of(tuple(item["loc"])), "message": item["msg"]} for item in error.errors()]',
        '        return JSONResponse(error_body("validation_error", "The request is not valid", details), status_code=400)',
        "",
        "    @app.exception_handler(StarletteHTTPException)",
        "    async def http_error(_: Request, error: StarletteHTTPException) -> JSONResponse:",
        '        code = _HTTP_CODES.get(error.status_code, "internal_error")',
        '        return JSONResponse(error_body(code, str(error.detail)), status_code=error.status_code, headers=getattr(error, "headers", None))',
        "",
        "    @app.exception_handler(NotImplementedError)",
        "    async def not_implemented(_: Request, error: NotImplementedError) -> JSONResponse:",
        '        message = str(error) or "The logic of this operation is not written yet"',
        '        return JSONResponse(error_body("not_implemented", message), status_code=501)',
        context.sql
        and [
            "",
            "    @app.exception_handler(IntegrityError)",
            "    async def integrity_error(_: Request, error: IntegrityError) -> JSONResponse:",
            "        # A key already used, or an item other items still refer to. The cause stays in the log, not in the answer",
            '        logger.warning("Integrity error: %s", error.orig)',
            '        return JSONResponse(error_body("conflict", "The change conflicts with the stored data"), status_code=409)',
        ],
    )
    return {"path": "app/errors.py", "content": file_text(content)}


def security_file(context: FastApiContext) -> dict | None:
    auth = context.settings["auth"]
    if auth == "none":
        return None
    if auth == "apiKey":
        content = lines(
            py_docstring("API key authentication: the key in the X-API-Key header must be one of API_KEYS."),
            "",
            "from secrets import compare_digest",
            "",
            "from fastapi import Security",
            "from fastapi.security import APIKeyHeader",
            "",
            "from app.config import get_settings",
            "from app.errors import UnauthorizedError",
            "",
            '_api_key = APIKeyHeader(name="X-API-Key", auto_error=False, scheme_name="apiKey")',
            "",
            "",
            "def require_api_key(key: str | None = Security(_api_key)) -> None:",
            '    """Lets the request through only with a configured key. Without API_KEYS, every request is rejected."""',
            "    keys = get_settings().api_keys",
            "    if not key or not any(compare_digest(key, valid) for valid in keys):",
            "        raise UnauthorizedError()",
        )
        return {"path": "app/security.py", "content": file_text(content)}
    content = lines(
        py_docstring(
            "Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them\n"
            'with JWT_SECRET (and JWT_AUDIENCE / JWT_ISSUER when set) and reads the roles from the "roles" claim.',
        ),
        "",
        "from dataclasses import dataclass",
        "",
        "import jwt",
        "from fastapi import Depends, Security",
        "from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer",
        "",
        "from app.config import get_settings",
        "from app.errors import ForbiddenError, UnauthorizedError",
        "",
        '_bearer = HTTPBearer(auto_error=False, scheme_name="bearer")',
        "",
        "",
        "@dataclass(frozen=True)",
        "class Principal:",
        '    """Who made the request, as the token says."""',
        "",
        "    subject: str",
        "    roles: frozenset[str]",
        "",
        "",
        "def current_principal(credentials: HTTPAuthorizationCredentials | None = Security(_bearer)) -> Principal:",
        '    """Verifies the token: signature, expiry (required) and, when configured, audience and issuer.',
        '    Without JWT_SECRET, every request is rejected."""',
        "    settings = get_settings()",
        "    if credentials is None or not settings.jwt_secret:",
        "        raise UnauthorizedError()",
        "    try:",
        "        claims = jwt.decode(",
        "            credentials.credentials,",
        "            settings.jwt_secret,",
        "            algorithms=[settings.jwt_algorithm],",
        "            audience=settings.jwt_audience,",
        "            issuer=settings.jwt_issuer,",
        '            options={"require": ["exp"]},',
        "        )",
        "    except jwt.PyJWTError as error:",
        "        raise UnauthorizedError() from error",
        '    roles = claims.get("roles", [])',
        "    if isinstance(roles, str):",
        "        roles = [roles]",
        '    return Principal(subject=str(claims.get("sub", "")), roles=frozenset(str(role) for role in roles))',
        "",
        "",
        "def require_roles(*roles: str):",
        '    """A dependency that lets the request through only if the token has one of `roles`."""',
        "",
        "    def dependency(principal: Principal = Depends(current_principal)) -> Principal:",
        "        if not principal.roles.intersection(roles):",
        "            raise ForbiddenError()",
        "        return principal",
        "",
        "    return dependency",
    )
    return {"path": "app/security.py", "content": file_text(content)}


def database_file(context: FastApiContext) -> dict | None:
    if not context.sql:
        return None
    content = lines(
        py_docstring("Database engine, sessions and the declarative base of the models (SQLAlchemy 2)."),
        "",
        "from collections.abc import Iterator",
        "",
        "from fastapi import Request",
        "from sqlalchemy import Engine, create_engine, event",
        "from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker",
        "",
        "",
        "class Base(DeclarativeBase):",
        '    """Base of every table."""',
        "",
        "",
        "def create_db_engine(url: str) -> Engine:",
        '    """An engine for the database at `url`. SQLite gets foreign keys turned on, as other databases have them."""',
        '    if url.startswith("sqlite"):',
        '        engine = create_engine(url, connect_args={"check_same_thread": False})',
        "",
        '        @event.listens_for(engine, "connect")',
        "        def _foreign_keys(connection, _record) -> None:  # type: ignore[no-untyped-def]",
        "            cursor = connection.cursor()",
        '            cursor.execute("PRAGMA foreign_keys=ON")',
        "            cursor.close()",
        "",
        "        return engine",
        "    return create_engine(url, pool_pre_ping=True)",
        "",
        "",
        "def get_session(request: Request) -> Iterator[Session]:",
        '    """One session per request, closed when the response is sent."""',
        "    factory: sessionmaker[Session] = request.app.state.session_factory",
        "    with factory() as session:",
        "        yield session",
    )
    return {"path": "app/db.py", "content": file_text(content)}


def dependencies_file(context: FastApiContext) -> dict:
    """Providers of repositories and services: the only place that decides which implementation is used."""
    imports = PyImports()
    imports.add("fastapi", "Depends", "Request")
    blocks: list[str] = []
    for resource in context.spec["resources"]:
        name = classes(resource)
        variable = names(resource)
        repository_module = context.layout.resource(resource, "repository")["module"]
        service_module = context.layout.resource(resource, "service")["module"]
        imports.add(repository_module, name["repository"])
        imports.add(service_module, name["service"])
        if context.sql:
            imports.add(repository_module, name["sqlRepository"])
            imports.add("sqlalchemy.orm", "Session")
            imports.add("app.db", "get_session")
            parameters = "session: Session = Depends(get_session)"
            body = [f"    return {name['sqlRepository']}(session)"]
        elif context.pending:
            imports.add(repository_module, name["pendingRepository"])
            parameters = ""
            body = [f"    return {name['pendingRepository']}()"]
        else:
            parameters = "request: Request"
            body = [f"    return request.app.state.repositories[{py_string(variable['one'])}]"]
        blocks.append(
            lines(
                f"def get_{variable['one']}_repository({parameters}) -> {name['repository']}:",
                f'    """The storage of {resource["plural"]}."""',
                body,
            )
        )
        params = [f"repository: {name['repository']} = Depends(get_{variable['one']}_repository)"]
        args = ["repository"]
        for target in referenced_resources(context, resource):
            target_name = classes(target)
            target_variable = names(target)
            imports.add(context.layout.resource(target, "repository")["module"], target_name["repository"])
            params.append(
                f"{target_variable['many']}: {target_name['repository']} = Depends(get_{target_variable['one']}_repository)"
            )
            args.append(target_variable["many"])
        blocks.append(
            lines(
                f"def get_{variable['one']}_service(",
                [f"    {param}," for param in params],
                f") -> {name['service']}:",
                f'    """The service of {resource["plural"]}, with the storage of the resources it refers to."""',
                f"    return {name['service']}({', '.join(args)})",
            )
        )
    if not context.sql and not context.pending:
        imports.add("fastapi", "Request")
    content = lines(
        py_docstring("Which repository and service each request uses. Change the implementations here."),
        "",
        imports.render(),
        "",
        "",
        "\n\n\n".join(blocks),
    )
    return {"path": "app/dependencies.py", "content": file_text(content)}


def referenced_resources(context: FastApiContext, resource: dict) -> list[dict]:
    """Resources a resource refers to, directly or inside its embedded objects, other than itself."""
    found: set[str] = set()

    def visit(fields: list[dict], seen: frozenset[str]) -> None:
        for field in fields:
            if field.get("reference"):
                found.add(field["reference"])
            inner = inner_object(field["type"])
            if inner and inner not in seen:
                spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None)
                if spec_object:
                    visit(spec_object["fields"], seen | {inner})

    visit(resource["fields"], frozenset())
    found.discard(resource["name"])
    return [item for item in context.spec["resources"] if item["name"] in found]


def inner_object(type_ref: dict) -> str | None:
    """The embedded object a type holds, directly or through lists and maps."""
    kind = type_ref["kind"]
    if kind == "object":
        return type_ref["name"]
    if kind == "array":
        return inner_object(type_ref["items"])
    if kind == "map":
        return inner_object(type_ref["value"])
    return None


def main_file(context: FastApiContext) -> dict:
    imports = PyImports()
    imports.add("fastapi", "FastAPI")
    imports.add("app.errors", "register_error_handlers")
    setup: list[str] = []
    resources = context.spec["resources"]
    if context.sql:
        imports.add("sqlalchemy.orm", "sessionmaker")
        imports.add("app.config", "get_settings")
        imports.add("app.db", "Base", "create_db_engine")
        for resource in resources:
            imports.add(context.layout.resource(resource, "models")["module"], classes(resource)["model"])
        tables = ", ".join(f"{classes(resource)['model']}.__table__" for resource in resources)
        setup.extend(
            [
                "    engine = create_db_engine(get_settings().database_url)",
                "    app.state.engine = engine",
                "    app.state.session_factory = sessionmaker(engine, expire_on_commit=False)",
                "    # Creates missing tables so the API runs at once; use migrations for a real database (Model2DB writes them)",
                f"    Base.metadata.create_all(engine, tables=[{tables}])",
            ]
        )
    elif not context.pending:
        entries = []
        for resource in resources:
            imports.add(context.layout.resource(resource, "repository")["module"], classes(resource)["memory"])
            entries.append(f"        {py_string(names(resource)['one'])}: {classes(resource)['memory']}(),")
        setup.extend(
            [
                "    # Data kept in memory while the application runs; restarting it starts empty",
                "    app.state.repositories = {",
                *entries,
                "    }",
            ]
        )
    routers = []
    for resource in resources:
        alias = f"{names(resource)['one']}_router"
        imports.add(context.layout.resource(resource, "router")["module"], f"router as {alias}")
        routers.append(f"    app.include_router({alias})")
    content = lines(
        py_docstring('Entry point of the API: run it with "uvicorn app.main:app --reload".'),
        "",
        imports.render(),
        "",
        "",
        "def create_app() -> FastAPI:",
        '    """Builds the application: error format, storage and the routes of every resource."""',
        "    app = FastAPI(",
        f"        title={py_string(context.spec['title'])},",
        '        version="0.1.0",',
        '        description="REST API generated by Model2API. Review it before using it in production.",',
        "    )",
        "    register_error_handlers(app)",
        setup,
        routers,
        "    return app",
        "",
        "",
        "app = create_app()",
    )
    return {"path": "app/main.py", "content": file_text(content)}
