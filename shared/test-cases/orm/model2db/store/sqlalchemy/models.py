"""SQLAlchemy models written by Model2DB from Order. Review them before using them."""

from __future__ import annotations

import datetime
import enum

from sqlalchemy import BigInteger, Boolean, DateTime, Double, Enum, ForeignKey, Integer, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def enum_values(enum_class: type[enum.Enum]) -> list[str]:
    """Store the values of an enum (`paid`), not the names of its members (`PAID`)."""
    return [str(member.value) for member in enum_class]


class OrderStatus(enum.Enum):
    PENDING = "pending"
    PAID = "paid"
    SHIPPED = "shipped"
    CANCELLED = "cancelled"


class Base(DeclarativeBase):
    pass


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    name: Mapped[str] = mapped_column(Text)
    email: Mapped[str] = mapped_column(Text)
    password: Mapped[str] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True))
    address_street: Mapped[str] = mapped_column(Text)
    address_city: Mapped[str] = mapped_column(Text)
    address_postal_code: Mapped[str] = mapped_column(Text)
    address_country: Mapped[str] = mapped_column(Text)


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    sku: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    price: Mapped[float] = mapped_column(Double)
    stock: Mapped[int] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean)


class OrderLine(Base):
    __tablename__ = "order_lines"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer(), "sqlite"), primary_key=True)
    quantity: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[float] = mapped_column(Double)
    product_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("products.id"), index=True)
    order_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("orders.id", ondelete="CASCADE"), index=True)

    product: Mapped[Product] = relationship(foreign_keys="OrderLine.product_id")
    order: Mapped[Order] = relationship(back_populates="lines", foreign_keys="OrderLine.order_id")


# TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    status: Mapped[OrderStatus] = mapped_column(Enum(OrderStatus, native_enum=False, create_constraint=True, length=20, name="ck_order_status", values_callable=enum_values))
    total: Mapped[float] = mapped_column(Double)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True))
    customer_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("customers.id"), index=True)

    lines: Mapped[list[OrderLine]] = relationship(back_populates="order", foreign_keys="OrderLine.order_id", cascade="all, delete-orphan")
    customer: Mapped[Customer] = relationship(foreign_keys="Order.customer_id")
