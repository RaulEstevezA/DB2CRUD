"""What happens to each model once the decisions are applied. Mirrors web/src/core/physical/roles.ts."""

from ..design.analysis import analyze, is_parent_only, is_top_level, reaches
from ..design.types import find_model_design
from ..model.schema import all_fields, find_model, model_of

# Relations that need the other model to have its own table or collection
_NEEDS_STORAGE = ("reference", "child", "join")


def model_roles(schema: dict, design: dict) -> dict[str, str]:
    context = analyze(schema)
    roles: dict[str, str] = {}
    queue: list[str] = []
    for model in schema["models"]:
        if not is_top_level(context, model["name"]):
            continue
        item = find_model_design(design, model["name"])
        if item is not None and item["include"] is False:
            roles[model["name"]] = "parent" if is_parent_only(context, model["name"]) else "excluded"
        else:
            roles[model["name"]] = "stored"
            queue.append(model["name"])
    embedded: set[str] = set()
    pending: set[str] = set()
    # Embedded documents and user-defined types can still refer to other models; flattened columns and JSON cannot
    nested = design["target"] in ("document", "widecolumn")

    def visit(name: str, inside: bool) -> None:
        model = find_model(schema, name)
        item = find_model_design(design, name)
        if not model or not item:
            return
        for field in all_fields(schema, model):
            decided = next((other for other in item["fields"] if other["field"] == field["name"]), None)
            target = model_of(field["type"])
            if not decided or not decided["include"] or not decided.get("relation") or not target or target == name:
                continue
            if decided["relation"]["status"] == "pending":
                pending.add(target)
                continue
            stores = decided["relation"]["value"] in _NEEDS_STORAGE and (nested or not inside)
            if stores:
                if roles.get(target) != "stored":
                    roles[target] = "stored"
                    queue.append(target)
            elif target not in embedded:
                embedded.add(target)
                visit(target, not nested)

    while queue:
        visit(queue.pop(0), False)
    # Models that only refer to each other are never reached from a model nobody uses
    changed = True
    while changed:
        changed = False
        for model in schema["models"]:
            if model["name"] in roles or model["name"] in embedded:
                continue
            item = find_model_design(design, model["name"])
            for field in all_fields(schema, model):
                decided = (
                    next((other for other in item["fields"] if other["field"] == field["name"]), None) if item else None
                )
                target = model_of(field["type"])
                relation = decided.get("relation") if decided else None
                if (
                    not decided
                    or not decided["include"]
                    or not relation
                    or relation["status"] != "active"
                    or not target
                    or target in roles
                ):
                    continue
                if relation["value"] not in _NEEDS_STORAGE or not reaches(context, target, model["name"]):
                    continue
                roles[target] = "stored"
                queue.append(target)
                changed = True
            while queue:
                visit(queue.pop(0), False)
    for model in schema["models"]:
        if model["name"] in roles:
            continue
        if model["name"] in embedded:
            roles[model["name"]] = "embedded"
        elif model["name"] in pending:
            roles[model["name"]] = "pending"
        else:
            roles[model["name"]] = "unused"
    return roles
