"""Rules of categories: what each operation checks and changes."""

from typing import Any

from app.errors import InvalidRequestError, NotFoundError
from app.repositories.category import CategoryRepository
from app.schemas.category import CategoryCreate, CategoryUpdate


_SORT_FIELDS: dict[str, str] = {}


class CategoryService:
    """Rules of categories."""

    def __init__(self, repository: CategoryRepository) -> None:
        self._repository = repository

    def _find(self, key: int) -> dict[str, Any]:
        item = self._repository.get(key)
        if item is None:
            raise NotFoundError("category")
        return item

    @staticmethod
    def _require(repository: Any, key: Any, field: str, model: str) -> None:
        """A reference must point to a stored item."""
        if key is not None and repository.get(key) is None:
            raise InvalidRequestError(field, f"No {model} has this key")

    def _check_references(self, values: dict[str, Any]) -> None:
        self._require(self._repository, values.get("parent_id"), "parentId", "Category")

    def list_categories(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        """List categories: `sort` is a JSON field name, with a leading "-" for descending order."""
        order = None
        if sort:
            descending = sort.startswith("-")
            order = (_SORT_FIELDS[sort.lstrip("-")], descending)
        return self._repository.list(filters, order, offset, limit)

    def get_category(self, key: int) -> dict[str, Any]:
        """Get a category."""
        return self._find(key)

    def create_category(self, data: CategoryCreate) -> dict[str, Any]:
        """Create a category."""
        values = data.model_dump()
        self._check_references(values)
        return self._repository.add(values)

    def replace_category(self, key: int, data: CategoryCreate) -> dict[str, Any]:
        """Replace a category: every field the client may send takes the value of the body."""
        self._find(key)
        values = data.model_dump()
        self._check_references(values)
        return self._repository.update(key, values)

    def update_category(self, key: int, data: CategoryUpdate) -> dict[str, Any]:
        """Update part of a category: only the fields in the body change."""
        self._find(key)
        values = data.model_dump(exclude_unset=True)
        self._check_references(values)
        return self._repository.update(key, values)

    def delete_category(self, key: int) -> None:
        """Delete a category."""
        self._find(key)
        self._repository.delete(key)
