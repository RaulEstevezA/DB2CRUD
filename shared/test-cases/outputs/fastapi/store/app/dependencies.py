"""Which repository and service each request uses. Change the implementations here."""

from fastapi import Depends, Request

from app.repositories.customer import CustomerRepository
from app.repositories.order import OrderRepository
from app.repositories.product import ProductRepository
from app.services.customer import CustomerService
from app.services.order import OrderService
from app.services.product import ProductService


def get_customer_repository(request: Request) -> CustomerRepository:
    """The storage of customers."""
    return request.app.state.repositories["customer"]


def get_customer_service(
    repository: CustomerRepository = Depends(get_customer_repository),
) -> CustomerService:
    """The service of customers, with the storage of the resources it refers to."""
    return CustomerService(repository)


def get_product_repository(request: Request) -> ProductRepository:
    """The storage of products."""
    return request.app.state.repositories["product"]


def get_product_service(
    repository: ProductRepository = Depends(get_product_repository),
) -> ProductService:
    """The service of products, with the storage of the resources it refers to."""
    return ProductService(repository)


def get_order_repository(request: Request) -> OrderRepository:
    """The storage of orders."""
    return request.app.state.repositories["order"]


def get_order_service(
    repository: OrderRepository = Depends(get_order_repository),
    customers: CustomerRepository = Depends(get_customer_repository),
    products: ProductRepository = Depends(get_product_repository),
) -> OrderService:
    """The service of orders, with the storage of the resources it refers to."""
    return OrderService(repository, customers, products)
