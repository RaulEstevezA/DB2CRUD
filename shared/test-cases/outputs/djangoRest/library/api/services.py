"""Rules of each resource: what each operation checks and changes."""

from typing import Any

from api.models import Author, Book
from config.errors import NotFoundError


# JSON names of the fields of authors a list can be sorted by, and their ORM names
_SORT_FIELDS_AUTHOR = {"id": "id", "name": "name", "email": "email", "born": "born"}


class AuthorService:
    """Rules of authors."""

    @staticmethod
    def find(key: Any) -> Author:
        try:
            return Author.objects.get(pk=key)
        except (Author.DoesNotExist, ValueError, TypeError) as error:
            raise NotFoundError("author") from error

    @staticmethod
    def list_authors(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[Author], int]:
        """List authors: `sort` is a JSON field name, with a leading "-" for descending order."""
        query = Author.objects.filter(**filters)
        if sort:
            field = _SORT_FIELDS_AUTHOR[sort.lstrip("-")]
            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")
        total = query.count()
        items = query[offset : offset + limit] if limit is not None else query
        return list(items), total

    @staticmethod
    def get_author(key: Any) -> Author:
        """Get an author."""
        return AuthorService.find(key)

    @staticmethod
    def create_author(data: dict[str, Any]) -> Author:
        """Create an author."""
        return Author.objects.create(**data)

    @staticmethod
    def replace_author(key: Any, data: dict[str, Any]) -> Author:
        """Replace an author: every field the client may send takes the value of the body."""
        item = AuthorService.find(key)
        for field in ("name", "email", "born"):
            setattr(item, field, data.get(field))
        item.save()
        return item

    @staticmethod
    def update_author(key: Any, data: dict[str, Any]) -> Author:
        """Update part of an author: only the fields in the body change."""
        item = AuthorService.find(key)
        for field, value in data.items():
            setattr(item, field, value)
        item.save()
        return item

    @staticmethod
    def delete_author(key: Any) -> None:
        """Delete an author."""
        AuthorService.find(key).delete()


# JSON names of the fields of books a list can be sorted by, and their ORM names
_SORT_FIELDS_BOOK = {"id": "id", "title": "title", "isbn": "isbn", "authorId": "author_id", "genre": "genre", "pages": "pages", "published": "published", "available": "available"}


class BookService:
    """Rules of books."""

    @staticmethod
    def find(key: Any) -> Book:
        try:
            return Book.objects.get(pk=key)
        except (Book.DoesNotExist, ValueError, TypeError) as error:
            raise NotFoundError("book") from error

    @staticmethod
    def list_books(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[Book], int]:
        """List books: `sort` is a JSON field name, with a leading "-" for descending order."""
        query = Book.objects.filter(**filters)
        if sort:
            field = _SORT_FIELDS_BOOK[sort.lstrip("-")]
            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")
        total = query.count()
        items = query[offset : offset + limit] if limit is not None else query
        return list(items), total

    @staticmethod
    def get_book(key: Any) -> Book:
        """Get a book."""
        return BookService.find(key)

    @staticmethod
    def create_book(data: dict[str, Any]) -> Book:
        """Create a book."""
        return Book.objects.create(**data)

    @staticmethod
    def replace_book(key: Any, data: dict[str, Any]) -> Book:
        """Replace a book: every field the client may send takes the value of the body."""
        item = BookService.find(key)
        for field in ("title", "isbn", "author", "genre", "pages", "published", "available"):
            setattr(item, field, data.get(field))
        item.save()
        return item

    @staticmethod
    def update_book(key: Any, data: dict[str, Any]) -> Book:
        """Update part of a book: only the fields in the body change."""
        item = BookService.find(key)
        for field, value in data.items():
            setattr(item, field, value)
        item.save()
        return item

    @staticmethod
    def delete_book(key: Any) -> None:
        """Delete a book."""
        BookService.find(key).delete()
