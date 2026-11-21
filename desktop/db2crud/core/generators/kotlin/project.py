"""The files around the Kotlin code: the Gradle build (Kotlin on the JVM, Exposed, the JDBC driver of the database and
kotlin.test on JUnit), the README, an example environment, .gitignore and crud-contract.json for CRUD2Controller.
Mirrors web/src/core/generators/kotlin/project.ts."""

import json

from ..types import lines
from .context import (
    common_package,
    errors_package,
    operation_name,
    package_of,
    service_class,
    stored_type,
    writes_entities,
)
from .dtos import create_columns, create_dto, read_columns, read_dto, update_columns, update_package, update_type
from .entities import uses_enum_columns
from .support import default_url

VERSIONS = {
    "kotlin": "2.4.21",
    "exposed": "1.6.1",
    "junit": "6.1.3",
    "postgresql": "42.7.14",
    "mysql": "26.10.0",
    "mariadb": "3.5.11",
    "sqlite": "3.54.1.0",
}

DRIVERS = {
    "postgresql": f"org.postgresql:postgresql:{VERSIONS['postgresql']}",
    "mysql": f"com.mysql:mysql-connector-j:{VERSIONS['mysql']}",
    "mariadb": f"org.mariadb.jdbc:mariadb-java-client:{VERSIONS['mariadb']}",
    "sqlite": f"org.xerial:sqlite-jdbc:{VERSIONS['sqlite']}",
}


def _tests(context: dict) -> bool:
    return context["settings"]["tests"] != "none" and writes_entities(context)


def gradle_files(context: dict, models_folder: bool = False) -> list[dict]:
    """The Gradle files; `models_folder` when the copy of the imported application models is in application-models/."""
    driver = DRIVERS.get(context["settings"]["database"], DRIVERS["postgresql"])
    # The column type of PostgreSQL's enums sends a PGobject: the driver is needed to compile, not only to run
    driver_scope = "implementation" if uses_enum_columns(context) else "runtimeOnly"
    tests = _tests(context)
    return [
        {"path": "settings.gradle.kts", "content": lines(f'rootProject.name = "{context["settings"]["name"]}"', "")},
        {
            "path": "build.gradle.kts",
            "content": lines(
                "plugins {",
                f'    kotlin("jvm") version "{VERSIONS["kotlin"]}"',
                "}",
                "",
                "repositories {",
                "    mavenCentral()",
                "}",
                "",
                "dependencies {",
                f'    implementation("org.jetbrains.exposed:exposed-core:{VERSIONS["exposed"]}")',
                f'    implementation("org.jetbrains.exposed:exposed-jdbc:{VERSIONS["exposed"]}")',
                f'    implementation("org.jetbrains.exposed:exposed-java-time:{VERSIONS["exposed"]}")',
                f'    {driver_scope}("{driver}")',
                tests
                and [
                    '    testImplementation(kotlin("test"))',
                    f'    testImplementation(platform("org.junit:junit-bom:{VERSIONS["junit"]}"))',
                    '    testImplementation("org.junit.jupiter:junit-jupiter")',
                    '    testRuntimeOnly("org.junit.platform:junit-platform-launcher")',
                ],
                "}",
                "",
                "kotlin {",
                "    jvmToolchain(21)",
                models_folder
                and [
                    "    // The copy of the application models, while the project runs on its own: delete the folder inside"
                    " the application",
                    '    if (file("application-models").exists())'
                    ' sourceSets.getByName("main").kotlin.srcDir("application-models/src/main/kotlin")',
                ],
                "}",
                tests
                and [
                    "",
                    "tasks.test {",
                    "    useJUnitPlatform()",
                    "    // Every test empties the same database: they run one after another",
                    "    maxParallelForks = 1",
                    "}",
                ],
                "",
            ),
        },
    ]


def env_example_file(context: dict) -> dict:
    sqlite = context["settings"]["database"] == "sqlite"
    return {
        "path": ".env.example",
        "content": lines(
            "# Where the database is (a JDBC URL), and who connects",
            f"DATABASE_URL={default_url(context)}",
            None if sqlite else ["DATABASE_USER=app", "DATABASE_PASSWORD=app"],
            "# The tests use SQLite in a temporary file unless this names another database (it is emptied by the tests)"
            if sqlite
            else "# The database the tests use (it is emptied by the tests): one of the same kind as DATABASE_URL",
            "# TEST_DATABASE_URL=",
            None if sqlite else ["# TEST_DATABASE_USER=", "# TEST_DATABASE_PASSWORD="],
            "",
        ),
    }


