"""Rules of authors: what each operation checks and changes."""

from typing import Any
from uuid import UUID

from app.errors import NotFoundError
from app.repositories.author import AuthorRepository
from app.schemas.author import AuthorCreate, AuthorUpdate


_SORT_FIELDS: dict[str, str] = {}


class AuthorService:
    """Rules of authors."""

    def __init__(self, repository: AuthorRepository) -> None:
        self._repository = repository

    def _find(self, key: UUID) -> dict[str, Any]:
        item = self._repository.get(key)
        if item is None:
            raise NotFoundError("author")
        return item

    def list_authors(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        """List authors: `sort` is a JSON field name, with a leading "-" for descending order."""
        order = None
        if sort:
            descending = sort.startswith("-")
            order = (_SORT_FIELDS[sort.lstrip("-")], descending)
        return self._repository.list(filters, order, offset, limit)

    def get_author(self, key: UUID) -> dict[str, Any]:
        """Get an author."""
        return self._find(key)

    def create_author(self, data: AuthorCreate) -> dict[str, Any]:
        """Create an author."""
        values = data.model_dump()
        return self._repository.add(values)

    def replace_author(self, key: UUID, data: AuthorCreate) -> dict[str, Any]:
        """Replace an author: every field the client may send takes the value of the body."""
        self._find(key)
        values = data.model_dump()
        return self._repository.update(key, values)

    def update_author(self, key: UUID, data: AuthorUpdate) -> dict[str, Any]:
        """Update part of an author: only the fields in the body change."""
        self._find(key)
        values = data.model_dump(exclude_unset=True)
        return self._repository.update(key, values)

    def delete_author(self, key: UUID) -> None:
        """Delete an author."""
        self._find(key)
        self._repository.delete(key)
