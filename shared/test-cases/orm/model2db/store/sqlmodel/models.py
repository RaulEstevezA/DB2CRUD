"""SQLModel models written by Model2DB from Order. Review them before using them."""

import datetime
import enum
from typing import Optional

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Double, Enum, ForeignKey, Integer, Text
from sqlmodel import Field, Relationship, SQLModel


def enum_values(enum_class: type[enum.Enum]) -> list[str]:
    """Store the values of an enum (`paid`), not the names of its members (`PAID`)."""
    return [str(member.value) for member in enum_class]


class OrderStatus(enum.Enum):
    PENDING = "pending"
    PAID = "paid"
    SHIPPED = "shipped"
    CANCELLED = "cancelled"


class Customer(SQLModel, table=True):
    __tablename__ = "customers"

    id: int = Field(sa_column=Column(BigInteger, primary_key=True, autoincrement=False))
    name: str = Field(sa_column=Column(Text, nullable=False))
    email: str = Field(sa_column=Column(Text, nullable=False))
    password: str = Field(sa_column=Column(Text, nullable=False))
    phone: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    created_at: datetime.datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    address_street: str = Field(sa_column=Column(Text, nullable=False))
    address_city: str = Field(sa_column=Column(Text, nullable=False))
    address_postal_code: str = Field(sa_column=Column(Text, nullable=False))
    address_country: str = Field(sa_column=Column(Text, nullable=False))


class Product(SQLModel, table=True):
    __tablename__ = "products"

    id: int = Field(sa_column=Column(BigInteger, primary_key=True, autoincrement=False))
    sku: str = Field(sa_column=Column(Text, nullable=False))
    name: str = Field(sa_column=Column(Text, nullable=False))
    description: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    price: float = Field(sa_column=Column(Double, nullable=False))
    stock: int = Field(sa_column=Column(Integer, nullable=False))
    active: bool = Field(sa_column=Column(Boolean, nullable=False))


class OrderLine(SQLModel, table=True):
    __tablename__ = "order_lines"

    id: int | None = Field(default=None, sa_column=Column(BigInteger().with_variant(Integer(), "sqlite"), primary_key=True))
    quantity: int = Field(sa_column=Column(Integer, nullable=False))
    unit_price: float = Field(sa_column=Column(Double, nullable=False))
    product_id: int = Field(sa_column=Column(BigInteger, ForeignKey("products.id"), index=True, nullable=False))
    order_id: int = Field(sa_column=Column(BigInteger, ForeignKey("orders.id", ondelete="CASCADE"), index=True, nullable=False))

    product: Optional["Product"] = Relationship(sa_relationship_kwargs={"foreign_keys": "OrderLine.product_id"})
    order: Optional["Order"] = Relationship(back_populates="lines", sa_relationship_kwargs={"foreign_keys": "OrderLine.order_id"})


# TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
class Order(SQLModel, table=True):
    __tablename__ = "orders"

    id: int = Field(sa_column=Column(BigInteger, primary_key=True, autoincrement=False))
    status: OrderStatus = Field(sa_column=Column(Enum(OrderStatus, native_enum=False, create_constraint=True, length=20, name="ck_order_status", values_callable=enum_values), nullable=False))
    total: float = Field(sa_column=Column(Double, nullable=False))
    notes: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    created_at: datetime.datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    updated_at: datetime.datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    customer_id: int = Field(sa_column=Column(BigInteger, ForeignKey("customers.id"), index=True, nullable=False))

    lines: list["OrderLine"] = Relationship(back_populates="order", sa_relationship_kwargs={"foreign_keys": "OrderLine.order_id", "cascade": "all, delete-orphan"})
    customer: Optional["Customer"] = Relationship(sa_relationship_kwargs={"foreign_keys": "Order.customer_id"})
