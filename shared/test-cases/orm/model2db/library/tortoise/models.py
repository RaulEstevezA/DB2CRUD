"""Tortoise ORM models written by Model2DB from Book. Register them as the "models" app.

Create the tables with Aerich (`aerich init-db`) or `Tortoise.generate_schemas()`. Review them before using them.
"""

import enum

from tortoise import fields
from tortoise.models import Model


class Genre(str, enum.Enum):
    NOVEL = "novel"
    ESSAY = "essay"
    POETRY = "poetry"
    SCIENCE = "science"


class Author(Model):
    id = fields.UUIDField(primary_key=True)
    name = fields.CharField(max_length=120)
    email = fields.TextField(null=True)
    born = fields.DateField(null=True)

    class Meta:
        table = "authors"


# TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
class Book(Model):
    id = fields.UUIDField(primary_key=True)
    title = fields.CharField(max_length=200)
    isbn = fields.TextField()
    genre = fields.CharEnumField(Genre, max_length=20)
    pages = fields.IntField()
    published = fields.DateField(null=True)
    available = fields.BooleanField(default=True)
    author = fields.ForeignKeyField("models.Author", related_name=False, on_delete=fields.RESTRICT, db_index=True)

    class Meta:
        table = "books"
