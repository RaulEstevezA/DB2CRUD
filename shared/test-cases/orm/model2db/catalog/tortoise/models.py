"""Tortoise ORM models written by Model2DB from Item. Register them as the "models" app.

Create the tables with Aerich (`aerich init-db`) or `Tortoise.generate_schemas()`. Review them before using them.
"""

from tortoise import fields
from tortoise.models import Model


class Category(Model):
    id = fields.BigIntField(primary_key=True)
    name = fields.CharField(max_length=80)
    parent = fields.ForeignKeyField("models.Category", related_name=False, on_delete=fields.RESTRICT, db_index=True)

    class Meta:
        table = "categories"


class Item(Model):
    id = fields.BigIntField(primary_key=True)
    name = fields.CharField(max_length=120)
    price = fields.DecimalField(max_digits=18, decimal_places=2)
    supplier_email = fields.CharField(max_length=255)
    stock = fields.IntField()
    category = fields.ForeignKeyField("models.Category", related_name=False, on_delete=fields.RESTRICT, db_index=True)

    class Meta:
        table = "items"
