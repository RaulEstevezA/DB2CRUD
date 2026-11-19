"""Django models written by Model2DB from Item. Review them before using them."""

from django.db import models


class Category(models.Model):
    id = models.BigAutoField(primary_key=True)
    name = models.CharField(max_length=80)
    parent = models.ForeignKey("Category", on_delete=models.PROTECT, related_name="+")

    class Meta:
        db_table = "categories"


class Item(models.Model):
    id = models.BigAutoField(primary_key=True)
    name = models.CharField(max_length=120)
    price = models.DecimalField(max_digits=18, decimal_places=2)
    supplier_email = models.CharField(max_length=255)
    stock = models.IntegerField()
    category = models.ForeignKey("Category", on_delete=models.PROTECT, related_name="+")

    class Meta:
        db_table = "items"
