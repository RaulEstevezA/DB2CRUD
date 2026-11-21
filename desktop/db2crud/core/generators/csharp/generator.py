"""The C# generator: .NET 10 + EF Core 9 data access layers over AppDbContext, with no web framework. Every file of the
project, composed from the modules of this folder. Mirrors web/src/core/generators/csharp/generator.ts."""

from ...conversions.plan import plan_conversions
from .context import create_context
from .conversions import conversion_files, conversion_test_file, service_plans
from .dtos import dto_files
from .entities import db_context_file, entity_file, pg_enums_file
from .project import contract_file, env_example_file, gitignore_file, project_files, readme_file
from .repositories import repository_files
from .services import service_file
from .support import common_files, database_file, error_files, unit_of_work_files
from .tests import can_make, database_members, test_files


def _code(context: dict) -> list[dict]:
    files = [
        db_context_file(context),
        pg_enums_file(context),
        database_file(context),
        *error_files(context),
        *common_files(context),
        *unit_of_work_files(context),
    ]
    for info in context["tables"]:
        if info["writesEntity"]:
            files.append(entity_file(context, info))
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
        conversion_test_file(
            context, plans, models["schema"], lambda info: can_make(context, info), database_members(context)
        )
        if models and tests and settings["tests"] in ("all", "services")
        else None
    )
    return [
        readme_file(context),
        *project_files(context, bool(conversions) and settings["modelsSource"] == "import"),
        env_example_file(context),
        gitignore_file(),
        contract_file(context),
        *_code(context),
        *conversions,
        *tests,
        *([conversion_tests] if conversion_tests else []),
    ]


CSHARP_GENERATOR = {"language": "csharp", "orm": "efcore", "generate": _generate}
