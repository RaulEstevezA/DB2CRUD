"""The C# generator: .NET 10 data access layers with no web framework, over EF Core, ADO.NET or the MongoDB driver, the
strategy it is given. Every file of the project, composed from the modules of this folder. Mirrors
web/src/core/generators/csharp/generator.ts."""

import re

from ...conversions.plan import plan_conversions
from .context import create_context
from .conversions import conversion_files, conversion_test_file, service_plans
from .dtos import dto_files
from .project import contract_file, env_example_file, gitignore_file, project_files, readme_file
from .repositories import repository_files
from .services import service_file
from .support import common_files, error_files, unit_of_work_files
from .tests import can_make, test_files


def _code(context: dict) -> list[dict]:
    files = [
        *context["orm"]["databaseFiles"](context),
        *error_files(context),
        *common_files(context),
        *unit_of_work_files(context),
    ]
    for info in context["tables"]:
        if info["writesEntity"]:
            files.append(context["orm"]["entityFile"](context, info))
        files += repository_files(context, info)
        if context["settings"]["services"] and info["service"]:
            files += dto_files(context, info)
            files.append(service_file(context, info))
    return [file for file in files if file is not None]


def _named(orm: dict, files: list[dict]) -> list[dict]:
    """The files with the database classes named as the strategy asks: `SqlUnitOfWork` is `MongoUnitOfWork` in a document
    database."""
    prefix = orm.get("prefix")
    if not prefix:
        return files

    def rename(text: str) -> str:
        return re.sub(r"\bSql(?=UnitOfWork\b|\w+Repository\b)", prefix, text)

    return [{**item, "path": rename(item["path"]), "content": rename(item["content"])} for item in files]


def _generate(orm: dict, schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
    context = create_context(orm, schema, design, settings)
    documents = bool(orm.get("documents"))
    plans = service_plans(context, plan_conversions(schema, design, models, documents)) if models else []
    conversions = conversion_files(context, models["schema"], plans) if models else []
    tests = test_files(context)
    conversion_tests = (
        conversion_test_file(
            context,
            plans,
            models["schema"],
            lambda info: can_make(context, info),
            context["orm"]["testMembers"](context),
        )
        if models and tests and settings["tests"] in ("all", "services")
        else None
    )
    files = [
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
    return _named(orm, files)


def csharp_generator(orm: dict) -> dict:
    """The generator of C# projects over this strategy."""

    def generate(schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
        return _generate(orm, schema, design, settings, models)

    return {"language": "csharp", "orm": orm["id"], "generate": generate}
