"""Registry of the generators (Registry pattern). Mirrors web/src/core/generators/registry.ts."""

from ..settings.settings import normalize_settings
from .python.common.generator import python_generator
from .python.django.index import DJANGO_ORM
from .python.sqlalchemy.index import SQLALCHEMY_ORM

GENERATORS = [python_generator(SQLALCHEMY_ORM), python_generator(DJANGO_ORM)]


def find_generator(settings: dict) -> dict | None:
    return next(
        (item for item in GENERATORS if item["language"] == settings["language"] and item["orm"] == settings["orm"]),
        None,
    )


def generate_project(schema: dict, design: dict, settings: dict) -> list[dict]:
    """The files of the project, sorted by path, for settings made consistent first."""
    normalized = normalize_settings(settings)
    generator = find_generator(normalized)
    if not generator:
        return []
    return sorted(generator["generate"](schema, design, normalized), key=lambda file: file["path"])
