"""Storage of customers."""

from copy import deepcopy
from typing import Any, Protocol


class CustomerRepository(Protocol):
    """Where customers are kept. The service depends only on this interface."""

    def list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        """Items equal to every filter, sorted by (field, descending), from `offset`, at most `limit`; and how many match."""
        ...

    def get(self, key: int) -> dict[str, Any] | None:
        """The item with this key, or None."""
        ...

    def add(self, values: dict[str, Any]) -> dict[str, Any]:
        """Stores a new item; a key the server generates is assigned here. Returns the stored item."""
        ...

    def update(self, key: int, values: dict[str, Any]) -> dict[str, Any]:
        """Changes the given fields of an existing item and returns it."""
        ...

    def delete(self, key: int) -> None:
        """Removes an existing item."""
        ...


class InMemoryCustomerRepository:
    """Keeps customers in memory: they are lost when the application stops. Use it to try the API."""

    def __init__(self) -> None:
        self._items: dict[int, dict[str, Any]] = {}
        self._next_key = 1

    def list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        items = [item for item in self._items.values() if all(item.get(name) == value for name, value in filters.items())]
        if sort is not None:
            name, descending = sort
            # Items without a value go last, whatever the order
            present = sorted((item for item in items if item.get(name) is not None), key=lambda item: item[name], reverse=descending)
            items = present + [item for item in items if item.get(name) is None]
        end = None if limit is None else offset + limit
        return [deepcopy(item) for item in items[offset:end]], len(items)

    def get(self, key: int) -> dict[str, Any] | None:
        item = self._items.get(key)
        return deepcopy(item) if item is not None else None

    def add(self, values: dict[str, Any]) -> dict[str, Any]:
        values = deepcopy(values)
        values["id"] = self._next_key
        self._next_key += 1
        self._items[values["id"]] = values
        return deepcopy(values)

    def update(self, key: int, values: dict[str, Any]) -> dict[str, Any]:
        self._items[key].update(deepcopy(values))
        return deepcopy(self._items[key])

    def delete(self, key: int) -> None:
        del self._items[key]
