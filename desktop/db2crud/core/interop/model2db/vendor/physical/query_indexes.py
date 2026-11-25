"""Turns the queries of a stored model into indexes, shared by tables and collections: the filter fields first and
then the sort fields, each in its order, so one index finds the rows and returns them sorted. Mirrors
web/src/core/physical/queryIndexes.ts.

A target is a dictionary: `name` (table or collection), `model`, `column_of` (field → column or path, or None),
`indexes` (the list to add to), `covering` (key and unique constraints) and `pending` (called for a query still
waiting for the user)."""

from ..design.queries import describe_query, query_fields
from .naming import constraint_name, free_name


def add_query_indexes(target: dict, queries: list[dict], notes: list[dict]) -> bool:
    """Adds the index of every active query. Returns whether any query turned into an index."""
    added = False
    for query in queries:
        text = describe_query(query)
        if query["status"] == "pending":
            target["pending"](text)
            continue
        columns = [target["column_of"](field) for field in query_fields(query)]
        if any(column is None for column in columns):
            notes.append({"code": "queryNotIndexed", "params": {"model": target["model"], "query": text}})
            continue
        descending = [target["column_of"](item["field"]) for item in query["sort"] if item["direction"] == "desc"]
        _add_index(target, columns, descending, len(query["filter"]), f"{target['model']} {text}")
        added = True
    return added


def _serves(index: dict, columns: list[str], descending: list[str], equal: int) -> bool:
    """Whether `index` starts with `columns` and returns them in the order wanted: the first `equal` columns are
    compared with a value, so their direction does not matter; the others must keep their directions, or have all
    of them reversed, since the database reads an index both ways."""
    if len(index["columns"]) < len(columns) or any(index["columns"][i] != column for i, column in enumerate(columns)):
        return False
    kept = index.get("descending") or []
    same = [(column in descending) == (column in kept) for column in columns[equal:]]
    return all(same) or not any(same)


def _add_index(target: dict, columns: list[str], descending: list[str], equal: int, query: str) -> None:
    if any(_serves(index, columns, descending, equal) for index in [*target["covering"], *target["indexes"]]):
        return
    # Plain indexes on the first columns of this one are no longer needed (the index of a foreign key, too)
    indexes = target["indexes"]
    for i in range(len(indexes) - 1, -1, -1):
        index = indexes[i]
        if (
            not index["unique"]
            and len(index["columns"]) < len(columns)
            and _serves(
                {"columns": columns, "descending": descending},
                index["columns"],
                index.get("descending") or [],
                min(equal, len(index["columns"])),
            )
        ):
            del indexes[i]
    used = {index["name"].lower() for index in indexes}
    name = free_name(constraint_name("ix", target["name"], [column.replace(".", "_") for column in columns]), used)
    index = {"name": name, "columns": columns, "unique": False}
    if descending:
        index["descending"] = descending
    index["query"] = query
    indexes.append(index)
