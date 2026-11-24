"""The Kotlin generator: data access layers in Kotlin on the JVM with no web framework, over Exposed or JDBC, the strategy
it is given. Every file of the project, composed from the modules of this folder; each module writes one kind of file. Mirrors
web/src/core/generators/kotlin/generator.ts."""

from ...conversions.plan import plan_conversions
from .context import create_context
from .conversions import conversion_files, conversion_test_file, service_plans
from .dtos import dto_files
from .project import contract_file, env_example_file, gitignore_file, gradle_files, readme_file
from .repositories import repository_files
from .services import service_file
from .support import common_files, errors_file, unit_of_work_files
from .tests import can_make, test_files


def _code(context: dict) -> list[dict]:
    files = [
        *context["orm"]["databaseFiles"](context),
        errors_file(context),
        *common_files(context),
        *unit_of_work_files(context),
    ]
    for info in context["tables"]:
        if info["writesEntity"]:
            files += context["orm"]["entityFiles"](context, info)
        files += repository_files(context, info)
        if context["settings"]["services"] and info["service"]:
            files += dto_files(context, info)
            files.append(service_file(context, info))
    return [file for file in files if file is not None]


def _generate(orm: dict, schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
    context = create_context(orm, schema, design, settings)
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


def kotlin_generator(orm: dict) -> dict:
    """The generator of Kotlin projects over this strategy."""

    def generate(schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
        return _generate(orm, schema, design, settings, models)

    return {"language": "kotlin", "orm": orm["id"], "generate": generate}
