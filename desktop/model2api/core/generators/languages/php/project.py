"""What the PHP generators share about a project (Laravel and Symfony): the profile each framework fills in (where
its classes go, how it writes a UUID, where its tests go) and helpers about resources, keys and references that do
not depend on the framework. Mirrors web/src/core/generators/languages/php/project.ts.

A profile has: spec, settings, pending (the storage is left to write), exceptions and support (namespaces of the
error and list classes), namespace(resource, kind) for a resource's repository or service, class_path(namespace,
name), now (the expression of the current time the server writes: UTC, ISO 8601 with milliseconds),
uuid ({"expression", "imports"}) and tests ({"namespace", "folder", "base", "data", "dataPath"}).
"""

import re

from ...common.references import inner_object, referenced_resources
from .php import php_class, php_name

# Shared with every generator; kept importable from here for the PHP writers
__all__ = ["inner_object", "referenced_resources"]


def resource_names(resource: dict) -> dict:
    """Names of a resource's classes that every PHP framework shares."""
    type_name = php_class(resource["name"])
    return {
        "type": type_name,
        "service": f"{type_name}Service",
        "repository": f"{type_name}Repository",
        "memory": f"InMemory{type_name}Repository",
        "pendingRepository": f"Pending{type_name}Repository",
        "one": php_name(resource["name"]),
    }


def key_field(resource: dict) -> dict:
    return next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])


def key_type(resource: dict) -> str:
    """The PHP type of the key: whole numbers are int, the rest text."""
    return "int" if resource["key"]["type"]["scalar"] == "integer" else "string"


_VOWEL_START = re.compile(r"^[aeiou]", re.IGNORECASE)


def article(text: str) -> str:
    return f"an {text}" if _VOWEL_START.match(text) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