def gitignore_file() -> dict:
    return {"path": ".gitignore", "content": lines("build/", ".gradle/", ".kotlin/", ".env", "*.db", "")}


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
        "patch": "updates take a Patch per field: absent, or a value that may be null",
        "optional": "updates take an Optional per field: null when not sent, Optional.empty() to empty it",
        "full": "updates take every field that can change",
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
        takes = (
            f"DTOs ({'classes' if settings['dtoKind'] == 'class' else 'data classes'})"
            if settings["serviceTypes"] == "dtos"
            else "the entities"
        )
        services = f"take and return {takes}; {LABELS['updates'][settings['updates']]}"
    else:
        services = "not written"
    users = "" if sqlite else " TEST_DATABASE_USER=app TEST_DATABASE_PASSWORD=app"
    return {
        "path": "README.md",
        "content": lines(
            f"# {settings['name']}",
            "",
            f"Data access layer generated by [DB2CRUD](https://github.com/RaulEstevezA/DB2CRUD) for a database that already exists: entities and table objects for Exposed {VERSIONS['exposed']}, repositories and services, in Kotlin on the JVM. It does not create or migrate the database, and it depends on no web framework.",
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
            "src/main/kotlin/app/AppDatabase.kt      the connection of DATABASE_URL",
            "src/main/kotlin/app/UnitOfWork.kt       the repositories of every table, and the transaction of each operation",
            "src/main/kotlin/app/errors/             NotFoundException, ConflictException, ValidationFailedException: no HTTP codes",
            [
                "src/main/kotlin/app/entities/           one entity and one table object per table",
                "src/main/kotlin/app/repositories/       the repositories of each table",
                settings["services"] and "src/main/kotlin/app/services/           one service per table",
            ]
            if settings["architecture"] == "layer"
            else "src/main/kotlin/app/<table>/            entity, table object, repositories and service of each table",
            _tests(context)
            and "src/test/kotlin/app/                    repositories against a database, services on the in-memory repositories",
            "crud-contract.json                      what was written, for CRUD2Controller",
            "```",
            "",
            "## Running the tests",
            "",
            "```bash",
            "gradle test                                       # SQLite in a temporary file" if sqlite else None,
            f'TEST_DATABASE_URL="{default_url(context)}"{users} gradle test   # a real, disposable database: it is emptied',
            "```",
            "",
            "Look for `TODO` in the code: each one marks a decision the input did not settle.",
            "",
        ),
    }


def _type_of(column: dict) -> dict:
    column_type = column["column"]["type"]
    result = {"kind": column_type["kind"], "kotlin": stored_type(column)}
    if column_type["kind"] == "text" and column_type.get("length") is not None:
        result["length"] = column_type["length"]
    return result


def _fields(columns: list[dict], optional: bool) -> list[dict]:
    return [
        {"name": column["key"], "type": _type_of(column), "nullable": optional or column["column"]["nullable"]}
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
                "module": package_of(context, info, "entity"),
                "kind": "entity",
                "fields": _fields(info["columns"], True),
            }
        )
        writes = info["role"] == "entity" and info["service"]
        if dtos and writes:
            types.append(
                {
                    "name": create_dto(info),
                    "module": package_of(context, info, "dtos"),
                    "kind": "create",
                    "fields": _fields(create_columns(info), True),
                }
            )
        if writes:
            types.append(
                {
                    "name": update_type(context, info),
                    "module": update_package(context, info),
                    "kind": "update",
                    "updates": context["settings"]["updates"],
                    "fields": _fields(update_columns(info), True),
                }
            )
        if dtos and info["service"]:
            types.append(
                {
                    "name": read_dto(info),
                    "module": package_of(context, info, "dtos"),
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
            {"name": service_class(info), "module": package_of(context, info, "service"), "operations": operations}
        )
    contract = {
        "format": "crud-contract",
        "version": 1,
        "stack": {
            "language": "kotlin",
            "orm": "exposed",
            "database": context["settings"]["database"],
            "execution": "sync",
        },
        "transactions": context["settings"]["transactions"],
        "paging": context["settings"]["paging"],
        "types": types,
        "errors": [
            {"kind": "notFound", "name": "NotFoundException", "module": errors_package(context)},
            {"kind": "conflict", "name": "ConflictException", "module": errors_package(context)},
            {"kind": "validation", "name": "ValidationFailedException", "module": errors_package(context)},
        ],
        "common": common_package(context),
        "services": services,
    }
    return {"path": "crud-contract.json", "content": json.dumps(contract, indent=2, ensure_ascii=False) + "\n"}
