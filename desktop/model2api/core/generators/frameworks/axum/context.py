"""Shared context of the Axum generator: the module of each type for the chosen architecture (Strategy pattern:
layered groups modules by kind, modular keeps one module per resource), and the names of each resource's types,
fields and table. Mirrors web/src/core/generators/frameworks/axum/context.ts.
"""

import re
from dataclasses import dataclass

from ...languages.rust.rust import rs_module, rs_name, rs_pascal, rs_type

# The folder of each kind in the layered layout
_LAYERED = {
    "model": "models",
    "dto": "dtos",
    "repository": "repositories",
    "entity": "entities",
    "service": "services",
    "routes": "routes",
}

# Modules of the crate root a resource module cannot take in the modular layout
_ROOT_MODULES = {"common", "shared", "database", "security", "main", "lib"}


def resource_module(resource: dict) -> str:
    """The module of a resource in the modular layout: its name, unless the crate root already uses it."""
    module = rs_module(resource["name"])
    return f"{module}_resource" if module in _ROOT_MODULES else module


class _Layered:
    def resource(self, resource: dict, kind: str) -> str:
        return f"{_LAYERED[kind]}::{rs_module(resource['name'])}"

    def shared(self, name: str) -> str:
        return f"models::{rs_module(name)}"


class _Modular:
    def resource(self, resource: dict, kind: str) -> str:
        return f"{resource_module(resource)}::{kind}"

    def shared(self, name: str) -> str:
        return f"shared::{rs_module(name)}"


@dataclass
class AxumContext:
    spec: dict
    settings: dict
    # Name of the Cargo package: the project name, made valid for Cargo
    package: str
    # Name of the library crate: shop-api → shop_api
    crate: str
    layout: object
    sea_orm: bool
    pending: bool
    security: bool


# Package names Cargo refuses or that would hide a crate of the standard library
_RESERVED_PACKAGES = {"std", "core", "alloc", "test", "proc-macro", "self", "crate", "super"}


def package_name(name: str) -> str:
    """A Cargo package name from the project name: never starting with a digit, never a reserved name."""
    if not name or re.match(r"^[0-9]", name):
        return f"api-{name or 'project'}"
    return f"{name}-api" if name in _RESERVED_PACKAGES else name


def create_context(spec: dict, settings: dict) -> AxumContext:
    package = package_name(settings["name"])
    return AxumContext(
        spec=spec,
        settings=settings,
        package=package,
        crate=package.replace("-", "_"),
        layout=_Modular() if settings["architecture"] == "modular" else _Layered(),
        sea_orm=settings["persistence"] == "seaOrm",
        pending=settings["persistence"] == "none",
        security=settings["auth"] != "none",
    )


def module_path(module: str) -> str:
    """Path of the source file of a module path."""
    return f"src/{module.replace('::', '/')}.rs"


class _TypeNames:
    def __init__(self, context: AxumContext) -> None:
        self._context = context

    def shared(self, name: str) -> str:
        return f"crate::{self._context.layout.shared(name)}::{rs_type(name)}"


def type_names(context: AxumContext) -> _TypeNames:
    """Where the enums and embedded objects live, as use paths."""
    return _TypeNames(context)


def names(resource: dict) -> dict:
    """Names of a resource's types and table."""
    type_name = rs_type(resource["name"])
    plural = resource["plural"].replace(" ", "_")
    return {
        "type": type_name,
        "create": f"{type_name}Create",
        "update": f"{type_name}Update",
        "response": f"{type_name}Response",
        "filters": f"{type_name}Filters",
        "repository": f"{type_name}Repository",
        "memory": f"InMemory{type_name}Repository",
        "pendingRepository": f"Pending{type_name}Repository",
        "seaOrmRepository": f"SeaOrm{type_name}Repository",
        "service": f"{type_name}Service",
        # The field of the application state that holds the service
        "state": rs_module(plural),
        "module": rs_module(resource["name"]),
        "table": plural.lower(),
        "test": f"{rs_module(resource['name'])}_api",
        "one": rs_module(resource["name"]),
        "plural": rs_pascal(plural),
    }


def field_name(spec_field: dict) -> str:
    """The Rust field of a property: its JSON name in snake_case."""
    return rs_name(spec_field["wire"])


def key_field(resource: dict) -> dict:
    return next(item for item in resource["fields"] if item["name"] == resource["key"]["field"])


def key_type(resource: dict) -> str:
    """The Rust type of the key: whole numbers are always i64."""
    scalar = resource["key"]["type"].get("scalar")
    if scalar == "integer":
        return "i64"
    if scalar == "uuid":
        return "Uuid"
    return "String"


def article(text: str) -> str:
    return f"an {text}" if re.match(r"^[aeiou]", text, re.IGNORECASE) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
