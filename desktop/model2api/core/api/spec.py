"""The resolved API: models, design and settings combined into one language-neutral description that the
OpenAPI contract and every generator read. Each decision is applied here once (key, relations, access, types,
protection, status codes), so the contract and the code of every framework cannot disagree. Mirrors
web/src/core/api/spec.ts.

Pending decisions keep their suggested value and add a "todo" in English, which the generators write as a TODO
comment where the decision matters.

A specification is {"title", "resources", "objects", "enums", "auth", "roles", "issues"}; types are
{"kind": "scalar", "scalar", "bits"?}, {"kind": "array", "items"}, {"kind": "map", "value"} and
{"kind": "object" | "enum", "name"}.
"""

from ..analysis.constraints import read_constraints
from ..analysis.models import audit_kind, model_target
from ..design.propose import default_resource_path, key_param
from ..js import is_number
from ..model.naming import name_words, singularize, unique_name
from ..model.schema import FieldDef, ModelSchema, TypeRef, all_fields, find_model
from ..validation.design import blocked_endpoints, path_params, validate_design


def _default_status(operation: str, output: str) -> int:
    """Status of a successful response of each operation, unless the endpoint sets another."""
    if operation == "create":
        return 201
    if operation == "delete":
        return 204
    if operation == "custom" and output == "none":
        return 204
    return 200


# Input and output of each standard operation
_STANDARD_IO = {
    "list": {"input": "none", "output": "list"},
    "get": {"input": "none", "output": "resource"},
    "create": {"input": "resource", "output": "resource"},
    "replace": {"input": "resource", "output": "resource"},
    "update": {"input": "partial", "output": "resource"},
    "delete": {"input": "none", "output": "none"},
}


def scalar(name: str, bits: int | None = None) -> dict:
    return {"kind": "scalar", "scalar": name, "bits": bits} if bits else {"kind": "scalar", "scalar": name}


def _reference_wire(name: str, many: bool) -> str:
    """customer → customerId, order_line → order_line_id, tags → tagIds."""
    base = singularize(name) if many else name
    if "_" in name:
        return f"{base}_{'ids' if many else 'id'}"
    return f"{base}{'Ids' if many else 'Id'}"


class _Context:
    def __init__(self, schema: ModelSchema, design: dict):
        self.schema = schema
        self.design = design
        self.objects: dict[str, dict] = {}
        self.keys: dict[str, dict] = {}


def _resource_of(design: dict, model: str) -> dict | None:
    return next((item for item in design["resources"] if item["model"] == model), None)


def _field_design(resource: dict, field: str) -> dict | None:
    return next((item for item in resource["fields"] if item["field"] == field), None)


def _resolve_key(resource: dict, schema: ModelSchema) -> tuple[dict, dict | None]:
    """The key of a resource: one of its fields, or a new id field the server fills. Returns the key and the
    extra field, if one is added."""
    model = find_model(schema, resource["model"])
    key = resource.get("key")
    choice = key["value"] if key else {"kind": "generated", "type": "integer"}
    param = key_param(resource)
    if choice["kind"] == "field":
        field = next((item for item in all_fields(schema, model) if item["name"] == choice["field"]), None)
        # A key is a whole number even where the language has a single number type (TypeScript's number)
        declared = field["type"] if field and field["type"]["kind"] == "primitive" else None
        if not declared:
            key_type = scalar("string")
        elif declared["name"] == "float" and not declared.get("bits"):
            key_type = scalar("integer")
        else:
            key_type = scalar(declared["name"], declared.get("bits"))
        design = _field_design(resource, choice["field"])
        access = design["access"]["value"] if design else None
        generated = ("increment" if key_type["scalar"] == "integer" else "uuid") if access == "readOnly" else None
        return {"field": choice["field"], "type": key_type, "generated": generated, "param": param}, None
    used = {field["name"] for field in all_fields(schema, model)}
    name = unique_name("id", used)
    key_type = scalar("uuid") if choice["type"] == "uuid" else scalar("integer", 64)
    extra = {
        "name": name,
        "wire": name,
        "type": key_type,
        "required": False,
        "nullable": False,
        "access": "readOnly",
        "constraints": {},
        "server": "key",
    }
    generated = "uuid" if choice["type"] == "uuid" else "increment"
    return {"field": name, "type": key_type, "generated": generated, "param": param}, extra


