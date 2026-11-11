"""Rules of customers: what each operation checks and changes."""

from datetime import UTC, datetime
from typing import Any

from app.errors import NotFoundError
from app.repositories.customer import CustomerRepository
from app.schemas.customer import CustomerCreate, CustomerUpdate


_SORT_FIELDS: dict[str, str] = {}


class CustomerService:
    """Rules of customers."""

    def __init__(self, repository: CustomerRepository) -> None:
        self._repository = repository

    def _find(self, key: int) -> dict[str, Any]:
        item = self._repository.get(key)
        if item is None:
            raise NotFoundError("customer")
        return item

    def list_customers(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        """List customers: `sort` is a JSON field name, with a leading "-" for descending order."""
        order = None
        if sort:
            descending = sort.startswith("-")
            order = (_SORT_FIELDS[sort.lstrip("-")], descending)
        return self._repository.list(filters, order, offset, limit)

    def get_customer(self, key: int) -> dict[str, Any]:
        """Get a customer."""
        return self._find(key)

    def create_customer(self, data: CustomerCreate) -> dict[str, Any]:
        """Create a customer."""
        values = data.model_dump()
        now = datetime.now(UTC)
        values["created_at"] = now
        return self._repository.add(values)

    def replace_customer(self, key: int, data: CustomerCreate) -> dict[str, Any]:
        """Replace a customer: every field the client may send takes the value of the body."""
        self._find(key)
        values = data.model_dump()
        return self._repository.update(key, values)

    def update_customer(self, key: int, data: CustomerUpdate) -> dict[str, Any]:
        """Update part of a customer: only the fields in the body change."""
        self._find(key)
        values = data.model_dump(exclude_unset=True)
        return self._repository.update(key, values)

    def delete_customer(self, key: int) -> None:
        """Delete a customer."""
        self._find(key)
        self._repository.delete(key)
