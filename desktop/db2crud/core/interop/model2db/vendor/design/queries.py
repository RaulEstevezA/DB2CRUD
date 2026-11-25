"""The queries the application runs on a stored model, which decide its indexes. The model only says which fields
exist, not how rows are filtered and ordered, so a query is proposed only where the shape is common (rows of an
owner, newest first) and always waits for the user. Mirrors web/src/core/design/queries.ts."""

import json

from ..model.naming import name_words
from .decision import reason


def queryable_fields(fields: list[dict], decided: list[dict]) -> list[str]:
    """Fields a query can use: stored scalar values and references to one other model (their key column)."""
    result = []
    for field in fields:
        design = next((item for item in decided if item["field"] == field["name"]), None)
        if not design or not design["include"]:
            continue
        kind = field["type"]["kind"]
        if kind in ("primitive", "enum"):
            if not design.get("relation"):
                result.append(field["name"])
        elif kind == "model" and (design.get("relation") or {}).get("value") == "reference":
            result.append(field["name"])
    return result


# Words of date fields that do not order the rows of an owner
NOT_ORDERING = {"updated", "modified", "deleted", "expires", "expiry", "birth", "born", "due", "last"}


def _ordering_date(fields: list[dict], queryable: list[str]) -> dict | None:
    """The date the rows of an owner are read by: `createdAt` first, then any other date that is not an update,
    a deletion or an expiry."""
    dates = [
        field
        for field in fields
        if field["name"] in queryable
        and field["type"]["kind"] == "primitive"
        and field["type"]["name"] in ("datetime", "date")
        and not any(word in NOT_ORDERING for word in name_words(field["name"]))
    ]
    created = next((field for field in dates if "created" in name_words(field["name"])), None)
    return created or (dates[0] if dates else None)


def propose_queries(fields: list[dict], decided: list[dict], named_owner) -> list[dict]:
    """One query per field that points to an owner (`userId`, `author: User`), when the model has a date to order
    by: the rows of that owner, newest first. `named_owner` says whether a scalar field is named after another
    model's key, for the databases without foreign keys."""
    queryable = queryable_fields(fields, decided)
    date = _ordering_date(fields, queryable)
    if not date:
        return []

    def owner(item: dict) -> bool:
        if item.get("relation"):
            return item["relation"]["value"] == "reference"
        if item.get("foreignKey"):
            return item["foreignKey"]["value"] is not None
        field = next((other for other in fields if other["name"] == item["field"]), None)
        return field is not None and named_owner(field)

    return [
        {
            "filter": [item["field"]],
            "sort": [{"field": date["name"], "direction": "desc"}],
            "status": "pending",
            "reasons": [reason("queryByOwner", {"field": item["field"], "sort": date["name"]})],
        }
        for item in decided
        if item["field"] in queryable and owner(item)
    ]


def query_fields(query: dict) -> list[str]:
    """The fields of a query, filter first."""
    return [*query["filter"], *(item["field"] for item in query["sort"])]


def same_query(a: dict, b: dict) -> bool:
    return json.dumps([a["filter"], a["sort"]]) == json.dumps([b["filter"], b["sort"]])


def keep_query(query: dict, queryable: list[str]) -> dict | None:
    """A query that still makes sense for these fields: the ones gone are dropped, and so is the query if nothing
    is left."""
    filter_ = [field for field in query["filter"] if field in queryable]
    sort = [item for item in query["sort"] if item["field"] in queryable and item["field"] not in filter_]
    if not filter_ and not sort:
        return None
    if len(filter_) == len(query["filter"]) and len(sort) == len(query["sort"]):
        return query
    return {**query, "filter": filter_, "sort": sort}


def clean_query(filter_: list[str], sort: list[dict]) -> dict:
    """A query written by the user: fields used once, in order, filter before sort."""
    seen: set[str] = set()

    def once(field: str) -> bool:
        if field in seen:
            return False
        seen.add(field)
        return True

    return {
        "filter": [field for field in filter_ if once(field)],
        "sort": [item for item in sort if once(item["field"])],
    }


def describe_query(query: dict) -> str:
    """A query in the words of the generated code: `by userId, ordered by createdAt desc`."""
    parts = []
    if query["filter"]:
        parts.append(f"by {', '.join(query['filter'])}")
    if query["sort"]:
        order = ", ".join(f"{item['field']} {item['direction']}" for item in query["sort"])
        parts.append(f"ordered by {order}")
    return ", ".join(parts)
