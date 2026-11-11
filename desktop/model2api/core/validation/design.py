"""Consistency checks on an API design before any code is written: routes that clash, operation names the code
cannot use, paths without the parameter that identifies an item, filters on fields that cannot be filtered,
protection that the chosen authentication cannot enforce. Mirrors web/src/core/validation/design.ts.

An endpoint with an error is left out of the generated code and of the OpenAPI contract, and the interface says
why; a warning is only shown. An issue is {"code", "severity", "model", "endpoint"?, "params"?}.
"""

import re

from ..design.propose import key_param
from ..model.schema import ModelSchema, find_model

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SEGMENT = re.compile(r"^(?:[A-Za-z0-9._~-]+|\{[A-Za-z_][A-Za-z0-9_]*\})$")
_PARAM = re.compile(r"\{([^}]*)\}")


def path_params(path: str) -> list[str]:
    """Path parameters in the order they appear: /orders/{id}/lines/{line} → id, line."""
    return _PARAM.findall(path)


def _route_shape(path: str) -> str:
    """A path with its parameters blanked, so /a/{id} and /a/{key} count as the same route."""
    return _PARAM.sub("{}", path).lower()


_ITEM_OPERATIONS = {"get", "replace", "update", "delete"}


def filterable_fields(resource: dict, schema: ModelSchema) -> list[str]:
    """Fields a list can filter or sort by, in the order of the resource: included values that are text,
    numbers, dates, booleans or enums, and references to one other resource."""
    model = find_model(schema, resource["model"])
    filterable: list[str] = []
    for field in resource["fields"]:
        definition = next((item for item in model["fields"] if item["name"] == field["field"]), None) if model else None
        if not field["include"] or field["access"]["value"] == "writeOnly" or not definition:
            continue
        type_ref = definition["type"]
        plain = (type_ref["kind"] == "primitive" and type_ref["name"] not in ("any", "binary")) or type_ref[
            "kind"
        ] == "enum"
        relation = field.get("relation")
        reference = bool(relation) and relation["value"] == "reference" and type_ref["kind"] == "model"
        if (plain or reference) and field["field"] not in filterable:
            filterable.append(field["field"])
    return filterable


def _is_integer(value) -> bool:
    return isinstance(value, int) or (isinstance(value, float) and value.is_integer())


def _check_endpoint(resource: dict, endpoint: dict, schema: ModelSchema, settings: dict) -> list[dict]:
    issues: list[dict] = []

    def add(code: str, severity: str, params: dict | None = None) -> None:
        issue = {"code": code, "severity": severity, "model": resource["model"], "endpoint": endpoint["id"]}
        if params is not None:
            issue["params"] = params
        issues.append(issue)

    if not _IDENTIFIER.match(endpoint["name"]):
        add("invalidName", "error", {"name": endpoint["name"]})
    segments = endpoint["path"].split("/")[1:]
    if not endpoint["path"].startswith("/") or any(not _SEGMENT.match(segment) for segment in segments):
        add("invalidPath", "error", {"path": endpoint["path"]})
    params = path_params(endpoint["path"])
    key = key_param(resource)
    operation = endpoint["operation"]
    if operation in _ITEM_OPERATIONS and key not in params:
        add("missingKeyParam", "error", {"param": key})
    if operation != "custom":
        unexpected = [param for param in params if operation not in _ITEM_OPERATIONS or param != key]
        if unexpected:
            add("unexpectedParam", "error", {"params": ", ".join(unexpected)})
    if len(set(params)) != len(params):
        add("invalidPath", "error", {"path": endpoint["path"]})
    if operation == "list":
        filterable = filterable_fields(resource, schema)
        bad_filters = [field for field in endpoint.get("filters") or [] if field not in filterable]
        if bad_filters:
            add("invalidFilter", "error", {"fields": ", ".join(bad_filters)})
        bad_sort = [field for field in endpoint.get("sort") or [] if field not in filterable]
        if bad_sort:
            add("invalidSort", "error", {"fields": ", ".join(bad_sort)})
    if endpoint["access"] == "roles" and not endpoint["roles"]:
        add("noRoles", "error")
    if operation == "custom" and endpoint["method"] == "GET" and endpoint.get("input") and endpoint["input"] != "none":
        add("bodyOnGet", "error")
    status = endpoint.get("status")
    if status is not None and (status < 200 or status > 299 or not _is_integer(status)):
        add("invalidStatus", "error", {"status": status})
    if settings["auth"] == "none" and endpoint["access"] in ("authenticated", "roles"):
        add("protectionIgnored", "warning")
    if settings["auth"] == "apiKey" and endpoint["access"] == "roles":
        add("protectionIgnored", "warning", {"auth": "apiKey"})
    return issues


def validate_design(design: dict, schema: ModelSchema, settings: dict) -> list[dict]:
    """Checks every enabled endpoint of a design, and the endpoints of each resource against each other. The
    authentication of the settings decides which protections can be enforced. Issues come in the order of
    the design."""
    issues: list[dict] = []
    routes: dict[str, str] = {}
    names: dict[str, str] = {}
    for resource in design["resources"]:
        if resource["expose"]["value"] != "resource":
            continue
        enabled = [endpoint for endpoint in resource["endpoints"] if endpoint["enabled"]]
        if not enabled:
            issues.append({"code": "noEndpoints", "severity": "warning", "model": resource["model"]})
        for endpoint in enabled:
            issues.extend(_check_endpoint(resource, endpoint, schema, settings))
            route = f"{endpoint['method']} {_route_shape(endpoint['path'])}"
            clash = routes.get(route)
            if clash:
                issues.append(
                    {
                        "code": "duplicateRoute",
                        "severity": "error",
                        "model": resource["model"],
                        "endpoint": endpoint["id"],
                        "params": {"other": clash},
                    }
                )
            else:
                routes[route] = endpoint["id"]
            same_name = names.get(endpoint["name"].lower())
            if same_name:
                issues.append(
                    {
                        "code": "duplicateName",
                        "severity": "error",
                        "model": resource["model"],
                        "endpoint": endpoint["id"],
                        "params": {"other": same_name},
                    }
                )
            else:
                names[endpoint["name"].lower()] = endpoint["id"]
    return issues


def blocked_endpoints(issues: list[dict]) -> set[str]:
    """Identifiers of the endpoints left out of the generated code because of an error."""
    return {issue["endpoint"] for issue in issues if issue["severity"] == "error" and issue.get("endpoint")}
