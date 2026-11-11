"""NestJS generator: writes a TypeScript project with NestJS 11, class-validator and, when chosen, TypeORM. It
composes the modules of this folder; each writes one kind of file. Mirrors
web/src/core/generators/frameworks/nestjs/index.ts.
"""

from .app import app_module_file, common_files, database_file, main_file, setup_file
from .context import create_context
from .dto import dto_file, shared_file
from .project import env_example_file, gitignore_file, package_file, readme_file, tsconfig_files
from .resource import controller_file, module_file, repository_file, service_file
from .tests import test_files
from .typeorm import entity_file


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    code = [
        main_file(),
        setup_file(),
        app_module_file(context),
        database_file(context),
        *common_files(context),
        shared_file(context),
    ]
    for resource in spec["resources"]:
        code.extend(
            [
                dto_file(context, resource),
                entity_file(context, resource),
                repository_file(context, resource),
                service_file(context, resource),
                controller_file(context, resource),
                module_file(context, resource),
            ]
        )
    return [
        readme_file(context),
        package_file(context),
        *tsconfig_files(),
        env_example_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        *(file for file in code if file is not None),
        *test_files(context),
    ]


NESTJS_GENERATOR = {"framework": "nestjs", "serverUrl": "http://localhost:3000", "generate": _generate}
