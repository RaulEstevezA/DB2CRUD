"""Shared context of the Express generator: where each module goes for the chosen architecture (Strategy pattern:
layered or modular), relative imports between them, and the names of each resource. Mirrors
web/src/core/generators/frameworks/express/context.ts.
"""

import re
from dataclasses import dataclass

from ...languages.typescript.typescript import ts_file, ts_name, ts_type

_LAYERED = {"schemas": "schemas", "repository": "repositories", "service": "services", "routes": "routes"}


class _Layered:
    @staticmethod
    def resource(resource: dict, kind: str) -> str:
        return f"src/{_LAYERED[kind]}/{ts_file(resource['name'])}.ts"

    @staticmethod
    def shared() -> str:
        return "src/schemas/shared.ts"


class _Modular:
    @staticmethod
    def resource(resource: dict, kind: str) -> str:
        name = ts_file(resource["name"])
        return f"src/{name}/{name}.{kind}.ts"

    @staticmethod
    def shared() -> str:
        return "src/shared/schemas.ts"


@dataclass
class ExpressContext:
    spec: dict
    settings: dict
    layout: object
    pending: bool


def create_context(spec: dict, settings: dict) -> ExpressContext:
    layout = _Modular if settings["architecture"] == "modular" else _Layered
    return ExpressContext(spec=spec, settings=settings, layout=layout, pending=settings["persistence"] == "none")


def import_path(origin: str, target: str) -> str:
    """The import specifier of target from origin, both project paths, with the .js extension NodeNext needs."""
    origin_parts = origin.split("/")[:-1]
    target_parts = target.split("/")
    common = 0
    while common < len(origin_parts) and common < len(target_parts) and origin_parts[common] == target_parts[common]:
        common += 1
    up = len(origin_parts) - common
    rest = re.sub(r"\.ts$", ".js", "/".join(target_parts[common:]), count=1)
    return f"{'./' if up == 0 else '../' * up}{rest}"


def names(resource: dict) -> dict:
    """Names of a resource in the code."""
    type_name = ts_type(resource["name"])
    return {
        "type": type_name,
        "create": f"{type_name}Create",
        "update": f"{type_name}Update",
        "record": f"{type_name}Record",
        "repository": f"{type_name}Repository",
        "memory": f"InMemory{type_name}Repository",
        "pendingRepository": f"Pending{type_name}Repository",
        "service": f"{type_name}Service",
        "toResponse": f"to{type_name}",
        "routes": f"{ts_name(resource['name'])}Routes",
        "one": ts_name(resource["name"]),
        "many": ts_name(resource["plural"].replace(" ", "_")),
    }


def key_field(resource: dict) -> dict:
    return next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])


def key_type(resource: dict) -> str:
    """The TypeScript type of a key."""
    return "number" if resource["key"]["type"]["scalar"] == "integer" else "string"
