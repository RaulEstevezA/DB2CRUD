"""Rules of each resource: what each operation checks and changes."""

from typing import Any

from api.models import Customer, Order, Product
from config.errors import NotFoundError, require as _require


# JSON names of the fields of customers a list can be sorted by, and their ORM names
_SORT_FIELDS_CUSTOMER = {"id": "id", "name": "name", "email": "email", "password": "password", "phone": "phone", "address": "address", "createdAt": "created_at"}


class CustomerService:
    """Rules of customers."""

    @staticmethod
    def find(key: Any) -> Customer:
        try:
            return Customer.objects.get(pk=key)
        except (Customer.DoesNotExist, ValueError, TypeError) as error:
            raise NotFoundError("customer") from error

    @staticmethod
    def list_customers(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[Customer], int]:
        """List customers: `sort` is a JSON field name, with a leading "-" for descending order."""
        query = Customer.objects.filter(**filters)
        if sort:
            field = _SORT_FIELDS_CUSTOMER[sort.lstrip("-")]
            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")
        total = query.count()
        items = query[offset : offset + limit] if limit is not None else query
        return list(items), total

    @staticmethod
    def get_customer(key: Any) -> Customer:
        """Get a customer."""
        return CustomerService.find(key)

    @staticmethod
    def create_customer(data: dict[str, Any]) -> Customer:
        """Create a customer."""
        return Customer.objects.create(**data)

    @staticmethod
    def replace_customer(key: Any, data: dict[str, Any]) -> Customer:
        """Replace a customer: every field the client may send takes the value of the body."""
        item = CustomerService.find(key)
        for field in ("name", "email", "password", "phone", "address"):
            setattr(item, field, data.get(field))
        item.save()
        return item

    @staticmethod
    def update_customer(key: Any, data: dict[str, Any]) -> Customer:
        """Update part of a customer: only the fields in the body change."""
        item = CustomerService.find(key)
        for field, value in data.items():
            setattr(item, field, value)
        item.save()
        return item

    @staticmethod
    def delete_customer(key: Any) -> None:
        """Delete a customer."""
        CustomerService.find(key).delete()


# JSON names of the fields of products a list can be sorted by, and their ORM names
_SORT_FIELDS_PRODUCT = {"id": "id", "sku": "sku", "name": "name", "description": "description", "price": "price", "stock": "stock", "active": "active"}


class ProductService:
    """Rules of products."""

    @staticmethod
    def find(key: Any) -> Product:
        try:
            return Product.objects.get(pk=key)
        except (Product.DoesNotExist, ValueError, TypeError) as error:
            raise NotFoundError("product") from error

    @staticmethod
    def list_products(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[Product], int]:
        """List products: `sort` is a JSON field name, with a leading "-" for descending order."""
        query = Product.objects.filter(**filters)
        if sort:
            field = _SORT_FIELDS_PRODUCT[sort.lstrip("-")]
            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")
        total = query.count()
        items = query[offset : offset + limit] if limit is not None else query
        return list(items), total

    @staticmethod
    def get_product(key: Any) -> Product:
        """Get a product."""
        return ProductService.find(key)

    @staticmethod
    def create_product(data: dict[str, Any]) -> Product:
        """Create a product."""
        return Product.objects.create(**data)

    @staticmethod
    def replace_product(key: Any, data: dict[str, Any]) -> Product:
        """Replace a product: every field the client may send takes the value of the body."""
        item = ProductService.find(key)
        for field in ("sku", "name", "description", "price", "stock", "active"):
            setattr(item, field, data.get(field))
        item.save()
        return item

    @staticmethod
    def update_product(key: Any, data: dict[str, Any]) -> Product:
        """Update part of a product: only the fields in the body change."""
        item = ProductService.find(key)
        for field, value in data.items():
            setattr(item, field, value)
        item.save()
        return item

    @staticmethod
    def delete_product(key: Any) -> None:
        """Delete a product."""
        ProductService.find(key).delete()


# JSON names of the fields of orders a list can be sorted by, and their ORM names
_SORT_FIELDS_ORDER = {"id": "id", "customerId": "customer_id", "lines": "lines", "status": "status", "total": "total", "notes": "notes", "createdAt": "created_at", "updatedAt": "updated_at"}


class OrderService:
    """Rules of orders."""

    @staticmethod
    def find(key: Any) -> Order:
        try:
            return Order.objects.get(pk=key)
        except (Order.DoesNotExist, ValueError, TypeError) as error:
            raise NotFoundError("order") from error

    @staticmethod
    def check_references(data: dict[str, Any]) -> None:
        for item0 in data.get("lines") or []:
            _require(Product, item0.get("productId"), "lines.productId")

    @staticmethod
    def list_orders(filters: dict[str, Any], sort: str | None, offset: int, limit: int | None) -> tuple[list[Order], int]:
        """List orders: `sort` is a JSON field name, with a leading "-" for descending order."""
        query = Order.objects.filter(**filters)
        if sort:
            field = _SORT_FIELDS_ORDER[sort.lstrip("-")]
            query = query.order_by(("-" if sort.startswith("-") else "") + field, "pk")
        total = query.count()
        items = query[offset : offset + limit] if limit is not None else query
        return list(items), total

    @staticmethod
    def get_order(key: Any) -> Order:
        """Get an order."""
        return OrderService.find(key)

    @staticmethod
    def create_order(data: dict[str, Any]) -> Order:
        """Create an order."""
        OrderService.check_references(data)
        return Order.objects.create(**data)

    @staticmethod
    def replace_order(key: Any, data: dict[str, Any]) -> Order:
        """Replace an order: every field the client may send takes the value of the body."""
        item = OrderService.find(key)
        OrderService.check_references(data)
        for field in ("customer", "lines", "status", "total", "notes"):
            setattr(item, field, data.get(field))
        item.save()
        return item

    @staticmethod
    def update_order(key: Any, data: dict[str, Any]) -> Order:
        """Update part of an order: only the fields in the body change."""
        item = OrderService.find(key)
        OrderService.check_references(data)
        for field, value in data.items():
            setattr(item, field, value)
        item.save()
        return item

    @staticmethod
    def delete_order(key: Any) -> None:
        """Delete an order."""
        OrderService.find(key).delete()
