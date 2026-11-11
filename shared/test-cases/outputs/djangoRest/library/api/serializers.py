"""Serializers of the API: requests in, responses out."""

from api.models import Author, Genre
from config.validation import StrictSerializer
from django.core.validators import RegexValidator
from rest_framework import serializers


class AuthorSerializer(StrictSerializer):
    """An author: what a request may send and what a response shows."""

    id = serializers.ReadOnlyField()
    name = serializers.CharField(trim_whitespace=False, min_length=2, max_length=120, required=True)
    email = serializers.EmailField(required=False, allow_null=True, default=None)
    born = serializers.DateField(required=False, allow_null=True, default=None)


class BookSerializer(StrictSerializer):
    """A book: what a request may send and what a response shows."""

    id = serializers.ReadOnlyField()
    title = serializers.CharField(trim_whitespace=False, min_length=1, max_length=200, required=True)
    isbn = serializers.CharField(trim_whitespace=False, allow_blank=True, validators=[RegexValidator("^[0-9]{13}$")], required=True)
    authorId = serializers.PrimaryKeyRelatedField(queryset=Author.objects.all(), source="author", required=True)
    genre = serializers.ChoiceField(choices=Genre.choices, required=True)
    pages = serializers.IntegerField(min_value=1, max_value=5000, required=True)
    published = serializers.DateField(required=False, allow_null=True, default=None)
    available = serializers.BooleanField(required=False, default=True)
