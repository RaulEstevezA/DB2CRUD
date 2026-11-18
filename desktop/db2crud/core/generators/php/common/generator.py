"""A PHP generator for an ORM (Strategy of common/orm.py): every file of the project, composed from the modules of
common/ and the ORM's own entities, connection and repository bodies. Mirrors
web/src/core/generators/php/common/generator.ts."""

from .context import create_context
from .dtos import dto_files
from .project import composer_file, contract_file, env_example_file, gitignore_file, phpunit_file, readme_file
from .repositories import repository_files
from .services import service_file
from .support import common_files, error_files, unit_of_work_files
from .tests import test_files


def _code(context: dict) -> list[dict]:
    files = [
        *context["orm"]["databaseFiles"](context),
        *error_files(context),
        *common_files(context),
        *unit_of_work_files(context),
    ]
    settings = context["settings"]
    for info in context["tables"]:
        if info["writesEntity"]:
            files.append(context["orm"]["entityFile"](context, info))
        files.extend(repository_files(context, info))
        if settings["services"] and info["service"]:
            files.extend(dto_files(context, info))
            files.append(service_file(context, info))
    return [file for file in files if file is not None]


def php_generator(orm: dict) -> dict:
    def generate(schema: dict, design: dict, settings: dict) -> list[dict]:
        context = create_context(orm, schema, design, settings)
        files = [
            readme_file(context),
            composer_file(context),
            phpunit_file(context),
            env_example_file(context),
            gitignore_file(),
            contract_file(context),
            *_code(context),
            *test_files(context),
        ]
        return [file for file in files if file is not None]

    return {"language": "php", "orm": orm["id"], "generate": generate}
