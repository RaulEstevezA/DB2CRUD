"""A TypeScript generator for an ORM (Strategy of common/orm.py): every file of the project, composed from the
modules of common/ and the ORM's own database layer. Mirrors web/src/core/generators/typescript/common/generator.ts."""

from .context import create_context
from .dtos import dtos_file
from .project import contract_file, env_example_file, gitignore_file, package_file, readme_file, tsconfig_files
from .repositories import repository_file
from .services import service_file
from .support import errors_file, paging_file
from .tests import test_files
from .unit_of_work import unit_of_work_file


def _code(context: dict) -> list[dict]:
    files = [*context["orm"]["databaseFiles"](context), errors_file(), paging_file(context), unit_of_work_file(context)]
    settings = context["settings"]
    for info in context["tables"]:
        files.append(repository_file(context, info))
        if settings["services"] and info["service"]:
            if settings["serviceTypes"] == "dtos":
                files.append(dtos_file(context, info))
            files.append(service_file(context, info))
    return [file for file in files if file is not None]


def typescript_generator(orm: dict) -> dict:
    def generate(schema: dict, design: dict, settings: dict) -> list[dict]:
        context = create_context(orm, schema, design, settings)
        return [
            readme_file(context),
            package_file(context),
            *tsconfig_files(context),
            env_example_file(context),
            gitignore_file(context),
            contract_file(context),
            *_code(context),
            *test_files(context),
        ]

    return {"language": "typescript", "orm": orm["id"], "generate": generate}
