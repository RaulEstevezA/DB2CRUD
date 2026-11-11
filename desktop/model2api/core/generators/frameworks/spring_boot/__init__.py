"""Spring Boot generator: writes a Java 21 project with Spring Boot, Bean Validation, Spring Security (when
authentication is chosen) and Spring Data JPA (when JPA is chosen). It composes the modules of this folder; each
writes one kind of file. Mirrors web/src/core/generators/frameworks/springBoot/index.ts.
"""

from .common import application_file, common_files, properties_files, security_files
from .context import create_context
from .model import domain_file, dto_files, payload_file, shared_files
from .persistence import repository_files
from .project import env_example_file, gitignore_file, pom_file, readme_file
from .tests import test_files
from .web import controller_file, service_file


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    code = [
        application_file(context),
        payload_file(context),
        *common_files(context),
        *security_files(context),
        *shared_files(context),
    ]
    for resource in spec["resources"]:
        code.extend(
            [
                domain_file(context, resource),
                *dto_files(context, resource),
                *repository_files(context, resource),
                service_file(context, resource),
                controller_file(context, resource),
            ]
        )
    return [
        readme_file(context),
        pom_file(context),
        env_example_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        *code,
        *properties_files(context),
        *test_files(context),
    ]


SPRING_BOOT_GENERATOR = {"framework": "springBoot", "serverUrl": "http://localhost:8080", "generate": _generate}
