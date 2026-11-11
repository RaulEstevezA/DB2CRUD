"""URLs of the API: the routes of every app."""

from django.urls import include, path

urlpatterns = [
    path("", include("api.urls")),
]

handler404 = "config.errors.not_found"
