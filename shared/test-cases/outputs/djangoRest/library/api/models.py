"""Models of the API and their enums."""

import uuid

from django.db import models


class Genre(models.TextChoices):
    """Values of Genre."""

    NOVEL = "novel", "novel"
    ESSAY = "essay", "essay"
    POETRY = "poetry", "poetry"
    SCIENCE = "science", "science"


class Author(models.Model):
    """A stored author."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    email = models.TextField(null=True, blank=True)
    born = models.DateField(null=True, blank=True)

    class Meta:
        db_table = "authors"
        ordering = ["id"]


class Book(models.Model):
    """A stored book."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=200)
    isbn = models.TextField()
    author = models.ForeignKey("api.Author", on_delete=models.PROTECT, related_name="+")
    genre = models.CharField(max_length=7, choices=Genre.choices)
    pages = models.IntegerField()
    published = models.DateField(null=True, blank=True)
    available = models.BooleanField(null=True, blank=True, default=True)

    class Meta:
        db_table = "books"
        ordering = ["id"]
