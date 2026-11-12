"""The files around the C# code: the solution (App.slnx), global.json (the Microsoft Testing Platform), the project of
the code (net10.0, EF Core 9 and the provider of the database) and the one of the tests (xUnit v3), the README, an
example environment, .gitignore and crud-contract.json for CRUD2Controller. Mirrors
web/src/core/generators/csharp/project.ts."""

import json

from ..types import lines
from .context import (
    common_namespace,
    errors_namespace,
    namespace_of,
    operation_name,
    service_class,
    writes_entities,
)
from .dtos import create_columns, create_dto, read_columns, read_dto, update_columns, update_namespace, update_type
from .support import default_connection

VERSIONS = {"efCore": "9.0.23", "npgsql": "9.0.4", "pomelo": "9.0.0", "xunit": "4.0.3"}

PROVIDERS = {
    "postgresql": ("Npgsql.EntityFrameworkCore.PostgreSQL", VERSIONS["npgsql"]),
    "mysql": ("Pomelo.EntityFrameworkCore.MySql", VERSIONS["pomelo"]),
    "mariadb": ("Pomelo.EntityFrameworkCore.MySql", VERSIONS["pomelo"]),
    "sqlite": ("Microsoft.EntityFrameworkCore.Sqlite", VERSIONS["efCore"]),
}


def _tests(context: dict) -> bool:
    return context["settings"]["tests"] != "none" and writes_entities(context)


def project_files(context: dict) -> list[dict]:
    provider, version = PROVIDERS.get(context["settings"]["database"], PROVIDERS["postgresql"])
    files = [
        {
            "path": "App.slnx",
            "content": lines(
                "<Solution>",
                '  <Project Path="src/App/App.csproj" />',
                _tests(context) and '  <Project Path="tests/App.Tests/App.Tests.csproj" />',
                "</Solution>",
                "",
            ),
        },
        {
            "path": "global.json",
            "content": json.dumps({"test": {"runner": "Microsoft.Testing.Platform"}}, indent=2) + "\n",
        },
        {
            "path": "src/App/App.csproj",
            "content": lines(
                '<Project Sdk="Microsoft.NET.Sdk">',
                "  <PropertyGroup>",
                "    <TargetFramework>net10.0</TargetFramework>",
                "    <Nullable>enable</Nullable>",
                "    <ImplicitUsings>enable</ImplicitUsings>",
                "    <RootNamespace>App</RootNamespace>",
                "  </PropertyGroup>",
                "  <ItemGroup>",
                f'    <PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="{VERSIONS["efCore"]}" />',
                f'    <PackageReference Include="{provider}" Version="{version}" />',
                "  </ItemGroup>",
                "</Project>",
                "",
            ),
        },
    ]
    if _tests(context):
        files.append(
            {
                "path": "tests/App.Tests/App.Tests.csproj",
                "content": lines(
                    '<Project Sdk="Microsoft.NET.Sdk">',
                    "  <PropertyGroup>",
                    "    <TargetFramework>net10.0</TargetFramework>",
                    "    <Nullable>enable</Nullable>",
                    "    <ImplicitUsings>enable</ImplicitUsings>",
                    "    <OutputType>Exe</OutputType>",
                    "    <IsPackable>false</IsPackable>",
                    "    <RootNamespace>App.Tests</RootNamespace>",
                    "    <!-- The tests share one database and run one after another: no cancellation to pass on -->",
                    "    <NoWarn>$(NoWarn);xUnit1051</NoWarn>",
                    "  </PropertyGroup>",
                    "  <ItemGroup>",
                    f'    <PackageReference Include="xunit.v3" Version="{VERSIONS["xunit"]}" />',
                    "  </ItemGroup>",
                    "  <ItemGroup>",
                    '    <ProjectReference Include="../../src/App/App.csproj" />',
                    "  </ItemGroup>",
                    "</Project>",
                    "",
                ),
            }
        )
    return files


def env_example_file(context: dict) -> dict:
    sqlite = context["settings"]["database"] == "sqlite"
    return {
        "path": ".env.example",
        "content": lines(
            "# Where the database is (a connection string)",
            f"DATABASE_CONNECTION={default_connection(context)}",
            "# The tests use SQLite in memory unless this names another database (it is emptied by the tests)"
            if sqlite
            else "# The database the tests use (it is emptied by the tests): one of the same kind as DATABASE_CONNECTION",
            "# TEST_DATABASE_CONNECTION=",
            "",
        ),
    }


def gitignore_file() -> dict:
    return {"path": ".gitignore", "content": lines("bin/", "obj/", ".env", "*.db", "")}


LABELS = {
    "transactions": {
        "operation": "one transaction per service operation, committed when it ends",
        "caller": "the caller owns the transaction: nothing commits",
        "repository": "every repository write is committed at once",
    },
    "paging": {
        "none": "lists return every row",
        "offset": "lists return pages by offset and limit",
        "cursor": "lists return pages after a key (cursor)",
    },
    "updates": {
        "patch": "updates take a Patch<T> per field: absent, null or a value",
        "full": "updates take every field that can change",
        "optional": "",
        "partial": "",
    },
}


