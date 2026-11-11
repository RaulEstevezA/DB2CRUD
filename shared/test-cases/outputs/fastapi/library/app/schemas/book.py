"""Request and response schemas of books."""

from datetime import date
from typing import ClassVar
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.common import Genre
from app.validators import ApiModel, ResponseModel


class BookCreate(ApiModel):
    """Body of a request that creates or replaces a book."""

    title: str = Field(..., min_length=1, max_length=200)
    isbn: str = Field(..., pattern="^[0-9]{13}$")
    author_id: UUID = Field(..., alias="authorId")
    genre: Genre
    pages: int = Field(..., ge=1, le=5000)
    published: date | None = None
    available: bool | None = True

    non_nullable: ClassVar[frozenset[str]] = frozenset({"available"})


class BookUpdate(ApiModel):
    """Body of a request that changes part of a book: only the fields sent change."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    isbn: str | None = Field(default=None, pattern="^[0-9]{13}$")
    author_id: UUID | None = Field(default=None, alias="authorId")
    genre: Genre | None = None
    pages: int | None = Field(default=None, ge=1, le=5000)
    published: date | None = None
    available: bool | None = None

    non_nullable: ClassVar[frozenset[str]] = frozenset({"title", "isbn", "author_id", "genre", "pages", "available"})


class Book(ResponseModel):
    """A book as the API returns it."""

    id: UUID
    title: str = Field(..., min_length=1, max_length=200)
    isbn: str = Field(..., pattern="^[0-9]{13}$")
    author_id: UUID = Field(..., alias="authorId")
    genre: Genre
    pages: int = Field(..., ge=1, le=5000)
    published: date | None = None
    available: bool


class BookPage(BaseModel):
    """One page of books."""

    items: list[Book]
    total: int
    page: int
    size: int
