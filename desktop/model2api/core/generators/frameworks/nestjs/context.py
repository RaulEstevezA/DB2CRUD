"""Shared context of the NestJS generator: the files of each resource (one Nest module per resource, as Nest
organizes code), relative imports, and the names of each resource's classes. Mirrors
web/src/core/generators/frameworks/nestjs/context.ts.
"""

import re
from dataclasses import dataclass

from ...languages.typescript.typescript import ts_file, ts_name, ts_type

SHARED = "src/shared/shared.dto.ts"


@dataclass
class NestContext:
    spec: dict
    settings: dict
    pending: bool
    typeorm: bool


def create_context(spec: dict, settings: dict) -> NestContext:
    return NestContext(
        spec=spec,
        settings=settings,
        pending=settings["persistence"] == "none",
        typeorm=settings["persistence"] == "typeorm",
    )


def resource_path(resource: dict, kind: str) -> str:
    """src/order-line/order-line.service.ts"""
    file = ts_file(resource["name"])
    return f"src/{file}/{file}.{kind}.ts"


def import_path(origin: str, target: str) -> str:
    """The import specifier of target from origin, both project paths (CommonJS: no extension)."""
    origin_parts = origin.split("/")[:-1]
    target_parts = target.split("/")
    common = 0
    while common < len(origin_parts) and common < len(target_parts) and origin_parts[common] == target_parts[common]:
        common += 1
    up = len(origin_parts) - common
    rest = re.sub(r"\.ts$", "", "/".join(target_parts[common:]), count=1)
    return f"{'./' if up == 0 else '../' * up}{rest}"


def names(resource: dict) -> dict:
    type_name = ts_type(resource["name"])
    many = resource["plural"].replace(" ", "_")
    return {
        "type": type_name,
        "create": f"Create{type_name}Dto",
        "update": f"Update{type_name}Dto",
        "query": f"List{ts_type(many)}Query",
        "record": f"{type_name}Record",
        "entity": f"{type_name}Entity",
        "repository": f"{type_name}Repository",
        "token": f"{ts_name(resource['name']).upper()}_REPOSITORY",
        "memory": f"InMemory{type_name}Repository",
        "pendingRepository": f"Pending{type_name}Repository",
        "typeormRepository": f"TypeOrm{type_name}Repository",
        "service": f"{type_name}Service",
        "controller": f"{type_name}Controller",
        "module": f"{type_name}Module",
        "toResponse": f"to{type_name}",
        "one": ts_name(resource["name"]),
        "many": ts_name(many),
    }


def key_field(resource: dict) -> dict:
    return next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])


def key_type(resource: dict) -> str:
    return "number" if resource["key"]["type"]["scalar"] == "integer" else "string"