def readme_file(context: dict) -> dict:
    settings = context["settings"]
    sqlite = settings["database"] == "sqlite"
    if settings["entities"] == "missing":
        entities = "written for the tables the input had no class for"
    elif settings["entities"] == "all":
        entities = "written for every table"
    else:
        entities = f"imported from `{settings['entitiesModule']}`"
    if settings["services"]:
        kind = (
            f"DTOs ({'classes' if settings['dtoKind'] == 'class' else 'records'})"
            if settings["serviceTypes"] == "dtos"
            else "the entities"
        )
        services = f"take and return {kind}; {LABELS['updates'][settings['updates']]}"
    else:
        services = "not written"
    if settings["architecture"] == "layer":
        layout = [
            "src/App/Entities/                one entity per table",
            "src/App/Repositories/            the repositories of each table",
            settings["services"] and "src/App/Services/                one service per table",
        ]
    else:
        layout = ["src/App/Tables/<table>/          entity, repositories and service of each table"]
    return {
        "path": "README.md",
        "content": lines(
            f"# {settings['name']}",
            "",
            "Data access layer generated by [DB2CRUD](https://github.com/RaulEstevezA/DB2CRUD) for a database that already exists: entities mapped with EF Core 9, repositories over `AppDbContext` and services, in C# for .NET 10. It does not create or migrate the database, and it depends on no web framework.",
            "",
            "## Settings",
            "",
            f"- Database: {settings['database']}.",
            f"- Entities: {entities}.",
            f"- Services: {services}.",
            f"- Transactions: {LABELS['transactions'][settings['transactions']]}.",
            f"- Lists: {LABELS['paging'][settings['paging']]}.",
            "",
            "## Layout",
            "",
            "```text",
            "src/App/AppDbContext.cs          the mapping of every table, as the database has it",
            "src/App/Database.cs              the options of DATABASE_CONNECTION",
            "src/App/IUnitOfWork.cs           the repositories of every table, and the transaction of each operation",
            "src/App/Errors/                  NotFoundException, ConflictException, ValidationFailedException: no HTTP codes",
            *layout,
            "tests/App.Tests/                 repositories against a database, services on the in-memory repositories",
            "crud-contract.json               what was written, for CRUD2Controller",
            "```",
            "",
            "## Running the tests",
            "",
            "```bash",
            sqlite and "dotnet test                                       # SQLite in memory",
            f'TEST_DATABASE_CONNECTION="{default_connection(context)}" dotnet test   # a real, disposable database: it is deleted and created again',
            "```",
            "",
            "Look for `TODO` in the code: each one marks a decision the input did not settle.",
            "",
        ),
    }


def _type_of(column: dict) -> dict:
    column_type = column["column"]["type"]
    result = {"kind": column_type["kind"], "cs": column["propType"]}
    if column_type["kind"] == "text" and column_type.get("length") is not None:
        result["length"] = column_type["length"]
    return result


def _fields(columns: list[dict], optional: bool) -> list[dict]:
    return [
        {"name": column["prop"], "type": _type_of(column), "nullable": optional or column["column"]["nullable"]}
        for column in columns
    ]


ERRORS_OF = {"NotFound": "notFound", "Conflict": "conflict", "ValidationFailed": "validation"}


def contract_file(context: dict) -> dict:
    dtos = context["settings"]["serviceTypes"] == "dtos"
    types = []
    for info in context["tables"]:
        types.append(
            {
                "name": info["entity"],
                "module": namespace_of(context, info, "entity"),
                "kind": "entity",
                "fields": _fields(info["columns"], False),
            }
        )
        writes = info["role"] == "entity" and info["service"]
        if dtos and writes:
            types.append(
                {
                    "name": create_dto(info),
                    "module": namespace_of(context, info, "dtos"),
                    "kind": "create",
                    "fields": _fields(create_columns(info), False),
                }
            )
        if writes:
            types.append(
                {
                    "name": update_type(context, info),
                    "module": update_namespace(context, info),
                    "kind": "update",
                    "updates": context["settings"]["updates"],
                    "fields": _fields(update_columns(info), True),
                }
            )
        if dtos and info["service"]:
            types.append(
                {
                    "name": read_dto(info),
                    "module": namespace_of(context, info, "dtos"),
                    "kind": "read",
                    "fields": _fields(read_columns(info), False),
                }
            )
    services = []
    for info in context["tables"]:
        if not info["service"]:
            continue
        operations = []
        for operation in info["operations"]:
            item = {"name": operation_name(context, operation), "kind": operation["kind"]}
            if operation["columns"]:
                item["by"] = operation["columns"]
            if operation.get("through"):
                item["through"] = operation["through"]
            item["errors"] = [ERRORS_OF[error] for error in operation["errors"]]
            operations.append(item)
        services.append(
            {"name": service_class(info), "module": namespace_of(context, info, "service"), "operations": operations}
        )
    contract = {
        "format": "crud-contract",
        "version": 1,
        "stack": {
            "language": "csharp",
            "orm": "efcore",
            "database": context["settings"]["database"],
            "execution": "async",
        },
        "transactions": context["settings"]["transactions"],
        "paging": context["settings"]["paging"],
        "types": types,
        "errors": [
            {"kind": "notFound", "name": "NotFoundException", "module": errors_namespace(context)},
            {"kind": "conflict", "name": "ConflictException", "module": errors_namespace(context)},
            {"kind": "validation", "name": "ValidationFailedException", "module": errors_namespace(context)},
        ],
        "common": common_namespace(context),
        "services": services,
    }
    return {"path": "crud-contract.json", "content": json.dumps(contract, indent=2, ensure_ascii=False) + "\n"}
