"""Rules of items: what each operation checks and changes."""

from typing import Any

from app.errors import InvalidRequestError, NotFoundError
from app.repositories.category import CategoryRepository
from app.repositories.item import ItemRepository
from app.schemas.item import ItemCreate, ItemUpdate


_SORT_FIELDS: dict[str, str] = {}


class ItemService:
    """Rules of items."""

    def __init__(self, repository: ItemRepository, categories: CategoryRepository) -> None:
        self._repository = repository
        self._categories = categories

    def _find(self, key: int) -> dict[str, Any]:
        item = self._repository.get(key)
        if item is None:
            raise NotFoundError("item")
        return item

    @staticmethod
    def _require(repository: Any, key: Any, field: str, model: str) -> None:
        """A reference must point to a stored item."""
        if key is not None and repository.get(key) is None:
            raise InvalidRequestError(field, f"No {model} has this key")

    def _check_references(self, values: dict[str, Any]) -> None:
        self._require(self._categories, values.get("category_id"), "categoryId", "Category")

    def list_items(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        """List items: `sort` is a JSON field name, with a leading "-" for descending order."""
        order = None
        if sort:
            descending = sort.startswith("-")
            order = (_SORT_FIELDS[sort.lstrip("-")], descending)
        return self._repository.list(filters, order, offset, limit)

    def get_item(self, key: int) -> dict[str, Any]:
        """Get an item."""
        return self._find(key)

    def create_item(self, data: ItemCreate) -> dict[str, Any]:
        """Create an item."""
        values = data.model_dump()
        self._check_references(values)
        return self._repository.add(values)

    def replace_item(self, key: int, data: ItemCreate) -> dict[str, Any]:
        """Replace an item: every field the client may send takes the value of the body."""
        self._find(key)
        values = data.model_dump()
        self._check_references(values)
        return self._repository.update(key, values)

    def update_item(self, key: int, data: ItemUpdate) -> dict[str, Any]:
        """Update part of an item: only the fields in the body change."""
        self._find(key)
        values = data.model_dump(exclude_unset=True)
        self._check_references(values)
        return self._repository.update(key, values)

    def delete_item(self, key: int) -> None:
        """Delete an item."""
        self._find(key)
        self._repository.delete(key)
