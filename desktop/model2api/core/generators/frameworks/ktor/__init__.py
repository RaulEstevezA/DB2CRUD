"""Ktor generator: writes a Kotlin project with Ktor 3, kotlinx.serialization, authentication (API key or JWT) and
Exposed when it is chosen, built with Gradle. It composes the modules of this folder; each writes one kind of file.
Mirrors web/src/core/generators/frameworks/ktor/index.ts.
"""

from .common import application_file, common_files, database_files, security_files
from .context import create_context
from .model import domain_file, dto_files, shared_files
from .persistence import repository_files
from .project import build_files, env_example_file, gitignore_file, readme_file
from .tests import test_files
from .web import routes_file, service_file


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    code = [
        application_file(context),
        *common_files(context),
        *security_files(context),
        *database_files(context),
        *shared_files(context),
    ]
    for resource in spec["resources"]:
        code.extend(
            [
                domain_file(context, resource),
                *dto_files(context, resource),
                *repository_files(context, resource),
                service_file(context, resource),
                routes_file(context, resource),
            ]
        )
    return [
        readme_file(context),
        env_example_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        *build_files(context),
        *code,
        *test_files(context),
    ]


KTOR_GENERATOR = {"framework": "ktor", "serverUrl": "http://localhost:8080", "generate": _generate}
