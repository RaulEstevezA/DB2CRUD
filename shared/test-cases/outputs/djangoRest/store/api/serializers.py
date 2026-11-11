"""Serializers of the API: requests in, responses out."""

from api.models import Customer, OrderStatus
from config.validation import StrictSerializer
from rest_framework import serializers


class AddressSerializer(StrictSerializer):
    """Address, embedded in the resources that hold it."""

    street = serializers.CharField(trim_whitespace=False, allow_blank=True, required=True)
    city = serializers.CharField(trim_whitespace=False, allow_blank=True, required=True)
    postalCode = serializers.CharField(trim_whitespace=False, allow_blank=True, required=True)
    country = serializers.CharField(trim_whitespace=False, allow_blank=True, required=True)


class OrderLineSerializer(StrictSerializer):
    """OrderLine, embedded in the resources that hold it."""

    productId = serializers.IntegerField(required=True)
    quantity = serializers.FloatField(required=True)
    unitPrice = serializers.FloatField(required=True)


class CustomerSerializer(StrictSerializer):
    """A customer: what a request may send and what a response shows."""

    id = serializers.ReadOnlyField()
    name = serializers.CharField(trim_whitespace=False, allow_blank=True, required=True)
    email = serializers.CharField(trim_whitespace=False, allow_blank=True, required=True)
    password = serializers.CharField(trim_whitespace=False, allow_blank=True, write_only=True, required=True)
    phone = serializers.CharField(trim_whitespace=False, allow_blank=True, required=False)
    address = AddressSerializer(required=True)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)


class ProductSerializer(StrictSerializer):
    """A product: what a request may send and what a response shows."""

    id = serializers.ReadOnlyField()
    sku = serializers.CharField(trim_whitespace=False, allow_blank=True, required=True)
    name = serializers.CharField(trim_whitespace=False, allow_blank=True, required=True)
    description = serializers.CharField(trim_whitespace=False, allow_blank=True, required=False)
    price = serializers.FloatField(required=True)
    stock = serializers.FloatField(required=True)
    active = serializers.BooleanField(required=True)


class OrderSerializer(StrictSerializer):
    """An order: what a request may send and what a response shows."""

    id = serializers.ReadOnlyField()
    customerId = serializers.PrimaryKeyRelatedField(queryset=Customer.objects.all(), source="customer", required=True)
    lines = OrderLineSerializer(many=True, required=True)
    status = serializers.ChoiceField(choices=OrderStatus.choices, required=True)
    total = serializers.FloatField(required=True)
    notes = serializers.CharField(trim_whitespace=False, allow_blank=True, required=False, allow_null=True)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)
    updatedAt = serializers.DateTimeField(source="updated_at", read_only=True)
