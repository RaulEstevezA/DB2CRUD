"""The Swift generator: Swift with async/await + FluentKit 1 (Fluent without Vapor) data access layers, with no web
framework. Every file of the package, composed from the modules of this folder; each module writes one kind of file.
Mirrors web/src/core/generators/swift/generator.ts."""

from .context import create_context
from .dtos import dto_files, update_file
from .entities import entity_file, model_file
from .project import contract_file, env_example_file, gitignore_file, package_file, readme_file
from .repositories import repository_file
from .services import service_file
from .support import common_file, database_file, errors_file, unit_of_work_file
from .tests import test_files


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


def _generate(schema: dict, design: dict, settings: dict) -> list[dict]:
    context = create_context(schema, design, settings)
    return [
        readme_file(context),
        package_file(context),
        env_example_file(context),
        gitignore_file(),
        contract_file(context),
        *_code(context),
        *test_files(context),
    ]


SWIFT_GENERATOR = {"language": "swift", "orm": "fluent", "generate": _generate}
