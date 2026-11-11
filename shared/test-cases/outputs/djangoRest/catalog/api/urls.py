"""URLs of the api app."""

from django.urls import path

from api.views import GetCategoryView, GetItemView, ListCategoriesView, ListItemsView

urlpatterns = [
    path("categories", ListCategoriesView.as_view()),
    path("categories/<int:id>", GetCategoryView.as_view()),
    path("items", ListItemsView.as_view()),
    path("items/<int:id>", GetItemView.as_view()),
]
