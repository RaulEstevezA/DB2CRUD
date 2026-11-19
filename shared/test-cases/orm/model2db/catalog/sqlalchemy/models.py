"""SQLAlchemy models written by Model2DB from Item. Review them before using them."""

from __future__ import annotations

import decimal

from sqlalchemy import BigInteger, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer(), "sqlite"), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    parent_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("categories.id"), index=True)

    parent: Mapped[Category] = relationship(remote_side="Category.id", foreign_keys="Category.parent_id")


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer(), "sqlite"), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    price: Mapped[decimal.Decimal] = mapped_column(Numeric(18, 2))
    supplier_email: Mapped[str] = mapped_column(String(255))
    stock: Mapped[int] = mapped_column(Integer)
    category_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("categories.id"), index=True)

    category: Mapped[Category] = relationship(foreign_keys="Item.category_id")