def _resolve_type(type_ref: TypeRef, field: FieldDef, resource: dict, context: _Context) -> dict:
    """The API type of a model type, following the relation decision of the field."""
    kind = type_ref["kind"]
    if kind == "primitive":
        return scalar(type_ref["name"], type_ref.get("bits"))
    if kind == "enum":
        return {"kind": "enum", "name": type_ref["name"]}
    if kind == "unknown":
        design = _field_design(resource, field["name"])
        unknown = design.get("unknownType") if design else None
        return scalar("string" if unknown and unknown["value"] == "string" else "any")
    if kind == "array":
        return {"kind": "array", "items": _resolve_type(type_ref["items"], field, resource, context)}
    if kind == "map":
        return {"kind": "map", "value": _resolve_type(type_ref["value"], field, resource, context)}
    design = _field_design(resource, field["name"])
    relation = design.get("relation") if design else None
    key = context.keys.get(type_ref["name"])
    if relation and relation["value"] == "reference" and key:
        return key["type"]
    return {"kind": "object", "name": _object_for(type_ref["name"], context)}


def _object_for(model: str, context: _Context) -> str:
    """The object schema of a model embedded in others; created once per model."""
    existing = context.objects.get(model)
    if existing:
        return existing["name"]
    target = _resource_of(context.design, model)
    name = f"{model}Object" if target["expose"]["value"] == "resource" else model
    spec_object: dict = {"name": name, "fields": []}
    context.objects[model] = spec_object
    definition = find_model(context.schema, model)
    if definition and definition.get("description"):
        spec_object["description"] = definition["description"]
    spec_object["fields"] = [
        field
        for field in _resolve_fields(target, context, None)
        if field["access"] != "writeOnly" or target["expose"]["value"] != "resource"
    ]
    return name


def _todo_of(resource: dict, field: str) -> str | None:
    design = _field_design(resource, field)
    if not design:
        return None
    if design.get("unknownType") and design["unknownType"]["status"] == "pending":
        return f'Decide the type of "{field}": the input does not define it, so it accepts any JSON value.'
    if design.get("relation") and design["relation"]["status"] == "pending":
        return f'Decide whether "{field}" holds the key of the related item or the whole item.'
    if design["access"]["status"] == "pending":
        return f'Decide whether clients may send or read "{field}".'
    return None


def _resolve_fields(resource: dict, context: _Context, key: dict | None) -> list[dict]:
    """The fields of a model as the API sees them."""
    model = find_model(context.schema, resource["model"])
    used: set[str] = set()
    fields: list[dict] = []
    model_fields = all_fields(context.schema, model)
    for field in model_fields:
        design = _field_design(resource, field["name"])
        if design and not design["include"]:
            continue
        access = design["access"]["value"] if design else "readWrite"
        target = model_target(field["type"])
        relation = design.get("relation") if design else None
        is_reference = bool(
            relation and relation["value"] == "reference" and target is not None and target["model"] in context.keys
        )
        declared = field["serializedName"] if field.get("serializedName") is not None else field["name"]
        wire = _reference_wire(declared, target["many"]) if is_reference else declared
        # A field already named like the reference (customer next to customerId) keeps its own name
        if is_reference and any(other["name"] == wire for other in model_fields):
            wire = declared
        has_default = "defaultValue" in field
        spec = {
            "name": field["name"],
            "wire": unique_name(wire, used),
            "type": _resolve_type(field["type"], field, resource, context),
            "required": not field.get("optional") and not field.get("nullable") and not has_default,
            "nullable": field["nullable"],
            "access": access,
            "constraints": read_constraints(field, (context.schema.get("origin") or {}).get("language"))["constraints"],
        }
        if has_default:
            spec["defaultValue"] = field["defaultValue"]
        if is_reference:
            spec["reference"] = target["model"]
        # The first item of a tree has no parent: a single reference to its own model is never required
        if is_reference and not target["many"] and target["model"] == resource["model"]:
            spec["required"] = False
            spec["nullable"] = True
        if key and key["field"] == field["name"]:
            # The key is always in a response, and keeps the type resolved for the key
            spec["nullable"] = False
            spec["type"] = key["type"]
        if field.get("description"):
            spec["description"] = field["description"]
        if access == "readOnly":
            temporal = field["type"]["kind"] == "primitive" and field["type"]["name"] in ("date", "datetime")
            audit = audit_kind(field["name"]) if temporal else None
            if key and key["field"] == field["name"]:
                spec["server"] = "key"
            else:
                spec["server"] = audit if audit else "default" if has_default else "pending"
            # Nothing fills it yet: it can be empty in responses until the developer does
            if spec["server"] == "pending":
                spec["nullable"] = True
        todo = _todo_of(resource, field["name"])
        if todo:
            spec["todo"] = todo
        elif spec.get("server") == "pending":
            spec["todo"] = f'Fill "{field["name"]}" on the server: clients cannot send it.'
        fields.append(spec)
    return fields


