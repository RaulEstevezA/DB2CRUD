"""Shared context of the Ktor generator: the package of each class for the chosen architecture (Strategy pattern:
layered packages by layer, modular by resource), and the names of each resource's classes, properties and table.
Mirrors web/src/core/generators/frameworks/ktor/context.ts.
"""

import re
from dataclasses import dataclass

from ...languages.kotlin.kotlin import kt_class, kt_name


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
        return f"{self._base}.{kt_class(resource['name']).lower()}"

    def shared(self) -> str:
        return f"{self._base}.shared"


@dataclass
class KtorContext:
    spec: dict
    settings: dict
    base: str
    layout: object
    exposed: bool
    pending: bool
    security: bool


def create_context(spec: dict, settings: dict) -> KtorContext:
    base = settings["javaPackage"]
    return KtorContext(
        spec=spec,
        settings=settings,
        base=base,
        layout=_Modular(base) if settings["architecture"] == "modular" else _Layered(base),
        exposed=settings["persistence"] == "exposed",
        pending=settings["persistence"] == "none",
        security=settings["auth"] != "none",
    )


def source_path(package: str, name: str, test: bool = False) -> str:
    """Path of a Kotlin source file from its package and class."""
    return f"src/{'test' if test else 'main'}/kotlin/{package.replace('.', '/')}/{name}.kt"


def common_package(context: KtorContext) -> str:
    """The package of what every resource shares: errors, lists, request bodies, JSON helpers, settings."""
    return f"{context.base}.common"


class _TypeNames:
    def __init__(self, context: KtorContext) -> None:
        self._context = context

    def shared(self, name: str) -> str:
        return f"{self._context.layout.shared()}.{kt_class(name)}"

    def common(self, name: str) -> str:
        return f"{common_package(self._context)}.{name}"


def type_names(context: KtorContext) -> _TypeNames:
    """Fully qualified names of the shared classes and of the project's helpers."""
    return _TypeNames(context)


def names(resource: dict) -> dict:
    """Names of a resource's classes and table."""
    type_name = kt_class(resource["name"])
    one = kt_name(resource["name"]).replace("`", "")
    return {
        "type": type_name,
        "create": f"{type_name}Create",
        "update": f"{type_name}Update",
        "response": f"{type_name}Response",
        "repository": f"{type_name}Repository",
        "memory": f"InMemory{type_name}Repository",
        "pendingRepository": f"Pending{type_name}Repository",
        "exposedRepository": f"Exposed{type_name}Repository",
        "table": f"{type_name}Table",
        "service": f"{type_name}Service",
        "routes": f"{type_name}Routes",
        "routesFunction": f"{one}Routes",
        "one": one,
        "sqlTable": resource["plural"].replace(" ", "_").lower(),
    }


def property_name(field: dict) -> str:
    """The Kotlin property of a field: its JSON name in camelCase."""
    return kt_name(field["wire"])


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_NOT_WORD = re.compile(r"[^A-Za-z0-9]+")


def column(field: dict) -> str:
    """The column of a field: its JSON name in snake_case."""
    return _NOT_WORD.sub("_", _CAMEL.sub(r"\1_\2", field["wire"])).lower()


def key_field(resource: dict) -> dict:
    return next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])


def key_type(resource: dict) -> str:
    """The Kotlin type of the key: whole numbers are always Long."""
    scalar = resource["key"]["type"]["scalar"]
    if scalar == "integer":
        return "Long"
    if scalar == "uuid":
        return "JsonUuid"
    return "String"


_VOWEL_START = re.compile(r"^[aeiou]", re.IGNORECASE)


def article(text: str) -> str:
    return f"an {text}" if _VOWEL_START.match(text) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
