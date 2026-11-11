"""URLs of the api app."""

from django.urls import path

from api.views import GetAuthorView, GetBookView, ListAuthorsView, ListBooksView

urlpatterns = [
    path("authors", ListAuthorsView.as_view()),
    path("authors/<uuid:id>", GetAuthorView.as_view()),
    path("books", ListBooksView.as_view()),
    path("books/<uuid:id>", GetBookView.as_view()),
]
