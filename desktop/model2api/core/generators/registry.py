"""Registry of the framework generators (Registry pattern). To support a new framework, write its generator, add
it to GENERATORS and describe its options in compatibility/stack.py. Mirrors
web/src/core/generators/registry.ts.

A generator has "framework", "serverUrl" (the address the project listens on when it runs locally, for the
contract's servers) and "generate" (a function of the spec, the settings and the OpenAPI YAML that returns the
files as {"path", "content"}).
"""

from ..openapi.build import open_api_yaml
from .common.text import compare_key


def _generators() -> dict:
    from .frameworks.aspnet_core import ASPNET_CORE_GENERATOR
    from .frameworks.axum import AXUM_GENERATOR
    from .frameworks.django_rest import DJANGO_REST_GENERATOR
    from .frameworks.express import EXPRESS_GENERATOR
    from .frameworks.fastapi import FASTAPI_GENERATOR
    from .frameworks.ktor import KTOR_GENERATOR
    from .frameworks.laravel import LARAVEL_GENERATOR
    from .frameworks.nestjs import NESTJS_GENERATOR
    from .frameworks.spring_boot import SPRING_BOOT_GENERATOR
    from .frameworks.symfony import SYMFONY_GENERATOR
    from .frameworks.vapor import VAPOR_GENERATOR

    every = (
        FASTAPI_GENERATOR,
        EXPRESS_GENERATOR,
        DJANGO_REST_GENERATOR,
        NESTJS_GENERATOR,
        SPRING_BOOT_GENERATOR,
        LARAVEL_GENERATOR,
        SYMFONY_GENERATOR,
        ASPNET_CORE_GENERATOR,
        KTOR_GENERATOR,
        AXUM_GENERATOR,
        VAPOR_GENERATOR,
    )
    return {generator["framework"]: generator for generator in every}


def find_generator(framework: str) -> dict | None:
    """The generator of a framework, or None while it is not written."""
    return _generators().get(framework)


def generate_project(spec: dict, settings: dict) -> list[dict]:
    """Writes the project of a resolved API with the chosen framework: the files sorted by path, the OpenAPI
    contract included; empty when the framework has no generator."""
    generator = find_generator(settings["framework"])
    if not generator:
        return []
    open_api = open_api_yaml(spec, generator["serverUrl"])
    files = generator["generate"](spec, settings, open_api)
    return sorted(files, key=lambda file: compare_key(file["path"]))
