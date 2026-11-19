"""SQLModel models written by Model2DB from Item. Review them before using them."""

import decimal
from typing import Optional

from sqlalchemy import BigInteger, Column, ForeignKey, Integer, Numeric, String
from sqlmodel import Field, Relationship, SQLModel


class Category(SQLModel, table=True):
    __tablename__ = "categories"

    id: int | None = Field(default=None, sa_column=Column(BigInteger().with_variant(Integer(), "sqlite"), primary_key=True))
    name: str = Field(sa_column=Column(String(80), nullable=False))
    parent_id: int = Field(sa_column=Column(BigInteger, ForeignKey("categories.id"), index=True, nullable=False))

    parent: Optional["Category"] = Relationship(sa_relationship_kwargs={"foreign_keys": "Category.parent_id", "remote_side": "Category.id"})


class Item(SQLModel, table=True):
    __tablename__ = "items"

    id: int | None = Field(default=None, sa_column=Column(BigInteger().with_variant(Integer(), "sqlite"), primary_key=True))
    name: str = Field(sa_column=Column(String(120), nullable=False))
    price: decimal.Decimal = Field(sa_column=Column(Numeric(18, 2), nullable=False))
    supplier_email: str = Field(sa_column=Column(String(255), nullable=False))
    stock: int = Field(sa_column=Column(Integer, nullable=False))
    category_id: int = Field(sa_column=Column(BigInteger, ForeignKey("categories.id"), index=True, nullable=False))

    category: Optional["Category"] = Relationship(sa_relationship_kwargs={"foreign_keys": "Item.category_id"})
