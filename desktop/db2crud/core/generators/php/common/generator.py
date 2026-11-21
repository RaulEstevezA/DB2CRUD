"""A PHP generator for an ORM (Strategy of common/orm.py): every file of the project, composed from the modules of
common/ and the ORM's own entities, connection and repository bodies. Mirrors
web/src/core/generators/php/common/generator.ts."""

from ....conversions.plan import plan_conversions
from .context import create_context
from .conversions import conversion_files, conversion_test_file, models_namespace, service_plans
from .dtos import dto_files
from .project import composer_file, contract_file, env_example_file, gitignore_file, phpunit_file, readme_file
from .repositories import repository_files
from .services import service_file
from .support import common_files, error_files, unit_of_work_files
from .tests import can_make, database_members, test_files


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
    def generate(schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
        context = create_context(orm, schema, design, settings)
        plans = service_plans(context, plan_conversions(schema, design, models)) if models else []
        conversions = conversion_files(context, models["schema"], plans) if models else []
        tests = test_files(context)
        conversion_tests = (
            conversion_test_file(
                context,
                plans,
                models["schema"],
                lambda info: can_make(context, info),
                lambda uses: database_members(context, uses),
            )
            if models and tests and settings["tests"] in ("all", "services")
            else None
        )
        imported = bool(conversions) and settings["modelsSource"] == "import"
        files = [
            readme_file(context),
            composer_file(context, models_namespace(context) if imported else None),
            phpunit_file(context),
            env_example_file(context),
            gitignore_file(),
            contract_file(context),
            *_code(context),
            *conversions,
            *tests,
            conversion_tests,
        ]
        return [file for file in files if file is not None]

    return {"language": "php", "orm": orm["id"], "generate": generate}
