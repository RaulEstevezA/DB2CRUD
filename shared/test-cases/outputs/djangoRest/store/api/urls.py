"""URLs of the api app."""

from django.urls import path

from api.views import GetCustomerView, GetOrderView, GetProductView, ListCustomersView, ListOrdersView, ListProductsView

urlpatterns = [
    path("customers", ListCustomersView.as_view()),
    path("customers/<int:id>", GetCustomerView.as_view()),
    path("products", ListProductsView.as_view()),
    path("products/<int:id>", GetProductView.as_view()),
    path("orders", ListOrdersView.as_view()),
    path("orders/<int:id>", GetOrderView.as_view()),
]
