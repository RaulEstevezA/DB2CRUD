"""Rules of books: what each operation checks and changes."""

from typing import Any
from uuid import UUID

from app.errors import InvalidRequestError, NotFoundError
from app.repositories.author import AuthorRepository
from app.repositories.book import BookRepository
from app.schemas.book import BookCreate, BookUpdate


_SORT_FIELDS: dict[str, str] = {}


class BookService:
    """Rules of books."""

    def __init__(self, repository: BookRepository, authors: AuthorRepository) -> None:
        self._repository = repository
        self._authors = authors

    def _find(self, key: UUID) -> dict[str, Any]:
        item = self._repository.get(key)
        if item is None:
            raise NotFoundError("book")
        return item

    @staticmethod
    def _require(repository: Any, key: Any, field: str, model: str) -> None:
        """A reference must point to a stored item."""
        if key is not None and repository.get(key) is None:
            raise InvalidRequestError(field, f"No {model} has this key")

    def _check_references(self, values: dict[str, Any]) -> None:
        self._require(self._authors, values.get("author_id"), "authorId", "Author")

    def list_books(self, filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:
        """List books: `sort` is a JSON field name, with a leading "-" for descending order."""
        order = None
        if sort:
            descending = sort.startswith("-")
            order = (_SORT_FIELDS[sort.lstrip("-")], descending)
        return self._repository.list(filters, order, offset, limit)

    def get_book(self, key: UUID) -> dict[str, Any]:
        """Get a book."""
        return self._find(key)

    def create_book(self, data: BookCreate) -> dict[str, Any]:
        """Create a book."""
        values = data.model_dump()
        self._check_references(values)
        return self._repository.add(values)

    def replace_book(self, key: UUID, data: BookCreate) -> dict[str, Any]:
        """Replace a book: every field the client may send takes the value of the body."""
        self._find(key)
        values = data.model_dump()
        self._check_references(values)
        return self._repository.update(key, values)

    def update_book(self, key: UUID, data: BookUpdate) -> dict[str, Any]:
        """Update part of a book: only the fields in the body change."""
        self._find(key)
        values = data.model_dump(exclude_unset=True)
        self._check_references(values)
        return self._repository.update(key, values)

    def delete_book(self, key: UUID) -> None:
        """Delete a book."""
        self._find(key)
        self._repository.delete(key)
