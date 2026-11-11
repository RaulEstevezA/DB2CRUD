"""Rules of orders: what each operation checks and changes."""

from datetime import UTC, datetime
from typing import Any

from app.errors import InvalidRequestError, NotFoundError
from app.repositories.customer import CustomerRepository
from app.repositories.order import OrderRepository
from app.repositories.product import ProductRepository
from app.schemas.order import OrderCreate, OrderUpdate


_SORT_FIELDS: dict[str, str] = {}


class OrderService:
    """Rules of orders."""

    def __init__(self, repository: OrderRepository, customers: CustomerRepository, products: ProductRepository) -> None:
        self._repository = repository
        self._customers = customers
        self._products = products

    def _find(self, key: int) -> dict[str, Any]:
        item = self._repository.get(key)
        if item is None:
            raise NotFoundError("order")
        return item

    @staticmethod
    def _require(repository: Any, key: Any, field: str, model: str) -> None:
        """A reference must point to a stored item."""
        if key is not None and repository.get(key) is None:
            raise InvalidRequestError(field, f"No {model} has this key")

    def _check_references(self, values: dict[str, Any]) -> None:
        self._require(self._customers, values.get("customer_id"), "customerId", "Customer")
        for item0 in values.get("lines") or []:
            self._require(self._products, item0.get("product_id"), "lines.productId", "Product")

    def list_orders(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        """List orders: `sort` is a JSON field name, with a leading "-" for descending order."""
        order = None
        if sort:
            descending = sort.startswith("-")
            order = (_SORT_FIELDS[sort.lstrip("-")], descending)
        return self._repository.list(filters, order, offset, limit)

    def get_order(self, key: int) -> dict[str, Any]:
        """Get an order."""
        return self._find(key)

    def create_order(self, data: OrderCreate) -> dict[str, Any]:
        """Create an order."""
        values = data.model_dump()
        self._check_references(values)
        now = datetime.now(UTC)
        values["created_at"] = now
        values["updated_at"] = now
        return self._repository.add(values)

    def replace_order(self, key: int, data: OrderCreate) -> dict[str, Any]:
        """Replace an order: every field the client may send takes the value of the body."""
        self._find(key)
        values = data.model_dump()
        self._check_references(values)
        now = datetime.now(UTC)
        values["updated_at"] = now
        return self._repository.update(key, values)

    def update_order(self, key: int, data: OrderUpdate) -> dict[str, Any]:
        """Update part of an order: only the fields in the body change."""
        self._find(key)
        values = data.model_dump(exclude_unset=True)
        self._check_references(values)
        now = datetime.now(UTC)
        values["updated_at"] = now
        return self._repository.update(key, values)

    def delete_order(self, key: int) -> None:
        """Delete an order."""
        self._find(key)
        self._repository.delete(key)
