"""A shop app written by hand: tables named by Django (shop_<model>), an abstract base, the implicit id, relations of
every kind and Meta options."""

import uuid

from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.db.models.functions import Now


class Size(models.IntegerChoices):
    SMALL = 1, "Small"
    MEDIUM = 2, "Medium"
    LARGE = 3, "Large"


class Timestamped(models.Model):
    created = models.DateTimeField(auto_now_add=True)
    modified = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Category(models.Model):
    slug = models.SlugField(unique=True)
    name = models.CharField(max_length=80, db_comment="Shown in the menu")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="children")

    class Meta:
        verbose_name_plural = "categories"


class Product(Timestamped):
    code = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    title = models.CharField("title", max_length=200)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    size = models.PositiveSmallIntegerField(choices=Size.choices, default=Size.MEDIUM)
    color = models.CharField(max_length=10, choices=[("red", "Red"), ("blue", "Blue")], blank=True, db_default="red")
    stock = models.IntegerField(db_default=0)
    tags = ArrayField(models.CharField(max_length=30), default=list)
    category = models.ForeignKey(Category, on_delete=models.PROTECT, db_column="category_code", to_field="slug")
    related = models.ManyToManyField("self", blank=True)
    total = models.GeneratedField(
        expression=models.F("price") * 2, output_field=models.DecimalField(max_digits=12, decimal_places=2), db_persist=True
    )
    published_at = models.DateTimeField(null=True, db_default=Now())

    class Meta:
        db_table = "products"
        unique_together = ("title", "category")
        indexes = [models.Index(fields=["-published_at", "category"], name="ix_products_recent")]
        constraints = [
            models.CheckConstraint(condition=models.Q(price__gte=0), name="ck_products_price"),
            models.CheckConstraint(condition=models.Q(price__lt=models.F("total")), name="ck_products_total"),
        ]


class Customer(models.Model):
    email = models.EmailField(unique=True)
    favourites = models.ManyToManyField(Product, related_name="fans")


class Profile(models.Model):
    customer = models.OneToOneField(Customer, on_delete=models.CASCADE, primary_key=True)
    bio = models.TextField(blank=True, default="")


class Order(Timestamped):
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name="orders", db_index=False)
    items = models.ManyToManyField(Product, through="OrderItem")


class OrderItem(models.Model):
    pk = models.CompositePrimaryKey("order", "line")
    order = models.ForeignKey(Order, on_delete=models.CASCADE)
    line = models.SmallIntegerField()
    product = models.ForeignKey(Product, on_delete=models.RESTRICT, related_name="+")
    quantity = models.PositiveIntegerField(default=1)


class ProxyProduct(Product):
    class Meta:
        proxy = True
