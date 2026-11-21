"""The Swift generator: Swift with async/await + FluentKit 1 (Fluent without Vapor) data access layers, with no web
framework. Every file of the package, composed from the modules of this folder; each module writes one kind of file.
Mirrors web/src/core/generators/swift/generator.ts."""

from ...conversions.plan import plan_conversions
from .context import create_context
from .conversions import conversion_files, conversion_test_file, models_path, models_target, service_plans
from .dtos import dto_files, update_file
from .entities import entity_file, model_file
from .project import contract_file, env_example_file, gitignore_file, package_file, readme_file
from .repositories import repository_file
from .services import service_file
from .support import common_file, database_file, errors_file, unit_of_work_file
from .tests import can_make, test_files


def _code(context: dict) -> list[dict]:
    files = [database_file(context), errors_file(context), common_file(context), unit_of_work_file(context)]
    for info in context["tables"]:
        if info["writesEntity"]:
            files += [entity_file(context, info), model_file(context, info)]
        files.append(repository_file(context, info))
        if context["settings"]["services"] and info["service"]:
            if context["settings"]["serviceTypes"] == "dtos":
                files += dto_files(context, info)
            if info["role"] == "entity":
                files.append(update_file(context, info))
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
    target = (
        {
            "target": models_target(context),
            "path": models_path(context),
            "imported": settings["modelsSource"] == "import",
        }
        if conversions
        else None
    )
    return [
        readme_file(context),
        package_file(context, target),
        env_example_file(context),
        gitignore_file(),
        contract_file(context),
        *_code(context),
        *conversions,
        *tests,
        *([conversion_tests] if conversion_tests else []),
    ]


SWIFT_GENERATOR = {"language": "swift", "orm": "fluent", "generate": _generate}
