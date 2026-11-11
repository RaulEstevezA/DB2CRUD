"""Which repository and service each request uses. Change the implementations here."""

from fastapi import Depends, Request

from app.repositories.author import AuthorRepository
from app.repositories.book import BookRepository
from app.services.author import AuthorService
from app.services.book import BookService


def get_author_repository(request: Request) -> AuthorRepository:
    """The storage of authors."""
    return request.app.state.repositories["author"]


def get_author_service(
    repository: AuthorRepository = Depends(get_author_repository),
) -> AuthorService:
    """The service of authors, with the storage of the resources it refers to."""
    return AuthorService(repository)


def get_book_repository(request: Request) -> BookRepository:
    """The storage of books."""
    return request.app.state.repositories["book"]


def get_book_service(
    repository: BookRepository = Depends(get_book_repository),
    authors: AuthorRepository = Depends(get_author_repository),
) -> BookService:
    """The service of books, with the storage of the resources it refers to."""
    return BookService(repository, authors)
