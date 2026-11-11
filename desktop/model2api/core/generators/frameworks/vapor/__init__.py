"""Vapor generator: writes a Swift project with Vapor 4, authentication (API key or JWT) and Fluent when it is chosen,
built with the Swift Package Manager. It composes the modules of this folder; each writes one kind of file. Mirrors
web/src/core/generators/frameworks/vapor/index.ts.
"""

from .common import common_files, configure_file, database_file, entrypoint_file, security_file
from .context import create_context
from .model import domain_file, dto_file, shared_files
from .persistence import record_file, repository_file
from .project import env_example_file, gitignore_file, package_file, readme_file
from .tests import test_files
from .web import controller_file, service_file


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    code = [entrypoint_file(), configure_file(context), *common_files(context), *shared_files(context)]
    code.extend(file for file in (security_file(context), database_file(context)) if file)
    for resource in spec["resources"]:
        record = record_file(context, resource)
        code.extend(
            [
                domain_file(context, resource),
                dto_file(context, resource),
                *([record] if record else []),
                repository_file(context, resource),
                service_file(context, resource),
                controller_file(context, resource),
            ]
        )
    return [
        readme_file(context),
        env_example_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        package_file(context),
        *code,
        *test_files(context),
    ]


VAPOR_GENERATOR = {"framework": "vapor", "serverUrl": "http://localhost:8080", "generate": _generate}
