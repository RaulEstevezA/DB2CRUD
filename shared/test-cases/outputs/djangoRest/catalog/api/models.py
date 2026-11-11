"""Models of the API and their enums."""

from django.db import models


class Category(models.Model):
    """A stored category."""

    id = models.BigAutoField(primary_key=True)
    name = models.CharField(max_length=80)
    parent = models.ForeignKey("self", on_delete=models.PROTECT, related_name="+", null=True, blank=True)

    class Meta:
        db_table = "categories"
        ordering = ["id"]


class Item(models.Model):
    """A stored item."""

    id = models.BigAutoField(primary_key=True)
    name = models.CharField(max_length=120)
    price = models.DecimalField(max_digits=18, decimal_places=4)
    supplier_email = models.TextField()
    category = models.ForeignKey("api.Category", on_delete=models.PROTECT, related_name="+")
    stock = models.IntegerField()

    class Meta:
        db_table = "items"
        ordering = ["id"]
