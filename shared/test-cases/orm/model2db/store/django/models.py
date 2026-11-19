"""Django models written by Model2DB from Order. Review them before using them."""

from django.db import models


class OrderStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    PAID = "paid", "Paid"
    SHIPPED = "shipped", "Shipped"
    CANCELLED = "cancelled", "Cancelled"


class Customer(models.Model):
    id = models.BigIntegerField(primary_key=True)
    name = models.TextField()
    email = models.TextField()
    password = models.TextField()
    phone = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField()
    address_street = models.TextField()
    address_city = models.TextField()
    address_postal_code = models.TextField()
    address_country = models.TextField()

    class Meta:
        db_table = "customers"


class Product(models.Model):
    id = models.BigIntegerField(primary_key=True)
    sku = models.TextField()
    name = models.TextField()
    description = models.TextField(null=True, blank=True)
    price = models.FloatField()
    stock = models.IntegerField()
    active = models.BooleanField()

    class Meta:
        db_table = "products"


class OrderLine(models.Model):
    id = models.BigAutoField(primary_key=True)
    quantity = models.IntegerField()
    unit_price = models.FloatField()
    product = models.ForeignKey("Product", on_delete=models.PROTECT, related_name="+")
    order = models.ForeignKey("Order", on_delete=models.CASCADE, related_name="lines")

    class Meta:
        db_table = "order_lines"


# TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
class Order(models.Model):
    id = models.BigIntegerField(primary_key=True)
    status = models.CharField(max_length=20, choices=OrderStatus.choices)
    total = models.FloatField()
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    customer = models.ForeignKey("Customer", on_delete=models.PROTECT, related_name="+")

    class Meta:
        db_table = "orders"
        constraints = [models.CheckConstraint(condition=models.Q(status__in=["pending", "paid", "shipped", "cancelled"]), name="ck_orders_status")]
