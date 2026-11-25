"""A TypeScript generator for an ORM (Strategy of common/orm.py): every file of the project, composed from the
modules of common/ and the ORM's own database layer. Mirrors web/src/core/generators/typescript/common/generator.ts."""

import re

from ....conversions.plan import plan_conversions
from .context import create_context
from .conversions import conversion_files, conversion_test_file, service_plans
from .documents import documents_file
from .dtos import dtos_file
from .project import contract_file, env_example_file, gitignore_file, package_file, readme_file, tsconfig_files
from .repositories import repository_file
from .services import service_file
from .support import errors_file, paging_file
from .tests import can_make, test_files
from .unit_of_work import unit_of_work_file


def _code(context: dict) -> list[dict]:
    files = [
        *context["orm"]["databaseFiles"](context),
        errors_file(),
        paging_file(context),
        documents_file(context),
        unit_of_work_file(context),
    ]
    settings = context["settings"]
    for info in context["tables"]:
        files.append(repository_file(context, info))
        if settings["services"] and info["service"]:
            if settings["serviceTypes"] == "dtos":
                files.append(dtos_file(context, info))
            files.append(service_file(context, info))
    return [file for file in files if file is not None]


def _named(orm: dict, files: list[dict]) -> list[dict]:
    """The files with the database classes named as the ORM asks: SqlUnitOfWork is MongoUnitOfWork in a document database."""
    prefix = orm.get("prefix")
    if not prefix:
        return files

    def rename(text: str) -> str:
        text = re.sub(r"\bSql(?=UnitOfWork\b|\w+Repository\b)", prefix, text)
        return re.sub(r"\bsqlUow\b", f"{prefix[0].lower()}{prefix[1:]}Uow", text)

    return [{**file, "content": rename(file["content"])} for file in files]


def typescript_generator(orm: dict) -> dict:
    def generate(schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
        context = create_context(orm, schema, design, settings)
        documents = settings["database"] == "mongodb"
        plans = service_plans(context, plan_conversions(schema, design, models, documents)) if models else []
        tests = test_files(context)
        conversion_tests = (
            conversion_test_file(
                context, plans, models["schema"] if models else None, lambda info: can_make(context, info)
            )
            if tests and settings["tests"] in ("all", "services")
            else None
        )
        files = [
            readme_file(context),
            package_file(context),
            *tsconfig_files(context),
            env_example_file(context),
            gitignore_file(context),
            contract_file(context),
            *_code(context),
            *(conversion_files(context, models["schema"], plans) if models else []),
            *tests,
            *([conversion_tests] if conversion_tests else []),
        ]
        return _named(orm, files)

    return {"language": "typescript", "orm": orm["id"], "generate": generate}
