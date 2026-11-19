"""The files around the Rust code: Cargo.toml (SeaORM with the driver of the database, async-trait, the crates of the
column types, Tokio for the tests), the README, an example environment, .gitignore and crud-contract.json for
CRUD2Controller. Mirrors web/src/core/generators/rust/project.ts."""

import json
import re

from ..types import lines
from .context import module_of, operation_name, service_type, stored_type, writes_entities
from .dtos import create_columns, create_dto, read_columns, read_dto, update_columns, update_path, update_type
from .support import default_url

VERSIONS = {
    "seaOrm": "2.0.4",
    "asyncTrait": "0.1.92",
    "chrono": "0.4.45",
    "rustDecimal": "1.43.0",
    "uuid": "1.29.3",
    "tokio": "1.54.1",
}

DRIVERS = {
    "postgresql": "sqlx-postgres",
    "mysql": "sqlx-mysql",
    "mariadb": "sqlx-mysql",
    "sqlite": "sqlx-sqlite",
}


def _tests(context: dict) -> bool:
    return context["settings"]["tests"] != "none" and writes_entities(context)


def _crates(context: dict) -> set[str]:
    """The crates the column types come from."""
    return {column["crate"] for info in context["tables"] for column in info["columns"] if column["crate"]}


def cargo_file(context: dict) -> dict:
    used = _crates(context)
    features = [
        "macros",
        "runtime-tokio-rustls",
        DRIVERS.get(context["settings"]["database"], DRIVERS["postgresql"]),
        *(["with-chrono"] if "chrono" in used else []),
        *(["with-rust_decimal"] if "rust_decimal" in used else []),
        *(["with-uuid"] if "uuid" in used else []),
    ]
    listed = ", ".join(f'"{item}"' for item in features)
    return {
        "path": "Cargo.toml",
        "content": lines(
            "[package]",
            f'name = "{context["settings"]["name"]}"',
            'version = "0.1.0"',
            'edition = "2024"',
            "",
            "[dependencies]",
            f'async-trait = "{VERSIONS["asyncTrait"]}"',
            f'chrono = {{ version = "{VERSIONS["chrono"]}", default-features = false, features = ["clock", "std"] }}'
            if "chrono" in used
            else None,
            f'rust_decimal = "{VERSIONS["rustDecimal"]}"' if "rust_decimal" in used else None,
            f'sea-orm = {{ version = "{VERSIONS["seaOrm"]}", default-features = false, features = [{listed}] }}',
            f'uuid = {{ version = "{VERSIONS["uuid"]}", features = ["v4"] }}' if "uuid" in used else None,
            _tests(context)
            and [
                "",
                "[dev-dependencies]",
                f'tokio = {{ version = "{VERSIONS["tokio"]}", features = ["macros", "rt-multi-thread", "sync"] }}',
            ],
            "",
        ),
    }


def env_example_file(context: dict) -> dict:
    sqlite = context["settings"]["database"] == "sqlite"
    return {
        "path": ".env.example",
        "content": lines(
            "# Where the database is, and who connects",
            f"DATABASE_URL={default_url(context)}",
            "# The tests use SQLite in a new temporary file unless this names another database (it is emptied by the tests)"
            if sqlite
            else "# The database the tests use (it is emptied by the tests): one of the same kind as DATABASE_URL",
            "# TEST_DATABASE_URL=",
            "",
        ),
    }


def gitignore_file() -> dict:
    return {"path": ".gitignore", "content": lines("/target", ".env", "*.db", "")}


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
        "patch": "updates take a Patch per field: Absent, or set to a value that may be None",
        "optional": "updates take an Option<Option<T>> per field: None when not sent, Some(None) to empty it",
        "full": "updates take every field that can change",
        "partial": "",
    },
}


