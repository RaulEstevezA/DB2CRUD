"""Shared context of the Laravel generator: the namespace of each class for the chosen architecture (Strategy
pattern: layered groups classes by kind, as Laravel does; modular keeps one folder per resource), and the names of
each resource's classes, table and columns. Mirrors web/src/core/generators/frameworks/laravel/context.ts.
"""

import re
from dataclasses import dataclass

from ...languages.php.php import php_class, php_snake
from ...languages.php.project import (
    article,
    capitalize,
    inner_object,
    key_field,
    key_type,
    referenced_resources,
    resource_names,
)

# The helpers every PHP framework shares, kept importable from here
__all__ = ["article", "capitalize", "inner_object", "key_field", "key_type", "referenced_resources"]

_LAYERED = {
    "controller": "App\\Http\\Controllers",
    "request": "App\\Http\\Requests",
    "resource": "App\\Http\\Resources",
    "service": "App\\Services",
    "repository": "App\\Repositories",
    "model": "App\\Models",
}


class _Layered:
    def resource(self, resource: dict, kind: str) -> str:
        return _LAYERED[kind]

    def enums(self) -> str:
        return "App\\Enums"


class _Modular:
    def resource(self, resource: dict, kind: str) -> str:
        return f"App\\Modules\\{php_class(resource['name'])}"

    def enums(self) -> str:
        return "App\\Modules\\Shared"


@dataclass
class LaravelContext:
    """The Laravel project, and its profile for the writers every PHP framework shares (languages/php/project.py)."""

    spec: dict
    settings: dict
    layout: object
    pending: bool
    eloquent: bool
    exceptions: str = "App\\Exceptions"
    support: str = "App\\Support"
    # The timestamp the server writes: UTC, ISO 8601 with milliseconds, as JavaScript's toISOString
    now = "now()->utc()->format('Y-m-d\\TH:i:s.v\\Z')"
    uuid = {"expression": "(string) Str::uuid()", "imports": ["Illuminate\\Support\\Str"]}
    tests = {
        "namespace": "Tests\\Feature",
        "folder": "tests/Feature",
        "base": "Tests\\TestCase",
        "data": "Tests\\TestData",
        "dataPath": "tests/TestData.php",
    }

    def namespace(self, resource: dict, kind: str) -> str:
        return self.layout.resource(resource, kind)

    def class_path(self, namespace: str, name: str) -> str:
        return class_path(namespace, name)


def create_context(spec: dict, settings: dict) -> LaravelContext:
    return LaravelContext(
        spec=spec,
        settings=settings,
        layout=_Modular() if settings["architecture"] == "modular" else _Layered(),
        pending=settings["persistence"] == "none",
        eloquent=settings["persistence"] == "eloquent",
    )


_APP = re.compile(r"^App(\\|$)")


def class_path(namespace: str, name: str) -> str:
    """Path of the file of a class, from its namespace (PSR-4: App\\ is app/)."""
    folder = _APP.sub(lambda match: "app" + match.group(1), namespace)
    return f"{'/'.join(folder.split(chr(92)))}/{name}.php"


def names(resource: dict) -> dict:
    """Names of a resource's classes, table and variables."""
    shared = resource_names(resource)
    type_name = shared["type"]
    return {
        **shared,
        "controller": f"{type_name}Controller",
        "store": f"Store{type_name}Request",
        "update": f"Update{type_name}Request",
        "resource": f"{type_name}Resource",
        "eloquentRepository": f"Eloquent{type_name}Repository",
        "model": type_name,
        "table": php_snake(resource["plural"].replace(" ", "_")),
    }


def qualified(context: LaravelContext, resource: dict, kind: str, name: str) -> str:
    """The fully qualified name of a resource's class."""
    return f"{context.layout.resource(resource, kind)}\\{name}"


def column(field: dict) -> str:
    """The column of a field: its JSON name in snake_case (customerId → customer_id)."""
    return php_snake(field["wire"])
