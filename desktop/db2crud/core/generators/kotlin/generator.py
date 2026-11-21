"""The Kotlin generator: Kotlin on the JVM + Exposed 1.6 (its DSL over JDBC) data access layers, with no web framework.
Every file of the project, composed from the modules of this folder; each module writes one kind of file. Mirrors
web/src/core/generators/kotlin/generator.ts."""

from ...conversions.plan import plan_conversions
from .context import create_context
from .conversions import conversion_files, conversion_test_file, service_plans
from .dtos import dto_files
from .entities import entity_file, enum_column_file, table_object_file
from .project import contract_file, env_example_file, gitignore_file, gradle_files, readme_file
from .repositories import repository_files
from .services import service_file
from .support import common_files, database_file, errors_file, unit_of_work_files
from .tests import can_make, test_files


def _code(context: dict) -> list[dict]:
    files = [
        database_file(context),
        errors_file(context),
        enum_column_file(context),
        *common_files(context),
        *unit_of_work_files(context),
    ]
    for info in context["tables"]:
        if info["writesEntity"]:
            files += [entity_file(context, info), table_object_file(context, info)]
        files += repository_files(context, info)
        if context["settings"]["services"] and info["service"]:
            files += dto_files(context, info)
            files.append(service_file(context, info))
    return [file for file in files if file is not None]


def _generate(schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
    context = create_context(schema, design, settings)
    plans = service_plans(context, plan_conversions(schema, design, models)) if models else []
    conversions = conversion_files(context, models["schema"], plans) if models else []
    tests = test_files(context)
    conversion_tests = (
        conversion_test_file(context, plans, models["schema"], lambda info: can_make(context, info))
        if models and tests and settings["tests"] in ("all", "services")
        else None
    )
    return [
        readme_file(context),
        *gradle_files(context, bool(conversions) and settings["modelsSource"] == "import"),
        env_example_file(context),
        gitignore_file(),
        contract_file(context),
        *_code(context),
        *conversions,
        *tests,
        *([conversion_tests] if conversion_tests else []),
    ]


KOTLIN_GENERATOR = {"language": "kotlin", "orm": "exposed", "generate": _generate}