def readme_file(context: dict) -> dict:
    settings = context["settings"]
    sqlite = settings["database"] == "sqlite"
    if settings["entities"] == "missing":
        entities = "written for the tables the input had no type for"
    elif settings["entities"] == "all":
        entities = "written for every table"
    else:
        entities = f"imported from `{'::'.join(settings['entitiesModule'].split('.'))}`"
    if settings["services"]:
        takes = "DTOs" if settings["serviceTypes"] == "dtos" else "the entities"
        services = f"take and return {takes}; {LABELS['updates'][settings['updates']]}"
    else:
        services = "not written"
    return {
        "path": "README.md",
        "content": lines(
            f"# {settings['name']}",
            "",
            f"Data access layer generated by [DB2CRUD](https://github.com/RaulEstevezA/DB2CRUD) for a database that already exists: entities and SeaORM {VERSIONS['seaOrm']} descriptions of the tables, repositories and services, in asynchronous Rust. It does not create or migrate the database, and it depends on no web framework.",
            "",
            "## Settings",
            "",
            f"- Database: {settings['database']}.",
            f"- Entities: {entities}.",
            f"- Services: {services}; errors are `Result<T, DomainError>`.",
            f"- Transactions: {LABELS['transactions'][settings['transactions']]}.",
            f"- Lists: {LABELS['paging'][settings['paging']]}.",
            "",
            "## Layout",
            "",
            "```text",
            "src/database.rs          the connection of DATABASE_URL",
            "src/unit_of_work.rs      the repositories of every table, and the transactions",
            "src/errors.rs            DomainError: NotFound, Conflict, ValidationFailed, Database; no HTTP codes",
            [
                "src/entities/            one entity and one SeaORM description per table",
                "src/repositories/        the repositories of each table",
                settings["services"] and "src/services/            one service per table",
            ]
            if settings["architecture"] == "layer"
            else "src/<table>/              entity, SeaORM description, repositories and service of each table",
            _tests(context)
            and "tests/data/              repositories against a database, services on the in-memory repositories",
            "crud-contract.json       what was written, for CRUD2Controller",
            "```",
            "",
            "## Running the tests",
            "",
            "```bash",
            "cargo test                                  # SQLite in a temporary file" if sqlite else None,
            f'TEST_DATABASE_URL="{default_url(context)}" cargo test   # a real, disposable database: it is emptied',
            "```",
            "",
            "Look for `TODO` in the code: each one marks a decision the input did not settle.",
            "",
        ),
    }


def _type_of(column: dict) -> dict:
    column_type = column["column"]["type"]
    result = {"kind": column_type["kind"], "rust": stored_type(column)}
    if column_type["kind"] == "text" and column_type.get("length") is not None:
        result["length"] = column_type["length"]
    return result


def _fields(columns: list[dict], optional: bool) -> list[dict]:
    return [
        {"name": column["key"], "type": _type_of(column), "nullable": optional or column["column"]["nullable"]}
        for column in columns
    ]


def _crate_module(context: dict, module: str) -> str:
    """A module as other crates name it: crate::entities → data_access::entities."""
    return re.sub(r"^crate::", f"{context['crate']}::", module)


ERRORS_OF = {"NotFound": "notFound", "Conflict": "conflict", "ValidationFailed": "validation"}


def contract_file(context: dict) -> dict:
    dtos = context["settings"]["serviceTypes"] == "dtos"
    types = []
    for info in context["tables"]:
        types.append(
            {
                "name": info["entity"],
                "module": _crate_module(context, module_of(context, info, "entity")),
                "kind": "entity",
                "fields": _fields(info["columns"], True),
            }
        )
        writes = info["role"] == "entity" and info["service"]
        if dtos and writes:
            types.append(
                {
                    "name": create_dto(info),
                    "module": _crate_module(context, module_of(context, info, "dtos")),
                    "kind": "create",
                    "fields": _fields(create_columns(info), True),
                }
            )
        if writes:
            path = update_path(context, info)
            types.append(
                {
                    "name": update_type(context, info),
                    "module": _crate_module(context, path[: path.rindex("::")]),
                    "kind": "update",
                    "updates": context["settings"]["updates"],
                    "fields": _fields(update_columns(info), True),
                }
            )
        if dtos and info["service"]:
            types.append(
                {
                    "name": read_dto(info),
                    "module": _crate_module(context, module_of(context, info, "dtos")),
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
            {
                "name": service_type(info),
                "module": _crate_module(context, module_of(context, info, "service")),
                "operations": operations,
            }
        )
    errors_module = f"{context['crate']}::errors"
    contract = {
        "format": "crud-contract",
        "version": 1,
        "stack": {
            "language": "rust",
            "orm": "seaorm",
            "database": context["settings"]["database"],
            "execution": "async",
        },
        "transactions": context["settings"]["transactions"],
        "paging": context["settings"]["paging"],
        "types": types,
        "errors": [
            {"kind": "notFound", "name": "DomainError::NotFound", "module": errors_module},
            {"kind": "conflict", "name": "DomainError::Conflict", "module": errors_module},
            {"kind": "validation", "name": "DomainError::ValidationFailed", "module": errors_module},
        ],
        "common": f"{context['crate']}::common",
        "services": services,
    }
    return {"path": "crud-contract.json", "content": json.dumps(contract, indent=2, ensure_ascii=False) + "\n"}
