"""SQLModel models written by Model2DB from Book. Review them before using them."""

import datetime
import enum
import uuid
from typing import Optional

from sqlalchemy import Boolean, Column, Date, Enum, ForeignKey, Integer, String, Text, Uuid
from sqlmodel import Field, Relationship, SQLModel


def enum_values(enum_class: type[enum.Enum]) -> list[str]:
    """Store the values of an enum (`paid`), not the names of its members (`PAID`)."""
    return [str(member.value) for member in enum_class]


class Genre(enum.Enum):
    NOVEL = "novel"
    ESSAY = "essay"
    POETRY = "poetry"
    SCIENCE = "science"


class Author(SQLModel, table=True):
    __tablename__ = "authors"

    id: uuid.UUID = Field(sa_column=Column(Uuid, primary_key=True))
    name: str = Field(sa_column=Column(String(120), nullable=False))
    email: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    born: datetime.date | None = Field(default=None, sa_column=Column(Date, nullable=True))


# TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
class Book(SQLModel, table=True):
    __tablename__ = "books"

    id: uuid.UUID = Field(sa_column=Column(Uuid, primary_key=True))
    title: str = Field(sa_column=Column(String(200), nullable=False))
    isbn: str = Field(sa_column=Column(Text, nullable=False))
    genre: Genre = Field(sa_column=Column(Enum(Genre, native_enum=False, create_constraint=True, length=20, name="ck_genre", values_callable=enum_values), nullable=False))
    pages: int = Field(sa_column=Column(Integer, nullable=False))
    published: datetime.date | None = Field(default=None, sa_column=Column(Date, nullable=True))
    available: bool = Field(default=True, sa_column=Column(Boolean, default=True, nullable=False))
    author_id: uuid.UUID = Field(sa_column=Column(Uuid, ForeignKey("authors.id"), index=True, nullable=False))

    author: Optional["Author"] = Relationship(sa_relationship_kwargs={"foreign_keys": "Book.author_id"})
