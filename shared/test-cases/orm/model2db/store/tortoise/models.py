"""Tortoise ORM models written by Model2DB from Order. Register them as the "models" app.

Create the tables with Aerich (`aerich init-db`) or `Tortoise.generate_schemas()`. Review them before using them.
"""

import enum

from tortoise import fields
from tortoise.models import Model


class OrderStatus(str, enum.Enum):
    PENDING = "pending"
    PAID = "paid"
    SHIPPED = "shipped"
    CANCELLED = "cancelled"


class Customer(Model):
    id = fields.BigIntField(primary_key=True, generated=False)
    name = fields.TextField()
    email = fields.TextField()
    password = fields.TextField()
    phone = fields.TextField(null=True)
    created_at = fields.DatetimeField()
    address_street = fields.TextField()
    address_city = fields.TextField()
    address_postal_code = fields.TextField()
    address_country = fields.TextField()

    class Meta:
        table = "customers"


class Product(Model):
    id = fields.BigIntField(primary_key=True, generated=False)
    sku = fields.TextField()
    name = fields.TextField()
    description = fields.TextField(null=True)
    price = fields.FloatField()
    stock = fields.IntField()
    active = fields.BooleanField()

    class Meta:
        table = "products"


class OrderLine(Model):
    id = fields.BigIntField(primary_key=True)
    quantity = fields.IntField()
    unit_price = fields.FloatField()
    product = fields.ForeignKeyField("models.Product", related_name=False, on_delete=fields.RESTRICT, db_index=True)
    order = fields.ForeignKeyField("models.Order", related_name="lines", on_delete=fields.CASCADE, db_index=True)

    class Meta:
        table = "order_lines"


# TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
class Order(Model):
    id = fields.BigIntField(primary_key=True, generated=False)
    status = fields.CharEnumField(OrderStatus, max_length=20)
    total = fields.FloatField()
    notes = fields.TextField(null=True)
    created_at = fields.DatetimeField()
    updated_at = fields.DatetimeField()
    customer = fields.ForeignKeyField("models.Customer", related_name=False, on_delete=fields.RESTRICT, db_index=True)

    class Meta:
        table = "orders"
