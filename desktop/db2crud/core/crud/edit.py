"""Edits of a CRUD design. Each returns a new design and leaves the previous one untouched, so the history can keep
it for undo. After an edit that changes a table decision, the caller proposes the design again with the edited one
as `previous` (crud/propose.py). Mirrors web/src/core/crud/edit.ts.

A reference to a decision is {"kind": "policy", "table", "decision"}, {"kind": "query", "table", "id"} or
{"kind": "operation", "table", "id"}.
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


def find_decision(design: dict, ref: dict) -> dict | None:
    """The decision a reference points to, or None when the design no longer has it."""
    if ref["kind"] == "policy":
        policy = next((item for item in design["policies"] if item["table"] == ref["table"]), None)
        return policy[ref["decision"]] if policy else None
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
    return set_operation_include(design, ref["table"], ref["id"], current["value"])


def pending_decisions(design: dict) -> list[dict]:
    """Every decision still waiting for the user, table by table: policies, then queries, then operations."""
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
    return pending
