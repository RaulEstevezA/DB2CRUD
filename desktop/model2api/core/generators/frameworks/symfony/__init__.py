"""Symfony generator: writes a PHP project with Symfony 8, its Validator, and Doctrine ORM when it is chosen. It
composes the modules of this folder and the writers every PHP framework shares (languages/php/); each writes one
kind of file. Mirrors web/src/core/generators/frameworks/symfony/index.ts.
"""

from ...languages.php.model import enum_files
from ...languages.php.service import service_file
from ...languages.php.storage import values_file
from ...languages.php.support import exception_files, listing_files
from .app import base_controller_file, config_files, error_subscriber_file, json_body_file, kernel_files, security_files
from .context import create_context
from .input import input_file
from .persistence import entity_file, repository_files
from .project import composer_file, env_files, gitignore_file, phpunit_file, readme_file
from .tests import test_files
from .web import controller_file, presenter_file


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    code = [
        *kernel_files(),
        *config_files(context),
        *exception_files(context),
        error_subscriber_file(),
        *listing_files(context),
        values_file(context),
        json_body_file(),
        base_controller_file(),
        *security_files(context),
        *enum_files(context, context.layout.enums()),
    ]
    for resource in spec["resources"]:
        code.extend(
            [
                input_file(context, resource),
                presenter_file(context, resource),
                entity_file(context, resource),
                *repository_files(context, resource),
                service_file(context, resource),
                controller_file(context, resource),
            ]
        )
    return [
        readme_file(context),
        composer_file(context),
        phpunit_file(),
        *env_files(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        *(file for file in code if file is not None),
        *test_files(context),
    ]


SYMFONY_GENERATOR = {"framework": "symfony", "serverUrl": "http://localhost:8000", "generate": _generate}
