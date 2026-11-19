"""SQLAlchemy models written by Model2DB from Book. Review them before using them."""

from __future__ import annotations

import datetime
import enum
import uuid

from sqlalchemy import Boolean, Date, Enum, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def enum_values(enum_class: type[enum.Enum]) -> list[str]:
    """Store the values of an enum (`paid`), not the names of its members (`PAID`)."""
    return [str(member.value) for member in enum_class]


class Genre(enum.Enum):
    NOVEL = "novel"
    ESSAY = "essay"
    POETRY = "poetry"
    SCIENCE = "science"


class Base(DeclarativeBase):
    pass


class Author(Base):
    __tablename__ = "authors"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str | None] = mapped_column(Text)
    born: Mapped[datetime.date | None] = mapped_column(Date)


# TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
class Book(Base):
    __tablename__ = "books"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    isbn: Mapped[str] = mapped_column(Text)
    genre: Mapped[Genre] = mapped_column(Enum(Genre, native_enum=False, create_constraint=True, length=20, name="ck_genre", values_callable=enum_values))
    pages: Mapped[int] = mapped_column(Integer)
    published: Mapped[datetime.date | None] = mapped_column(Date)
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    author_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("authors.id"), index=True)

    author: Mapped[Author] = relationship(foreign_keys="Book.author_id")
