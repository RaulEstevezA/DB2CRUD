"""Shared context of the Symfony generator: the namespace of each class for the chosen architecture (Strategy
pattern: layered groups classes by kind, as Symfony does; modular keeps one folder per resource), the names of each
resource's classes and table, and the profile the shared PHP writers follow. Mirrors
web/src/core/generators/frameworks/symfony/context.ts.
"""

import re
from dataclasses import dataclass

from ...languages.php.php import php_class, php_name, php_snake
from ...languages.php.project import resource_names

_LAYERED = {
    "controller": "App\\Controller",
    "input": "App\\Input",
    "presenter": "App\\Presenter",
    "service": "App\\Service",
    "repository": "App\\Repository",
    "entity": "App\\Entity",
}


class _Layered:
    def resource(self, resource: dict, kind: str) -> str:
        return _LAYERED[kind]

    def enums(self) -> str:
        return "App\\Enum"


class _Modular:
    def resource(self, resource: dict, kind: str) -> str:
        return f"App\\{php_class(resource['name'])}"

    def enums(self) -> str:
        return "App\\Shared"


@dataclass
class SymfonyContext:
    """The Symfony project, and its profile for the writers every PHP framework shares (languages/php/project.py)."""

    spec: dict
    settings: dict
    layout: object
    pending: bool
    doctrine: bool
    exceptions: str = "App\\Exception"
    support: str = "App\\Support"
    # The timestamp the server writes: UTC, ISO 8601 with milliseconds, as JavaScript's toISOString
    now = "(new \\DateTimeImmutable('now', new \\DateTimeZone('UTC')))->format('Y-m-d\\TH:i:s.v\\Z')"
    uuid = {"expression": "Uuid::v4()->toRfc4122()", "imports": ["Symfony\\Component\\Uid\\Uuid"]}
    tests = {
        "namespace": "App\\Tests\\Api",
        "folder": "tests/Api",
        "base": "App\\Tests\\ApiTestCase",
        "data": "App\\Tests\\TestData",
        "dataPath": "tests/TestData.php",
    }

    def namespace(self, resource: dict, kind: str) -> str:
        return self.layout.resource(resource, kind)

    def class_path(self, namespace: str, name: str) -> str:
        return class_path(namespace, name)


def create_context(spec: dict, settings: dict) -> SymfonyContext:
    return SymfonyContext(
        spec=spec,
        settings=settings,
        layout=_Modular() if settings["architecture"] == "modular" else _Layered(),
        pending=settings["persistence"] == "none",
        doctrine=settings["persistence"] == "doctrine",
    )


_APP = re.compile(r"^App(\\|$)")


def class_path(namespace: str, name: str) -> str:
    """Path of the file of a class, from its namespace (PSR-4: App\\ is src/)."""
    folder = _APP.sub(lambda match: "src" + match.group(1), namespace)
    return f"{'/'.join(folder.split(chr(92)))}/{name}.php"


def names(resource: dict) -> dict:
    """Names of a resource's classes and table."""
    shared = resource_names(resource)
    type_name = shared["type"]
    return {
        **shared,
        "controller": f"{type_name}Controller",
        "input": f"{type_name}Input",
        "presenter": f"{type_name}Presenter",
        "doctrineRepository": f"Doctrine{type_name}Repository",
        "entity": type_name,
        "table": php_snake(resource["plural"].replace(" ", "_")),
    }


def qualified(context: SymfonyContext, resource: dict, kind: str, name: str) -> str:
    """The fully qualified name of a resource's class."""
    return f"{context.layout.resource(resource, kind)}\\{name}"


def column(field: dict) -> str:
    """The column of a field: its JSON name in snake_case (customerId → customer_id)."""
    return php_snake(field["wire"])


def property_name(field: dict) -> str:
    """The property of a field in an entity: its JSON name in camelCase."""
    return php_name(field["wire"])
