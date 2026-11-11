"""How resources refer to each other through their fields, embedded objects included. Every generator that checks
references before storing an item reads them the same way. Mirrors web/src/core/generators/common/references.ts.
"""


def inner_object(type_ref: dict) -> str | None:
    """The embedded object a type holds, directly or as the items of a list or map."""
    if type_ref["kind"] == "object":
        return type_ref["name"]
    if type_ref["kind"] == "array":
        return inner_object(type_ref["items"])
    if type_ref["kind"] == "map":
        return inner_object(type_ref["value"])
    return None


def referenced_resources(project, resource: dict) -> list[dict]:
    """Resources a resource refers to, directly or inside its embedded objects, other than itself."""
    found: set[str] = set()

    def visit(fields: list[dict], seen: frozenset[str]) -> None:
        for field in fields:
            if field.get("reference"):
                found.add(field["reference"])
            inner = inner_object(field["type"])
            if inner and inner not in seen:
                spec_object = next((item for item in project.spec["objects"] if item["name"] == inner), None)
                if spec_object:
                    visit(spec_object["fields"], seen | {inner})

    visit(resource["fields"], frozenset())
    found.discard(resource["name"])
    return [item for item in project.spec["resources"] if item["name"] in found]
