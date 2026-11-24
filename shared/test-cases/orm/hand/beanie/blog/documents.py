"""Documents of a blog, with the ways Beanie has to declare them."""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import Enum, IntEnum
from typing import Annotated, Any, ClassVar, List, Literal, Optional, Union

import pymongo
from beanie import BackLink, Document, Indexed, Link, PydanticObjectId
from pydantic import BaseModel, EmailStr, Field, NonNegativeInt
from pymongo import IndexModel


class Status(str, Enum):
    DRAFT = "draft"
    PUBLISHED = "published"


class Priority(IntEnum):
    LOW = 1
    HIGH = 2


class Dated(Document):
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC), alias="createdAt")
    token: uuid.UUID = Field(default_factory=uuid.uuid4)


class Comment(BaseModel):
    id: PydanticObjectId = Field(default_factory=PydanticObjectId, alias="_id")
    text: Annotated[str, Field(min_length=1, max_length=500)]
    stars: Optional[int] = Field(default=None, ge=1, le=5)
    answers: "list[Comment]" = []


class Seo(BaseModel):
    description: str | None = None
    keywords: set[str] = Field(default_factory=set, alias="key words")


class Author(Document):
    id: int
    name: str
    email: Annotated[EmailStr, Indexed(unique=True)]
    posts: List[BackLink["Post"]] = Field(json_schema_extra={"original_field": "author"})


class Post(Dated):
    LIMIT: ClassVar[int] = 3
    title: Indexed(str, pymongo.TEXT) = Field(max_length=80)
    section: str = "main"
    slug: str
    status: Status = Status.DRAFT
    kind: Literal["note", "essay"]
    priority: Priority = Priority.LOW
    views: NonNegativeInt = 0
    ratio: float | None = Field(None, gt=0, lt=1000)
    price: Decimal
    day: date
    author: Link[Author]
    reviewers: Optional[list[Link[Author]]] = None
    related: list[PydanticObjectId] = Field(default_factory=list)
    comments: list[Comment] = Field(default_factory=list)
    seo: Union[Seo, None] = None
    extra: dict[str, Any] = {}
    cover: Optional[bytes] = None
    either: Union[int, str] = 1
    _cached: str = ""

    class Settings:
        name = "posts"
        indexes = [
            "day",
            [("section", pymongo.ASCENDING), ("slug", pymongo.DESCENDING)],
            IndexModel([("slug", 1)], name="ux_slug", unique=True),
            IndexModel("comments.text"),
        ]


class Animal(Document):
    name: str

    class Settings:
        is_root = True


class Cat(Animal):
    lives: int
