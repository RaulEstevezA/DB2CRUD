"""Edits of a CRUD design. Each returns a new design and leaves the previous one untouched, so the history can keep
it for undo. After an edit that changes a table decision, the caller proposes the design again with the edited one
as `previous` (crud/propose.py). Mirrors web/src/core/crud/edit.ts.

A reference to a decision is {"kind": "policy", "table", "decision"}, {"kind": "query", "table", "id"},
{"kind": "operation", "table", "id"}, or one of the matching of the application models: {"kind": "model", "table",
"direction"}, {"kind": "source", "table", "direction", "column"} or {"kind": "childTable", "table", "direction",
"field"}.
"""

from ..decisions.decision import same_value


def _choose(current: dict, value) -> dict:
    """The user's choice: it becomes active, whatever its confidence was."""
    if not any(same_value(option, value) for option in current["options"]):
        return current
    return {**current, "value": value, "status": "active", "manual": True}


def decide_policy(design: dict, table: str, kind: str, value) -> dict:
    """Chooses a value for a table decision. A value that is not one of its options leaves the design as it is."""

    def change(policy: dict) -> dict:
        current = policy[kind]
        return {**policy, kind: _choose(current, value)} if current else policy

    return {
        **design,
        "policies": [change(policy) if policy["table"] == table else policy for policy in design["policies"]],
    }


def set_query_include(design: dict, table: str, query_id: str, include: bool) -> dict:
    """Turns a query of a repository on or off."""
    return {
        **design,
        "repositories": [
            repository
            if repository["table"] != table
            else {
                **repository,
                "queries": [
                    {**query, "include": _choose(query["include"], include)} if query["id"] == query_id else query
                    for query in repository["queries"]
                ],
            }
            for repository in design["repositories"]
        ],
    }


def set_operation_include(design: dict, table: str, operation_id: str, include: bool) -> dict:
    """Turns an operation of a service on or off."""
    return {
        **design,
        "services": [
            service
            if service["table"] != table
            else {
                **service,
                "operations": [
                    {**operation, "include": _choose(operation["include"], include)}
                    if operation["id"] == operation_id
                    else operation
                    for operation in service["operations"]
                ],
            }
            for service in design["services"]
        ],
    }


def _map_model_match(design: dict, table: str, direction: str, change) -> dict:
    if not design.get("matching"):
        return design
    tables = [
        item
        if item["table"] != table
        else {
            **item,
            "models": [change(match) if match["direction"] == direction else match for match in item["models"]],
        }
        for item in design["matching"]["tables"]
    ]
    return {**design, "matching": {"tables": tables}}


def _find_model_match(design: dict, table: str, direction: str) -> dict | None:
    item = next((item for item in (design.get("matching") or {}).get("tables", []) if item["table"] == table), None)
    return next((match for match in item["models"] if match["direction"] == direction), None) if item else None


def choose_model(design: dict, table: str, direction: str, model: str | None) -> dict:
    """Chooses the model of a table in one direction. The columns are matched again with the new model when the
    design is proposed again: the choices made on those of the previous one are left behind."""

    def change(match: dict) -> dict:
        chosen = _choose(match["model"], model)
        if chosen is match["model"]:
            return match
        if same_value(match["model"]["value"], model):
            return {**match, "model": chosen}
        return {**match, "model": chosen, "columns": [], "children": []}

    return _map_model_match(design, table, direction, change)


def choose_source(design: dict, table: str, direction: str, column: str, source: dict | None) -> dict:
    """Chooses where a column comes from (or goes to) in the model of one direction."""

    def change(match: dict) -> dict:
        columns = [
            {**item, "source": _choose(item["source"], source)} if item["column"] == column else item
            for item in match["columns"]
        ]
        return {**match, "columns": columns}

    return _map_model_match(design, table, direction, change)


def choose_child_table(design: dict, table: str, direction: str, field: str, child: str | None) -> dict:
    """Chooses the child table a list field stands for, or none."""

    def change(match: dict) -> dict:
        children = [
            {**item, "table": _choose(item["table"], child)} if item["field"] == field else item
            for item in match["children"]
        ]
        return {**match, "children": children}

    return _map_model_match(design, table, direction, change)


def find_decision(design: dict, ref: dict) -> dict | None:
    """The decision a reference points to, or None when the design no longer has it."""
    if ref["kind"] == "policy":
        policy = next((item for item in design["policies"] if item["table"] == ref["table"]), None)
        return policy[ref["decision"]] if policy else None
    if ref["kind"] in ("model", "source", "childTable"):
        match = _find_model_match(design, ref["table"], ref["direction"])
        if match is None:
            return None
        if ref["kind"] == "model":
            return match["model"]
        if ref["kind"] == "source":
            return next((item["source"] for item in match["columns"] if item["column"] == ref["column"]), None)
        return next((item["table"] for item in match["children"] if item["field"] == ref["field"]), None)
    if ref["kind"] == "query":
        items = next((item["queries"] for item in design["repositories"] if item["table"] == ref["table"]), [])
    else:
        items = next((item["operations"] for item in design["services"] if item["table"] == ref["table"]), [])
    return next((item["include"] for item in items if item["id"] == ref["id"]), None)


def accept(design: dict, ref: dict) -> dict:
    """Confirms a pending proposal as it is."""
    current = find_decision(design, ref)
    if not current:
        return design
    if ref["kind"] == "policy":
        return decide_policy(design, ref["table"], ref["decision"], current["value"])
    if ref["kind"] == "query":
        return set_query_include(design, ref["table"], ref["id"], current["value"])
    if ref["kind"] == "model":
        return choose_model(design, ref["table"], ref["direction"], current["value"])
    if ref["kind"] == "source":
        return choose_source(design, ref["table"], ref["direction"], ref["column"], current["value"])
    if ref["kind"] == "childTable":
        return choose_child_table(design, ref["table"], ref["direction"], ref["field"], current["value"])
    return set_operation_include(design, ref["table"], ref["id"], current["value"])


def pending_decisions(design: dict) -> list[dict]:
    """Every decision still waiting for the user, table by table: policies, queries, operations, then the models."""
    pending: list[dict] = []
    for policy in design["policies"]:
        table = policy["table"]
        for kind in ("role", "delete", "concurrency", "children", "hidden"):
            if policy[kind] and policy[kind]["status"] == "pending":
                pending.append({"kind": "policy", "table": table, "decision": kind})
        repository = next((item for item in design["repositories"] if item["table"] == table), None)
        for query in repository["queries"] if repository else []:
            if query["include"]["status"] == "pending":
                pending.append({"kind": "query", "table": table, "id": query["id"]})
        service = next((item for item in design["services"] if item["table"] == table), None)
        for operation in service["operations"] if service else []:
            if operation["include"]["status"] == "pending":
                pending.append({"kind": "operation", "table": table, "id": operation["id"]})
        item = next((item for item in (design.get("matching") or {}).get("tables", []) if item["table"] == table), None)
        for match in item["models"] if item else []:
            direction = match["direction"]
            if match["model"]["status"] == "pending":
                pending.append({"kind": "model", "table": table, "direction": direction})
            for column in match["columns"]:
                if column["source"]["status"] == "pending":
                    pending.append(
                        {"kind": "source", "table": table, "direction": direction, "column": column["column"]}
                    )
            for child in match["children"]:
                if child["table"]["status"] == "pending":
                    pending.append(
                        {"kind": "childTable", "table": table, "direction": direction, "field": child["field"]}
                    )
    return pending
