"""Shared context of the Vapor generator: the folder of each file for the chosen architecture (Strategy pattern:
layered groups files by kind, modular keeps one folder per resource; every file is in the same Swift module, so the
folders only order the code), and the names of each resource's types, properties and table. Mirrors
web/src/core/generators/frameworks/vapor/context.ts.
"""

import re
from dataclasses import dataclass

from ....model.naming import to_snake_case
from ...languages.swift.swift import TYPE_NAMES, sw_name, sw_pascal, sw_type

# The folder of each kind in the layered layout
_LAYERED = {
    "model": "Models",
    "dto": "DTOs",
    "repository": "Repositories",
    "database": "Database",
    "service": "Services",
    "controller": "Controllers",
}

# Folders of the app a resource folder cannot take in the modular layout
_APP_FOLDERS = {"Common", "Shared", "Database", "Security"}


def resource_folder(resource: dict) -> str:
    """The folder of a resource in the modular layout: its type name, unless the app already has that folder."""
    folder = sw_type(resource["name"])
    return f"{folder}Resource" if folder in _APP_FOLDERS else folder


class _Layered:
    shared = "Models"

    def resource(self, resource: dict, kind: str) -> str:
        return _LAYERED[kind]


class _Modular:
    shared = "Shared"

    def resource(self, resource: dict, kind: str) -> str:
        return resource_folder(resource)


@dataclass
class VaporContext:
    spec: dict
    settings: dict
    layout: object
    fluent: bool
    pending: bool
    security: bool


def create_context(spec: dict, settings: dict) -> VaporContext:
    return VaporContext(
        spec=spec,
        settings=settings,
        layout=_Modular() if settings["architecture"] == "modular" else _Layered(),
        fluent=settings["persistence"] == "fluent",
        pending=settings["persistence"] == "none",
        security=settings["auth"] != "none",
    )


def source_path(folder: str, name: str) -> str:
    """Path of a source file of the app."""
    return f"Sources/App/{folder}/{name}.swift"


# Enums and embedded objects are named as types of the module
type_names = TYPE_NAMES


def names(resource: dict) -> dict:
    """Names of a resource's types and table."""
    type_name = sw_type(resource["name"])
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
        "fluentRepository": f"Fluent{type_name}Repository",
        "record": f"{type_name}Record",
        "migration": f"{type_name}Migration",
        "service": f"{type_name}Service",
        "controller": f"{type_name}Controller",
        "table": to_snake_case(plural) or "items",
        "tests": f"{type_name}APITests",
        # The type in lower camelCase, always used with a suffix (customerRepository), so never a keyword
        "one": type_name[:1].lower() + type_name[1:],
        "plural": sw_pascal(plural),
    }


def property_name(spec_field: dict) -> str:
    """The Swift property of a field: its JSON name in camelCase."""
    return sw_name(spec_field["wire"])


def column(spec_field: dict) -> str:
    """The column of a field: its JSON name in snake_case."""
    return to_snake_case(spec_field["wire"]) or "value"


def key_field(resource: dict) -> dict:
    return next(item for item in resource["fields"] if item["name"] == resource["key"]["field"])


def key_type(resource: dict) -> str:
    """The Swift type of the key: whole numbers are always Int64."""
    scalar = resource["key"]["type"].get("scalar")
    if scalar == "integer":
        return "Int64"
    if scalar == "uuid":
        return "UUID"
    return "String"


def article(text: str) -> str:
    return f"an {text}" if re.match(r"^[aeiou]", text, re.IGNORECASE) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