def _resolve_endpoints(resource: dict, key: dict, fields: list[dict], settings: dict, blocked: set[str]) -> list[dict]:
    def wire_of(name: str) -> str:
        return next((field["wire"] for field in fields if field["name"] == name), name)

    result = []
    for endpoint in resource["endpoints"]:
        if not endpoint["enabled"] or endpoint["id"] in blocked:
            continue
        operation = endpoint["operation"]
        if operation == "custom":
            io = {"input": endpoint.get("input") or "none", "output": endpoint.get("output") or "resource"}
        else:
            io = _STANDARD_IO[operation]
        if settings["auth"] == "none":
            access = "public"
        elif endpoint["access"] == "default":
            access = settings["defaultAccess"]
        elif endpoint["access"] == "roles" and settings["auth"] == "apiKey":
            access = "authenticated"
        else:
            access = endpoint["access"]
        status = endpoint.get("status")
        is_list = operation == "list"
        result.append(
            {
                "id": endpoint["id"],
                "operation": operation,
                "method": endpoint["method"],
                "path": endpoint["path"],
                "name": endpoint["name"],
                "summary": endpoint["summary"],
                "access": access,
                "roles": endpoint["roles"] if access == "roles" else [],
                "status": status if status is not None else _default_status(operation, io["output"]),
                "pathParams": [
                    {"name": name, "type": key["type"] if name == key["param"] else scalar("string")}
                    for name in path_params(endpoint["path"])
                ],
                "pagination": is_list and endpoint.get("pagination") is True,
                "filters": [wire_of(name) for name in endpoint.get("filters") or []] if is_list else [],
                "sort": [wire_of(name) for name in endpoint.get("sort") or []] if is_list else [],
                "input": io["input"],
                "output": io["output"],
            }
        )
    return result


def resolve_api(schema: ModelSchema, design: dict, settings: dict) -> dict:
    """Resolves the API of a design, with the issues of the design and without the endpoints they block."""
    issues = validate_design(design, schema, settings)
    blocked = blocked_endpoints(issues)
    context = _Context(schema, design)
    resource_designs = [
        item
        for item in design["resources"]
        if item["expose"]["value"] == "resource" and find_model(schema, item["model"])
    ]

    # Keys first: a reference to a resource takes the type of its key
    extras: dict[str, dict | None] = {}
    for resource in resource_designs:
        key, extra = _resolve_key(resource, schema)
        context.keys[resource["model"]] = key
        extras[resource["model"]] = extra

    resources = []
    for resource in resource_designs:
        key = context.keys[resource["model"]]
        extra = extras[resource["model"]]
        fields = [*([extra] if extra else []), *_resolve_fields(resource, context, key)]
        # The key goes first in every schema
        fields.sort(key=lambda field: field["name"] != key["field"])
        spec = {
            "name": resource["model"],
            "singular": " ".join(name_words(resource["model"])),
            "plural": default_resource_path(resource["model"]).replace("-", " "),
            "path": resource["path"] if resource.get("path") is not None else default_resource_path(resource["model"]),
            "key": key,
            "fields": fields,
            "endpoints": _resolve_endpoints(resource, key, fields, settings, blocked),
        }
        definition = find_model(schema, resource["model"])
        if definition and definition.get("description"):
            spec["description"] = definition["description"]
        resource_key = resource.get("key")
        if resource_key and resource_key["status"] == "pending":
            if resource_key["value"]["kind"] == "generated":
                spec["todo"] = (
                    f"Decide the key of {resource['model']}: the input declares none, so the server assigns a "
                    f'generated "{key["field"]}".'
                )
            else:
                spec["todo"] = f"Decide the key of {resource['model']}."
        resources.append(spec)

    enums = []
    for item in schema["enums"]:
        values = [value["value"] if value.get("value") is not None else value["name"] for value in item["values"]]
        value_type = "integer" if all(is_number(value) for value in values) else "string"
        enums.append({"name": item["name"], "values": values, "valueType": value_type})
    roles = sorted({role for resource in resources for endpoint in resource["endpoints"] for role in endpoint["roles"]})
    return {
        "title": settings["name"],
        "resources": resources,
        "objects": list(context.objects.values()),
        "enums": enums,
        "auth": settings["auth"],
        "roles": roles,
        "issues": issues,
    }
