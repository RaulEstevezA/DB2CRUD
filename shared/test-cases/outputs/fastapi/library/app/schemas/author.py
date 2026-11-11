"""Request and response schemas of authors."""

from datetime import date
from typing import ClassVar
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

from app.validators import ApiModel, ResponseModel


class AuthorCreate(ApiModel):
    """Body of a request that creates or replaces an author."""

    name: str = Field(..., min_length=2, max_length=120)
    email: EmailStr | None = None
    born: date | None = None


class AuthorUpdate(ApiModel):
    """Body of a request that changes part of an author: only the fields sent change."""

    name: str | None = Field(default=None, min_length=2, max_length=120)
    email: EmailStr | None = None
    born: date | None = None

    non_nullable: ClassVar[frozenset[str]] = frozenset({"name"})


class Author(ResponseModel):
    """An author as the API returns it."""

    id: UUID
    name: str = Field(..., min_length=2, max_length=120)
    email: EmailStr | None = None
    born: date | None = None


class AuthorPage(BaseModel):
    """One page of authors."""

    items: list[Author]
    total: int
    page: int
    size: int
