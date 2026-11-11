"""Project files of the ASP.NET Core project: the solution and the two projects (the API and its tests), the
settings (appsettings.json, launchSettings.json), ignore rules and the README. Mirrors
web/src/core/generators/frameworks/aspnetCore/project.ts.
"""

import json

from ...common.text import file_text, lines
from .context import AspNetContext

DOTNET = "net10.0"
ASPNET_VERSION = "10.0.14"
EF_CORE_VERSION = "10.0.14"
NPGSQL_VERSION = "10.0.3"
MYSQL_VERSION = "10.0.12"
XUNIT_VERSION = "4.0.2"

# The EF Core provider of each database
_PROVIDERS = {
    "postgresql": ("Npgsql.EntityFrameworkCore.PostgreSQL", NPGSQL_VERSION),
    "mysql": ("MySql.EntityFrameworkCore", MYSQL_VERSION),
    "mariadb": ("MySql.EntityFrameworkCore", MYSQL_VERSION),
    "sqlite": ("Microsoft.EntityFrameworkCore.Sqlite", EF_CORE_VERSION),
}

# Connection strings to start from, for a database on this computer
CONNECTIONS = {
    "postgresql": "Host=localhost;Port=5432;Database=api;Username=api;Password=change-me",
    "mysql": "Server=localhost;Port=3306;Database=api;User ID=api;Password=change-me",
    "mariadb": "Server=localhost;Port=3306;Database=api;User ID=api;Password=change-me",
    "sqlite": "Data Source=app.db",
}


def _package_reference(name: str, version: str) -> str:
    return f'    <PackageReference Include="{name}" Version="{version}" />'


def _json(value) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False)


def project_files(context: AspNetContext) -> list[dict]:
    root = context.root
    auth = context.settings["auth"]
    database = context.settings.get("database") or "postgresql"
    provider = _PROVIDERS[database] if context.ef_core else None
    references = [
        item
        for item in [
            auth == "jwt" and _package_reference("Microsoft.AspNetCore.Authentication.JwtBearer", ASPNET_VERSION),
            context.ef_core and _package_reference("Microsoft.EntityFrameworkCore", EF_CORE_VERSION),
            context.ef_core and _package_reference("Microsoft.EntityFrameworkCore.Relational", EF_CORE_VERSION),
            provider and _package_reference(*provider),
        ]
        if isinstance(item, str)
    ]
    api = lines(
        '<Project Sdk="Microsoft.NET.Sdk.Web">',
        "",
        "  <PropertyGroup>",
        f"    <TargetFramework>{DOTNET}</TargetFramework>",
        "    <Nullable>enable</Nullable>",
        "    <ImplicitUsings>enable</ImplicitUsings>",
        f"    <RootNamespace>{root}</RootNamespace>",
        "  </PropertyGroup>",
        bool(references) and ["", "  <ItemGroup>", references, "  </ItemGroup>"],
        "",
        "</Project>",
    )
    tests = lines(
        '<Project Sdk="Microsoft.NET.Sdk">',
        "",
        "  <PropertyGroup>",
        f"    <TargetFramework>{DOTNET}</TargetFramework>",
        "    <Nullable>enable</Nullable>",
        "    <ImplicitUsings>enable</ImplicitUsings>",
        "    <OutputType>Exe</OutputType>",
        "    <IsPackable>false</IsPackable>",
        f"    <RootNamespace>{root}.Tests</RootNamespace>",
        "  </PropertyGroup>",
        "",
        "  <ItemGroup>",
        _package_reference("Microsoft.AspNetCore.Mvc.Testing", ASPNET_VERSION),
        context.ef_core
        and context.settings.get("database") != "sqlite"
        and _package_reference("Microsoft.EntityFrameworkCore.Sqlite", EF_CORE_VERSION),
        _package_reference("xunit.v3", XUNIT_VERSION),
        "  </ItemGroup>",
        "",
        "  <ItemGroup>",
        f'    <ProjectReference Include="../../src/{root}/{root}.csproj" />',
        "  </ItemGroup>",
        "",
        "</Project>",
    )
    solution = lines(
        "<Solution>",
        '  <Folder Name="/src/">',
        f'    <Project Path="src/{root}/{root}.csproj" />',
        "  </Folder>",
        '  <Folder Name="/tests/">',
        f'    <Project Path="tests/{root}.Tests/{root}.Tests.csproj" />',
        "  </Folder>",
        "</Solution>",
    )
    settings = {
        "Logging": {"LogLevel": {"Default": "Information", "Microsoft.AspNetCore": "Warning"}},
        "AllowedHosts": "*",
        **({"DATABASE_CONNECTION": CONNECTIONS[database]} if context.ef_core else {}),
        **({"API_KEYS": ""} if auth == "apiKey" else {}),
        **({"JWT_SECRET": "", "JWT_AUDIENCE": "", "JWT_ISSUER": ""} if auth == "jwt" else {}),
    }
    launch = {
        "profiles": {
            "http": {
                "commandName": "Project",
                "launchBrowser": False,
                "applicationUrl": "http://localhost:5000",
                "environmentVariables": {"ASPNETCORE_ENVIRONMENT": "Development"},
            }
        }
    }
    # dotnet test runs the tests with Microsoft.Testing.Platform, which xUnit v3 uses
    global_settings = {"test": {"runner": "Microsoft.Testing.Platform"}}
    return [
        {"path": "global.json", "content": file_text(_json(global_settings))},
        {"path": f"{root}.slnx", "content": file_text(solution)},
        {"path": f"src/{root}/{root}.csproj", "content": file_text(api)},
        {"path": f"src/{root}/appsettings.json", "content": file_text(_json(settings))},
        {"path": f"src/{root}/Properties/launchSettings.json", "content": file_text(_json(launch))},
        {"path": f"tests/{root}.Tests/{root}.Tests.csproj", "content": file_text(tests)},
    ]


