"""Shared context of the Spring Boot generator: the package of each class for the chosen architecture (Strategy
pattern: layered packages by layer, modular by resource), and the names of each resource's classes and
properties. Mirrors web/src/core/generators/frameworks/springBoot/context.ts.
"""

from dataclasses import dataclass

from ...languages.java.java import java_class, java_name


class _Layered:
    def __init__(self, base: str) -> None:
        self._base = base

    def resource(self, resource: dict, kind: str) -> str:
        return f"{self._base}.{kind}"

    def shared(self) -> str:
        return f"{self._base}.model"


class _Modular:
    def __init__(self, base: str) -> None:
        self._base = base

    def resource(self, resource: dict, kind: str) -> str:
        return f"{self._base}.{java_name(resource['name']).lower()}"

    def shared(self) -> str:
        return f"{self._base}.shared"


@dataclass
class SpringContext:
    spec: dict
    settings: dict
    base: str
    layout: object
    jpa: bool
    pending: bool
    security: bool


def create_context(spec: dict, settings: dict) -> SpringContext:
    base = settings["javaPackage"]
    layout = _Modular(base) if settings["architecture"] == "modular" else _Layered(base)
    return SpringContext(
        spec=spec,
        settings=settings,
        base=base,
        layout=layout,
        jpa=settings["persistence"] == "jpa",
        pending=settings["persistence"] == "none",
        security=settings["auth"] != "none",
    )


def source_path(package: str, name: str, test: bool = False) -> str:
    """Path of a Java source file from its package and class."""
    return f"src/{'test' if test else 'main'}/java/{package.replace('.', '/')}/{name}.java"


def names(resource: dict) -> dict:
    """Names of a resource's classes."""
    type_name = java_class(resource["name"])
    return {
        "type": type_name,
        "create": f"{type_name}Create",
        "update": f"{type_name}Update",
        "response": f"{type_name}Response",
        "repository": f"{type_name}Repository",
        "memory": f"InMemory{type_name}Repository",
        "pendingRepository": f"Pending{type_name}Repository",
        "jpaRepository": f"Jpa{type_name}Repository",
        "springData": f"{type_name}JpaRepository",
        "service": f"{type_name}Service",
        "controller": f"{type_name}Controller",
        "one": java_name(resource["name"]),
    }


def prop(field: dict) -> str:
    """The Java property of a field: its JSON name in camelCase."""
    return java_name(field["wire"])


def key_field(resource: dict) -> dict:
    return next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])


def key_type(resource: dict) -> str:
    """The Java type of the key: whole numbers are always Long."""
    scalar = resource["key"]["type"]["scalar"]
    if scalar == "integer":
        return "Long"
    return "UUID" if scalar == "uuid" else "String"


class SharedNames:
    """Qualified names of enums and embedded objects."""

    def __init__(self, context: SpringContext) -> None:
        self._package = context.layout.shared()

    def object(self, name: str) -> str:
        return f"{self._package}.{java_class(name)}"

    def enum(self, name: str) -> str:
        return f"{self._package}.{java_class(name)}"


def shared_names(context: SpringContext) -> SharedNames:
    return SharedNames(context)


def common_package(context: SpringContext) -> str:
    """The common package: errors, lists and the presence-tracking base of request bodies."""
    return f"{context.base}.common"
