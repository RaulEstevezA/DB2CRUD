"""Beanie documents written by Model2DB from User. Pass the Document classes to init_beanie(). Review them before using them."""

import datetime

from beanie import Document
from pydantic import BaseModel, Field
from pymongo import ASCENDING, IndexModel


class Profile(BaseModel):
    bio: str | None = Field(default=None)
    website: str | None = Field(default=None)


class Comment(BaseModel):
    text: str
    writtenAt: datetime.datetime = Field(alias="written_at")
    rating: int | None = Field(default=None)


class User(Document):
    id: str = Field(alias="_id")
    email: str
    name: str | None = Field(default=None)
    profile: "Profile | None" = Field(default=None)
    createdAt: datetime.datetime | None = Field(default=None, alias="created_at")

    class Settings:
        name = "users"
        indexes = [IndexModel([("email", ASCENDING)], name="uq_users_email", unique=True)]


class Post(Document):
    id: int = Field(alias="_id")
    title: str
    body: str
    published: bool | None = Field(default=None)
    authorId: str = Field(alias="author_id")
    comments: "list[Comment]" = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

    class Settings:
        name = "posts"
        indexes = [IndexModel([("author_id", ASCENDING)], name="ix_posts_author_id")]