def gitignore_file() -> dict:
    return {
        "path": ".gitignore",
        "content": file_text(
            lines("bin/", "obj/", "TestResults/", "*.db", "*.user", ".vs/", ".idea/", ".vscode/", ".DS_Store")
        ),
    }


def _endpoint_rows(resources: list[dict]) -> list[str]:
    rows = []
    for resource in resources:
        for endpoint in resource["endpoints"]:
            access = f"roles: {', '.join(endpoint['roles'])}" if endpoint["access"] == "roles" else endpoint["access"]
            rows.append(
                f"| `{endpoint['method']}` | `{endpoint['path']}` | {endpoint['summary']} | {endpoint['status']} | {access} |"
            )
    return rows


def readme_file(context: AspNetContext) -> dict:
    settings = context.settings
    spec = context.spec
    root = context.root
    pending: list[str] = []
    if context.pending:
        pending.append("- Storage: every repository answers 501 until you write it (search for `TODO`).")
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
    database = settings.get("database")
    if settings["persistence"] == "memory":
        storage = (
            "Data is kept in memory while the application runs and is lost when it stops. Write another "
            "implementation of each repository interface and register it in `Program.cs`."
        )
    elif settings["persistence"] == "none":
        storage = (
            "Storage is left to you: each repository is an interface whose methods answer 501 until you implement them."
        )
    else:
        storage = (
            f"Entity Framework Core on {database}. The application creates the tables when the database has none "
            "(`EnsureCreated`); for a real database, use migrations (`dotnet ef migrations add Initial`, or Model2DB). "
            "Embedded objects and lists are stored as JSON columns, and references as key columns."
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
            "Protected endpoints need a bearer token issued by your identity provider, signed with HS256. The API "
            "verifies it with `JWT_SECRET` (at least 32 bytes; and `JWT_AUDIENCE` / `JWT_ISSUER` when set), requires "
            "an expiry, and reads the roles from the `roles` claim. It does not issue tokens."
        )
    variables = [
        item
        for item in [
            context.ef_core and "`DATABASE_CONNECTION` (the connection string)",
            settings["auth"] == "apiKey" and "`API_KEYS`",
            settings["auth"] == "jwt" and "`JWT_SECRET`, `JWT_AUDIENCE`, `JWT_ISSUER`",
        ]
        if item
    ]
    if settings["architecture"] == "modular":
        layout = [
            f"src/{root}/",
            "  Common/              errors, lists, request bodies and JSON helpers",
            "  Shared/              enums and embedded objects",
            "  Features/<Resource>/ model, request and response, repository, service and controller of one resource",
            context.ef_core and "  Data/                the database context",
            context.security and "  Security/            authentication",
        ]
    else:
        layout = [
            f"src/{root}/",
            "  Common/              errors, lists, request bodies and JSON helpers",
            "  Models/              domain classes, enums and embedded objects",
            "  Dtos/                request bodies and responses",
            "  Repositories/        storage",
            "  Services/            rules of each resource",
            "  Controllers/         HTTP routes",
            context.ef_core and "  Data/                the database context",
            context.security and "  Security/            authentication",
        ]
    content = lines(
        f"# {spec['title']}",
        "",
        "REST API generated by [Model2API](https://raulesteveza.github.io/tools/Model2API/) with ASP.NET Core. It is "
        "a starting point: review it before using it in production.",
        "",
        "## Run it",
        "",
        "Requires the .NET 10 SDK.",
        "",
        "```bash",
        f"dotnet run --project src/{root}",
        "```",
        "",
        bool(variables)
        and f"Settings are read from `src/{root}/appsettings.json` and, above it, from environment variables with the "
        f"same names: {', '.join(variables)}. Never commit real values.",
        "",
        "The API listens on http://localhost:5000. Its contract is in `openapi.yaml`.",
        "",
        "## Test it",
        "",
        "```bash",
        "dotnet test",
        "```",
        "",
        "Each test starts the application anew, so it starts with empty storage.",
        context.ef_core
        and f"The tests use a new SQLite file for each test, or the {database} database in `TEST_DATABASE_CONNECTION` "
        "(a connection string to a database only for tests: each test deletes and creates it again).",
        "",
        "## Endpoints",
        "",
        "| Method | Path | What it does | Success | Access |",
        "|---|---|---|---|---|",
        _endpoint_rows(spec["resources"]),
        "",
        'Errors always have the same body: `{"error": {"code": "...", "message": "...", "details": [...]}}`. Invalid '
        "requests answer 400.",
        "",
        "## Storage",
        "",
        storage,
        "",
        "## Authentication",
        "",
        auth,
        "",
        "## Structure",
        "",
        "```text",
        layout,
        f"tests/{root}.Tests/    one test class per resource",
        "openapi.yaml             the contract of the API",
        "```",
        "",
        "## Left to you",
        "",
        pending if pending else "- Nothing marked: review the generated code before using it.",
    )
    return {"path": "README.md", "content": file_text(content)}
