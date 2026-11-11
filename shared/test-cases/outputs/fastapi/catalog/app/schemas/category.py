"""Request and response schemas of categories."""

from typing import ClassVar

from pydantic import BaseModel, Field

from app.validators import ApiModel, ResponseModel


class CategoryCreate(ApiModel):
    """Body of a request that creates or replaces a category."""

    name: str = Field(..., min_length=1, max_length=80)
    parent_id: int | None = Field(default=None, alias="parentId")


class CategoryUpdate(ApiModel):
    """Body of a request that changes part of a category: only the fields sent change."""

    name: str | None = Field(default=None, min_length=1, max_length=80)
    parent_id: int | None = Field(default=None, alias="parentId")

    non_nullable: ClassVar[frozenset[str]] = frozenset({"name"})


class Category(ResponseModel):
    """A category as the API returns it."""

    id: int
    name: str = Field(..., min_length=1, max_length=80)
    parent_id: int | None = Field(default=None, alias="parentId")


class CategoryPage(BaseModel):
    """One page of categories."""

    items: list[Category]
    total: int
    page: int
    size: int
