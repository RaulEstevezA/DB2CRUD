"""Models of the API and their enums."""

from django.core.serializers.json import DjangoJSONEncoder
from django.db import models


class OrderStatus(models.TextChoices):
    """Values of OrderStatus."""

    PENDING = "pending", "pending"
    PAID = "paid", "paid"
    SHIPPED = "shipped", "shipped"
    CANCELLED = "cancelled", "cancelled"


class Customer(models.Model):
    """A stored customer."""

    id = models.BigAutoField(primary_key=True)
    name = models.TextField()
    email = models.TextField()
    password = models.TextField()
    phone = models.TextField(null=True, blank=True)
    address = models.JSONField(encoder=DjangoJSONEncoder)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "customers"
        ordering = ["id"]


class Product(models.Model):
    """A stored product."""

    id = models.BigAutoField(primary_key=True)
    sku = models.TextField()
    name = models.TextField()
    description = models.TextField(null=True, blank=True)
    price = models.FloatField()
    stock = models.FloatField()
    active = models.BooleanField()

    class Meta:
        db_table = "products"
        ordering = ["id"]


class Order(models.Model):
    """A stored order."""

    id = models.BigAutoField(primary_key=True)
    customer = models.ForeignKey("api.Customer", on_delete=models.PROTECT, related_name="+")
    lines = models.JSONField(encoder=DjangoJSONEncoder)
    status = models.CharField(max_length=9, choices=OrderStatus.choices)
    total = models.FloatField()
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "orders"
        ordering = ["id"]
