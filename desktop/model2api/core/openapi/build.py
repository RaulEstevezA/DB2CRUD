"""Builds the OpenAPI 3.1 contract of a resolved API. It describes exactly what the generators write: the same
schemas (read, create, partial update), the same query parameters, the same status codes and the same error
body, so the contract and the code of any framework agree. Mirrors web/src/core/openapi/build.ts.

Objects whose keys come from the input or from status codes are built with js_object, so keys that look like
whole numbers go first, as in a JavaScript object, and the YAML keeps the order of the web version.
"""

from ..js import js_object, number_text
from .yaml import to_yaml

# The error codes every generated API answers with, by status
ERROR_CODES = {
    400: {"code": "validation_error", "description": "The request is not valid"},
    401: {"code": "unauthorized", "description": "Missing or invalid credentials"},
    403: {"code": "forbidden", "description": "The credentials do not allow this operation"},
    404: {"code": "not_found", "description": "No item has this key"},
    409: {"code": "conflict", "description": "An item with this key already exists"},
    501: {"code": "not_implemented", "description": "The logic of this operation is not written yet"},
}

# Codes of errors any request can meet, which no operation documents one by one
GENERAL_ERROR_CODES = ("method_not_allowed", "internal_error")

# Query parameters of a paginated list, with the limits every generator enforces
PAGE_SIZE = {"default": 20, "max": 100}

SCHEMA_NAMES = {
    "read": lambda resource: resource["name"],
    "create": lambda resource: f"{resource['name']}Create",
    "update": lambda resource: f"{resource['name']}Update",
    "page": lambda resource: f"{resource['name']}Page",
}


def _ref(name: str) -> dict:
    return {"$ref": f"#/components/schemas/{name}"}


_SCALAR_SCHEMAS = {
    "string": {"type": "string"},
    "decimal": {"type": "number", "format": "decimal"},
    "boolean": {"type": "boolean"},
    "date": {"type": "string", "format": "date"},
    "datetime": {"type": "string", "format": "date-time"},
    "time": {"type": "string", "format": "time"},
    "duration": {"type": "string", "format": "duration"},
    "uuid": {"type": "string", "format": "uuid"},
    "binary": {"type": "string", "contentEncoding": "base64"},
}


def type_schema(type_ref: dict) -> dict:
    """The JSON Schema of a scalar, an enum, an object or a collection."""
    kind = type_ref["kind"]
    if kind == "scalar":
        name = type_ref["scalar"]
        bits = type_ref.get("bits")
        if name == "integer":
            if bits == 64:
                return {"type": "integer", "format": "int64"}
            return {"type": "integer", "format": "int32"} if bits == 32 else {"type": "integer"}
        if name == "float":
            return {"type": "number", "format": "float"} if bits == 32 else {"type": "number"}
        return dict(_SCALAR_SCHEMAS.get(name, {}))
    if kind in ("enum", "object"):
        return _ref(type_ref["name"])
    if kind == "array":
        return {"type": "array", "items": type_schema(type_ref["items"])}
    return {"type": "object", "additionalProperties": type_schema(type_ref["value"])}


def _with_constraints(schema: dict, constraints: dict, type_ref: dict) -> dict:
    result = dict(schema)
    for key, value in constraints.items():
        if key == "format":
            if type_ref["kind"] == "scalar" and type_ref["scalar"] == "string":
                result["format"] = value
        else:
            result[key] = value
    return result


def field_schema(field: dict) -> dict:
    """The schema of a field: its type, validations, default, description and whether it may be null."""
    schema = _with_constraints(type_schema(field["type"]), field["constraints"], field["type"])
    if field["nullable"]:
        if isinstance(schema.get("type"), str):
            schema = {**schema, "type": [schema["type"], "null"]}
        elif schema:
            schema = {"anyOf": [schema, {"type": "null"}]}
    if "defaultValue" in field:
        schema["default"] = field["defaultValue"]
    if field.get("description"):
        schema["description"] = field["description"]
    return schema


def shape_fields(fields: list[dict], shape: str) -> list[dict]:
    """Fields of a schema of each shape: what a response holds (read), what a creation needs (create), what an
    update may change (update), and every field of an embedded object (object)."""
    if shape == "read":
        return [field for field in fields if field["access"] != "writeOnly"]
    if shape == "object":
        return fields
    return [field for field in fields if field["access"] != "readOnly"]


