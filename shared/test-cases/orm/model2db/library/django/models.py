"""Django models written by Model2DB from Book. Review them before using them."""

from django.db import models


class Genre(models.TextChoices):
    NOVEL = "novel", "NOVEL"
    ESSAY = "essay", "ESSAY"
    POETRY = "poetry", "POETRY"
    SCIENCE = "science", "SCIENCE"


class Author(models.Model):
    id = models.UUIDField(primary_key=True)
    name = models.CharField(max_length=120)
    email = models.TextField(null=True, blank=True)
    born = models.DateField(null=True, blank=True)

    class Meta:
        db_table = "authors"


# TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
class Book(models.Model):
    id = models.UUIDField(primary_key=True)
    title = models.CharField(max_length=200)
    isbn = models.TextField()
    genre = models.CharField(max_length=20, choices=Genre.choices)
    pages = models.IntegerField()
    published = models.DateField(null=True, blank=True)
    available = models.BooleanField(default=True)
    author = models.ForeignKey("Author", on_delete=models.PROTECT, related_name="+")

    class Meta:
        db_table = "books"
        constraints = [models.CheckConstraint(condition=models.Q(genre__in=["novel", "essay", "poetry", "science"]), name="ck_books_genre")]
