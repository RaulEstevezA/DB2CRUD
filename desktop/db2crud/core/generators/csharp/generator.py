"""The C# generator: .NET 10 + EF Core 9 data access layers over AppDbContext, with no web framework. Every file of the
project, composed from the modules of this folder. Mirrors web/src/core/generators/csharp/generator.ts."""

from .context import create_context
from .dtos import dto_files
from .entities import db_context_file, entity_file, pg_enums_file
from .project import contract_file, env_example_file, gitignore_file, project_files, readme_file
from .repositories import repository_files
from .services import service_file
from .support import common_files, database_file, error_files, unit_of_work_files
from .tests import test_files


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


def _generate(schema: dict, design: dict, settings: dict) -> list[dict]:
    context = create_context(schema, design, settings)
    return [
        readme_file(context),
        *project_files(context),
        env_example_file(context),
        gitignore_file(),
        contract_file(context),
        *_code(context),
        *test_files(context),
    ]


CSHARP_GENERATOR = {"language": "csharp", "orm": "efcore", "generate": _generate}
