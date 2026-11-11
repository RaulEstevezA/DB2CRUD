"""Express generator: writes a TypeScript project with Express 5 and Zod 4. It composes the modules of this folder;
each writes one kind of file. Mirrors web/src/core/generators/frameworks/express/index.ts.
"""

from .app import app_file, config_file, errors_file, listing_file, security_file, server_file
from .context import create_context
from .persistence import repository_file
from .project import env_example_file, gitignore_file, package_file, readme_file, tsconfig_files, vitest_config_file
from .routes import routes_file, service_file
from .schemas import resource_schemas_file, shared_file
from .tests import test_files


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    code = [
        app_file(context),
        server_file(),
        config_file(context),
        errors_file(),
        listing_file(),
        security_file(context),
        shared_file(context),
    ]
    for resource in spec["resources"]:
        code.extend(
            [
                resource_schemas_file(context, resource),
                repository_file(context, resource),
                service_file(context, resource),
                routes_file(context, resource),
            ]
        )
    return [
        readme_file(context),
        package_file(context),
        *tsconfig_files(),
        vitest_config_file(),
        env_example_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        *(file for file in code if file is not None),
        *test_files(context),
    ]


EXPRESS_GENERATOR = {"framework": "express", "serverUrl": "http://localhost:3000", "generate": _generate}
