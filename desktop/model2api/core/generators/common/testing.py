"""Rules the generated tests of every framework share, so each one checks the same things in its own syntax:
which resources a test can create through the API, which key no item has, which fields can be compared after
a round trip, and the credentials the tests use. Mirrors web/src/core/generators/common/testing.ts.
"""

import json
import re

from ...openapi.build import shape_fields
from .samples import sample_body

# The API key the tests configure and send
TEST_API_KEY = "test-api-key"

# The secret the tests sign their tokens with: long enough for every JWT library's minimum
TEST_JWT_SECRET = "test-secret-with-at-least-32-bytes!"


def missing_key(resource: dict) -> str:
    """A key no stored item has, by key type, as text for a path."""
    scalar = resource["key"]["type"]["scalar"]
    if scalar == "integer":
        return "999999"
    if scalar == "uuid":
        return "00000000-0000-0000-0000-000000000000"
    return "missing-key"


def fixed_path(endpoint: dict, resource: dict, value: str) -> str:
    """A path with a fixed key value and any other parameter filled: /customers/999999."""
    path = endpoint["path"]
    for param in endpoint["pathParams"]:
        replacement = value if param["name"] == resource["key"]["param"] else "sample"
        path = path.replace(f"{{{param['name']}}}", replacement, 1)
    return path


def path_with_key(endpoint: dict, resource: dict) -> str:
    """A path whose key is an expression of the test language: the caller turns {key} into its syntax."""
    return fixed_path(endpoint, resource, "{key}")


def find_endpoint(resource: dict, operation: str) -> dict | None:
    return next((endpoint for endpoint in resource["endpoints"] if endpoint["operation"] == operation), None)


def key_wire(resource: dict) -> str:
    """The JSON name of the key of a resource."""
    return next(field["wire"] for field in resource["fields"] if field["name"] == resource["key"]["field"])


def creatable(spec: dict, resource: dict, seen: frozenset[str] = frozenset()) -> bool:
    """Whether tests can create items of a resource: a create endpoint, a valid body and creatable references."""
    if not find_endpoint(resource, "create") or sample_body(spec, resource, 0)["problem"]:
        return False
    if resource["name"] in seen:
        return True
    following = seen | {resource["name"]}
    for reference in sample_body(spec, resource, 0)["sample"]["references"]:
        target = next((item for item in spec["resources"] if item["name"] == reference["resource"]), None)
        if target is None or not creatable(spec, target, following):
            return False
    return True


def comparable_fields(resource: dict, body: dict) -> list[str]:
    """Fields a round trip returns exactly as sent: readable text, whole numbers, booleans and enums."""
    readable = {field["wire"] for field in shape_fields(resource["fields"], "read")}
    result = []
    for field in resource["fields"]:
        if field["wire"] not in readable or field.get("reference") or field["wire"] not in body:
            continue
        type_ref = field["type"]
        scalar = (
            type_ref["kind"] == "scalar"
            and type_ref["scalar"] in ("string", "integer", "boolean")
            and not field["constraints"].get("format")
        )
        if scalar or type_ref["kind"] == "enum":
            result.append(field["wire"])
    return result


def sample_keys_differ(spec: dict, resource: dict) -> bool:
    """Whether the two sample bodies give different client-provided keys, so two items can be created."""
    if resource["key"]["generated"] is not None:
        return True
    key = key_wire(resource)
    first = sample_body(spec, resource, 0)["sample"]["body"].get(key)
    second = sample_body(spec, resource, 1)["sample"]["body"].get(key)
    return json.dumps(first) != json.dumps(second)


def required_field(resource: dict) -> dict | None:
    """A required field the client sends, to check that leaving it out is rejected."""
    return next(
        (
            field
            for field in resource["fields"]
            if field["required"] and field["access"] != "readOnly" and not field.get("reference")
        ),
        None,
    )


def protected_endpoint(resource: dict, auth: str) -> dict | None:
    """The first protected endpoint a test can call without a body, to check it needs credentials."""
    if auth == "none":
        return None
    endpoint = next((item for item in resource["endpoints"] if item["access"] != "public"), None)
    return endpoint if endpoint and endpoint["method"] == "GET" and endpoint["input"] == "none" else None


def role_endpoint(resource: dict, auth: str) -> dict | None:
    """The first endpoint that needs roles a test can call without a body, to check a token without them."""
    if auth != "jwt":
        return None
    return next(
        (
            endpoint
            for endpoint in resource["endpoints"]
            if endpoint["access"] == "roles" and endpoint["method"] == "GET" and endpoint["input"] == "none"
        ),
        None,
    )


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")


def snake_words(name: str) -> str:
    """Words of an operation name for a test name: listCustomers → list_customers."""
    return _CAMEL.sub(r"\1_\2", name).lower()