def always_in_response(field: dict) -> bool:
    """Whether a response always holds the field: required ones, those with a default and those the server fills."""
    return field["required"] or "defaultValue" in field or field.get("server", "pending") != "pending"


def _object_schema(fields: list[dict], shape: str, description: str | None = None) -> dict:
    pairs = []
    for field in fields:
        # A response may leave out an optional field or send it as null, depending on the framework
        readable = {**field, "nullable": True} if shape == "read" and not always_in_response(field) else field
        pairs.append((field["wire"], field_schema(readable)))
    if shape == "update":
        required = []
    elif shape == "read":
        required = [field["wire"] for field in fields if always_in_response(field)]
    else:
        required = [field["wire"] for field in fields if field["required"]]
    schema: dict = {"type": "object", "properties": js_object(pairs)}
    if required:
        schema["required"] = required
    if shape != "read":
        schema["additionalProperties"] = False
    if description:
        schema["description"] = description
    return schema


def _error_schema() -> dict:
    codes = [item["code"] for item in ERROR_CODES.values()] + list(GENERAL_ERROR_CODES)
    return {
        "type": "object",
        "required": ["error"],
        "properties": {
            "error": {
                "type": "object",
                "required": ["code", "message"],
                "properties": {
                    "code": {"type": "string", "enum": codes},
                    "message": {"type": "string"},
                    "details": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["field", "message"],
                            "properties": {"field": {"type": "string"}, "message": {"type": "string"}},
                        },
                    },
                },
            },
        },
    }


def _has_pagination(resource: dict) -> bool:
    return any(endpoint["pagination"] for endpoint in resource["endpoints"])


