"""Rules of products: what each operation checks and changes."""

from typing import Any

from app.errors import NotFoundError
from app.repositories.product import ProductRepository
from app.schemas.product import ProductCreate, ProductUpdate


_SORT_FIELDS: dict[str, str] = {}


class ProductService:
    """Rules of products."""

    def __init__(self, repository: ProductRepository) -> None:
        self._repository = repository

    def _find(self, key: int) -> dict[str, Any]:
        item = self._repository.get(key)
        if item is None:
            raise NotFoundError("product")
        return item

    def list_products(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        """List products: `sort` is a JSON field name, with a leading "-" for descending order."""
        order = None
        if sort:
            descending = sort.startswith("-")
            order = (_SORT_FIELDS[sort.lstrip("-")], descending)
        return self._repository.list(filters, order, offset, limit)

    def get_product(self, key: int) -> dict[str, Any]:
        """Get a product."""
        return self._find(key)

    def create_product(self, data: ProductCreate) -> dict[str, Any]:
        """Create a product."""
        values = data.model_dump()
        return self._repository.add(values)

    def replace_product(self, key: int, data: ProductCreate) -> dict[str, Any]:
        """Replace a product: every field the client may send takes the value of the body."""
        self._find(key)
        values = data.model_dump()
        return self._repository.update(key, values)

    def update_product(self, key: int, data: ProductUpdate) -> dict[str, Any]:
        """Update part of a product: only the fields in the body change."""
        self._find(key)
        values = data.model_dump(exclude_unset=True)
        return self._repository.update(key, values)

    def delete_product(self, key: int) -> None:
        """Delete a product."""
        self._find(key)
        self._repository.delete(key)
