"""Beanie documents written by Model2DB from Author. Pass the Document classes to init_beanie(). Review them before using them."""

import datetime
import decimal
import enum

from beanie import Document, Link
from pydantic import BaseModel, Field
from pymongo import ASCENDING, IndexModel


class Genre(str, enum.Enum):
    FICTION = "FICTION"
    ESSAY = "ESSAY"
    POETRY = "POETRY"
    SCIENCE = "SCIENCE"


class Shelf(BaseModel):
    room: str
    row: int | None = Field(default=None)


class Tag(BaseModel):
    code: str
    label: str


class Author(Document):
    id: int = Field(alias="_id")
    name: str
    email: str

    class Settings:
        name = "authors"
        indexes = [IndexModel([("email", ASCENDING)], name="uq_authors_email", unique=True)]


# TODO: does the application read "Book" by author, ordered by publishedOn desc? Accept the query in the design to index it.
class Book(Document):
    id: int = Field(alias="_id")
    isbn: str
    title: str
    author: "Link[Author]"
    price: decimal.Decimal
    publishedOn: datetime.datetime = Field(alias="published_on")
    genre: Genre
    shelf: "Shelf"
    tags: "list[Tag]" = Field(default_factory=list)

    class Settings:
        name = "books"
        indexes = [IndexModel([("isbn", ASCENDING)], name="uq_books_isbn", unique=True), IndexModel([("author", ASCENDING)], name="ix_books_author")]
