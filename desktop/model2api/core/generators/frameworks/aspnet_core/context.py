"""Shared context of the ASP.NET Core generator: the namespace and folder of each class for the chosen architecture
(Strategy pattern: layered groups classes by kind, modular keeps one folder per resource under Features/), and the
names of each resource's classes and properties. Mirrors web/src/core/generators/frameworks/aspnetCore/context.ts.
"""

import re
from dataclasses import dataclass

from ...languages.csharp.csharp import cs_class, cs_pascal, cs_property

_LAYERED = {
    "model": "Models",
    "dto": "Dtos",
    "repository": "Repositories",
    "service": "Services",
    "controller": "Controllers",
}


def _feature_name(resource: dict) -> str:
    """The folder of a resource in the modular layout: its plural in PascalCase, never its class name."""
    plural = cs_pascal(resource["plural"].replace(" ", "_"))
    return f"{plural}Feature" if plural == cs_class(resource["name"]) else plural


class _Layered:
    def resource(self, resource: dict, kind: str) -> str:
        return _LAYERED[kind]

    def shared(self) -> str:
        return "Models"


class _Modular:
    def resource(self, resource: dict, kind: str) -> str:
        return f"Features.{_feature_name(resource)}"

    def shared(self) -> str:
        return "Shared"


@dataclass
class AspNetContext:
    spec: dict
    settings: dict
    # Root namespace and project name: shop-api → ShopApi
    root: str
    layout: object
    ef_core: bool
    pending: bool
    security: bool


def create_context(spec: dict, settings: dict) -> AspNetContext:
    return AspNetContext(
        spec=spec,
        settings=settings,
        root=cs_pascal(settings["name"]),
        layout=_Modular() if settings["architecture"] == "modular" else _Layered(),
        ef_core=settings["persistence"] == "efCore",
        pending=settings["persistence"] == "none",
        security=settings["auth"] != "none",
    )


def namespace_of(context: AspNetContext, relative: str) -> str:
    """The full namespace of a namespace relative to the root."""
    return f"{context.root}.{relative}"


def source_path(context: AspNetContext, relative: str, name: str) -> str:
    """Path of a source file of the application from its relative namespace and class."""
    return f"src/{context.root}/{relative.replace('.', '/')}/{name}.cs"


def test_path(context: AspNetContext, name: str) -> str:
    """Path of a source file of the test project."""
    return f"tests/{context.root}.Tests/{name}.cs"


def names(resource: dict) -> dict:
    """Names of a resource's classes."""
    type_name = cs_class(resource["name"])
    plural = cs_pascal(resource["plural"].replace(" ", "_"))
    return {
        "type": type_name,
        "create": f"{type_name}Create",
        "update": f"{type_name}Update",
        "response": f"{type_name}Response",
        "repository": f"I{type_name}Repository",
        "memory": f"InMemory{type_name}Repository",
        "pendingRepository": f"Pending{type_name}Repository",
        "efRepository": f"Ef{type_name}Repository",
        "service": f"{type_name}Service",
        "controller": f"{plural}Controller",
        "set": plural,
        "table": resource["plural"].replace(" ", "_"),
    }


def property_name(field: dict, owner: str) -> str:
    """The C# property of a field in a class: its JSON name in PascalCase."""
    return cs_property(field["wire"], owner)


def key_field(resource: dict) -> dict:
    return next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])


def key_type(resource: dict) -> str:
    """The C# type of the key: whole numbers are always long."""
    scalar = resource["key"]["type"]["scalar"]
    if scalar == "integer":
        return "long"
    if scalar == "uuid":
        return "Guid"
    return "string"


class _SharedNames:
    def __init__(self, namespace: str) -> None:
        self._namespace = namespace

    def namespace(self) -> str:
        return self._namespace


def shared_names(context: AspNetContext) -> _SharedNames:
    """Where the enums and embedded objects live."""
    return _SharedNames(namespace_of(context, context.layout.shared()))


def common_namespace(context: AspNetContext) -> str:
    """The namespace of what every resource shares: errors, lists, request bodies, JSON helpers."""
    return namespace_of(context, "Common")


def data_namespace(context: AspNetContext) -> str:
    """The namespace of the database context (Entity Framework Core)."""
    return namespace_of(context, "Data")


_VOWEL_START = re.compile(r"^[aeiou]", re.IGNORECASE)


def article(text: str) -> str:
    return f"an {text}" if _VOWEL_START.match(text) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
