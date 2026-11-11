"""Serializers of the API: requests in, responses out."""

from api.models import Category
from config.validation import StrictSerializer
from rest_framework import serializers


class CategorySerializer(StrictSerializer):
    """A category: what a request may send and what a response shows."""

    id = serializers.ReadOnlyField()
    name = serializers.CharField(trim_whitespace=False, min_length=1, max_length=80, required=True)
    parentId = serializers.PrimaryKeyRelatedField(queryset=Category.objects.all(), source="parent", required=False, allow_null=True)


class ItemSerializer(StrictSerializer):
    """An item: what a request may send and what a response shows."""

    id = serializers.ReadOnlyField()
    name = serializers.CharField(trim_whitespace=False, min_length=3, max_length=120, required=True)
    price = serializers.DecimalField(max_digits=18, decimal_places=4, coerce_to_string=False, min_value=0, required=True)
    supplierEmail = serializers.EmailField(source="supplier_email", required=True)
    categoryId = serializers.PrimaryKeyRelatedField(queryset=Category.objects.all(), source="category", required=True)
    stock = serializers.IntegerField(min_value=0, required=True)
