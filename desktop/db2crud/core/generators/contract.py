"""What every generator writes in crud-contract.json beyond the operations themselves, the same in every language: the
entity a service manages and the fields of its key, and the fields of the entity that each column of `by` is
(docs/interoperability.md). CRUD2Controller reads them instead of matching names. Each generator passes how it names
a column's field in its language ("attr", "prop", "key"). Mirrors web/src/core/generators/contract.ts."""


def service_target(info: dict, field: str) -> dict:
    """The entity of a service and the fields of its key."""
    return {"entity": info["entity"], "key": [column[field] for column in info["key"]]}


def by_fields(columns: list[dict], by: list[str], field: str) -> list[str]:
    """The field of each column of `by`, in the same order; a column the table does not have keeps its name."""
    result = []
    for name in by:
        column = next((candidate for candidate in columns if candidate["column"]["name"] == name), None)
        result.append(column[field] if column else name)
    return result