def _components(spec: dict) -> dict:
    pairs = []
    for item in spec["enums"]:
        pairs.append((item["name"], {"type": item["valueType"], "enum": item["values"]}))
    for spec_object in spec["objects"]:
        fields = shape_fields(spec_object["fields"], "object")
        pairs.append((spec_object["name"], _object_schema(fields, "object", spec_object.get("description"))))
    for resource in spec["resources"]:
        read = _object_schema(shape_fields(resource["fields"], "read"), "read", resource.get("description"))
        pairs.append((SCHEMA_NAMES["read"](resource), read))
        if any(endpoint["input"] != "none" for endpoint in resource["endpoints"]):
            create = _object_schema(shape_fields(resource["fields"], "create"), "create")
            pairs.append((SCHEMA_NAMES["create"](resource), create))
            update = _object_schema(shape_fields(resource["fields"], "update"), "update")
            pairs.append((SCHEMA_NAMES["update"](resource), update))
        if _has_pagination(resource):
            page = {
                "type": "object",
                "required": ["items", "total", "page", "size"],
                "properties": {
                    "items": {"type": "array", "items": _ref(SCHEMA_NAMES["read"](resource))},
                    "total": {"type": "integer", "minimum": 0},
                    "page": {"type": "integer", "minimum": 1},
                    "size": {"type": "integer", "minimum": 1, "maximum": PAGE_SIZE["max"]},
                },
            }
            pairs.append((SCHEMA_NAMES["page"](resource), page))
    pairs.append(("Error", _error_schema()))
    result: dict = {"schemas": js_object(pairs)}
    if spec["auth"] == "apiKey":
        result["securitySchemes"] = {"apiKey": {"type": "apiKey", "in": "header", "name": "X-API-Key"}}
    if spec["auth"] == "jwt":
        result["securitySchemes"] = {"bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}}
    return result


def _error_response(status: int) -> dict:
    return {
        "description": ERROR_CODES[status]["description"],
        "content": {"application/json": {"schema": _ref("Error")}},
    }


def error_statuses(resource: dict, endpoint: dict, auth: str) -> list[int]:
    """The error statuses an endpoint can answer with, in order."""
    statuses: set[int] = set()
    if (
        endpoint["input"] != "none"
        or endpoint["pathParams"]
        or endpoint["pagination"]
        or endpoint["filters"]
        or endpoint["sort"]
    ):
        statuses.add(400)
    if endpoint["access"] != "public" and auth != "none":
        statuses.add(401)
    if endpoint["access"] == "roles":
        statuses.add(403)
    if any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"]):
        statuses.add(404)
    if endpoint["operation"] == "create" and resource["key"]["generated"] is None:
        statuses.add(409)
    if endpoint["operation"] == "custom":
        statuses.add(501)
    return sorted(statuses)


def _query_parameters(resource: dict, endpoint: dict) -> list[dict]:
    parameters = []
    if endpoint["pagination"]:
        parameters.append({"name": "page", "in": "query", "schema": {"type": "integer", "minimum": 1, "default": 1}})
        size = {"type": "integer", "minimum": 1, "maximum": PAGE_SIZE["max"], "default": PAGE_SIZE["default"]}
        parameters.append({"name": "size", "in": "query", "schema": size})
    for wire in endpoint["filters"]:
        field = next(item for item in resource["fields"] if item["wire"] == wire)
        parameters.append({"name": wire, "in": "query", "schema": type_schema(field["type"])})
    if endpoint["sort"]:
        parameters.append(
            {
                "name": "sort",
                "in": "query",
                "description": 'Field to sort by; a leading "-" sorts in descending order',
                "schema": {
                    "type": "string",
                    "enum": [value for wire in endpoint["sort"] for value in (wire, f"-{wire}")],
                },
            }
        )
    return parameters


def _success_response(resource: dict, endpoint: dict) -> dict:
    if endpoint["output"] == "none" or endpoint["status"] == 204:
        return {"description": "Done"}
    if endpoint["output"] == "list":
        if endpoint["pagination"]:
            schema = _ref(SCHEMA_NAMES["page"](resource))
        else:
            schema = {"type": "array", "items": _ref(SCHEMA_NAMES["read"](resource))}
    else:
        schema = _ref(SCHEMA_NAMES["read"](resource))
    return {"description": "Success", "content": {"application/json": {"schema": schema}}}


def _operation(spec: dict, resource: dict, endpoint: dict) -> dict:
    result: dict = {"operationId": endpoint["name"], "summary": endpoint["summary"], "tags": [resource["plural"]]}
    if endpoint["access"] == "roles":
        result["description"] = f"Requires one of the roles: {', '.join(endpoint['roles'])}."
    parameters = [
        {"name": param["name"], "in": "path", "required": True, "schema": type_schema(param["type"])}
        for param in endpoint["pathParams"]
    ] + _query_parameters(resource, endpoint)
    if parameters:
        result["parameters"] = parameters
    if endpoint["input"] != "none":
        name = SCHEMA_NAMES["update" if endpoint["input"] == "partial" else "create"](resource)
        result["requestBody"] = {"required": True, "content": {"application/json": {"schema": _ref(name)}}}
    pairs = [(number_text(endpoint["status"]), _success_response(resource, endpoint))]
    pairs += [(str(status), _error_response(status)) for status in error_statuses(resource, endpoint, spec["auth"])]
    result["responses"] = js_object(pairs)
    if spec["auth"] != "none":
        scheme = "bearer" if spec["auth"] == "jwt" else "apiKey"
        result["security"] = [] if endpoint["access"] == "public" else [{scheme: []}]
    return result


def _paths(spec: dict) -> dict:
    """The OpenAPI paths, identical to the paths of the design."""
    result: dict[str, dict] = {}
    for resource in spec["resources"]:
        for endpoint in resource["endpoints"]:
            result.setdefault(endpoint["path"], {})[endpoint["method"].lower()] = _operation(spec, resource, endpoint)
    return js_object(result.items())


def build_open_api(spec: dict, server_url: str) -> dict:
    """The contract of a resolved API, as a plain object. server_url is the address the generated project
    listens on when run locally."""
    return {
        "openapi": "3.1.0",
        "info": {
            "title": spec["title"],
            "version": "0.1.0",
            "description": "REST API generated by Model2API. Review it before using it in production.",
        },
        "servers": [{"url": server_url}],
        "tags": [{"name": resource["plural"]} for resource in spec["resources"]],
        "paths": _paths(spec),
        "components": _components(spec),
    }


def open_api_yaml(spec: dict, server_url: str) -> str:
    """The contract as YAML, the format the generated projects ship."""
    return to_yaml(build_open_api(spec, server_url))
