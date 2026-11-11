"""Mirrors web/src/core/physical/order.ts."""


def order_tables(tables: list[dict]) -> tuple[list[dict], dict[str, list[dict]]]:
    """Tables in an order where each one comes after the tables it refers to; references that close a cycle
    are returned apart, to be added once every table exists."""
    by_name = {table["name"]: table for table in tables}
    done: set[str] = set()
    visiting: set[str] = set()
    result: list[dict] = []
    deferred: dict[str, list[dict]] = {}

    def visit(table: dict) -> None:
        if table["name"] in done:
            return
        visiting.add(table["name"])
        for fk in table["foreignKeys"]:
            target = by_name.get(fk["table"])
            if not target or target["name"] == table["name"] or target["name"] in done:
                continue
            if target["name"] in visiting:
                deferred[table["name"]] = [*deferred.get(table["name"], []), fk]
            else:
                visit(target)
        visiting.discard(table["name"])
        done.add(table["name"])
        result.append(table)

    for table in tables:
        visit(table)
    return result, deferred
