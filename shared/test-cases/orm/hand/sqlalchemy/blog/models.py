"""A blog written by hand, in the forms people use: classic Column, typed mapped_column, table arguments, an
association table, a native enum and defaults the database applies."""

import enum
import uuid
from datetime import datetime
from decimal import Decimal
from typing import List, Optional

import sqlalchemy as sa
from sqlalchemy import (
    CheckConstraint,
    Column,
    Computed,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    PrimaryKeyConstraint,
    String,
    Table,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Role(str, enum.Enum):
    READER = "reader"
    AUTHOR = "author"
    ADMIN = "admin"


class Visibility(enum.Enum):
    PUBLIC = 1
    PRIVATE = 2


post_tags = Table(
    "post_tags",
    Base.metadata,
    Column("post_id", ForeignKey("blog.posts.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_name", String(40), ForeignKey("blog.tags.name", onupdate="CASCADE"), primary_key=True),
    schema="blog",
)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("email", name="uq_users_email"),
        CheckConstraint("char_length(nick) >= 3", name="ck_users_nickname"),
        {"schema": "blog", "comment": "People who write or read"},
    )

    id = Column(Integer, primary_key=True)
    email = Column(String(200), nullable=False)
    nickname = Column("nick", String(30), nullable=False, comment="Shown next to posts")
    role = Column(sa.Enum(Role, name="user_role"), nullable=False, server_default="READER")
    created = Column(sa.DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated = Column(sa.DateTime(timezone=True), onupdate=func.now())

    posts = relationship("Post", back_populates="author")


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = {"schema": "blog"}

    name: Mapped[str] = mapped_column(String(40), primary_key=True)
    color: Mapped[Optional[str]] = mapped_column(sa.CHAR(7))


class Post(Base):
    __tablename__ = "posts"
    __table_args__ = (
        Index("ix_posts_author_published", "author_id", "published_at"),
        CheckConstraint("score >= 0"),
        {"schema": "blog"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    author_id: Mapped[int] = mapped_column(ForeignKey("blog.users.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(160))
    slug: Mapped[str] = mapped_column(String(160), unique=True)
    body: Mapped[str] = mapped_column(sa.Text)
    score: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0)
    visibility: Mapped[Visibility] = mapped_column(
        sa.Enum(Visibility, native_enum=False, create_constraint=True, length=10), default=Visibility.PUBLIC
    )
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, server_default=text("'{}'::jsonb"))
    published_at: Mapped[datetime | None]
    words: Mapped[int] = mapped_column(Computed("length(body) / 5"))
    pinned: Mapped[bool] = mapped_column(server_default=sa.false())

    author: Mapped[Optional["User"]] = relationship(back_populates="posts")
    tags: Mapped[List["Tag"]] = relationship(secondary=post_tags)


class Revision(Base):
    __tablename__ = "revisions"
    __table_args__ = (
        PrimaryKeyConstraint("post_id", "number"),
        ForeignKeyConstraint(["post_id"], ["blog.posts.id"], ondelete="CASCADE", name="fk_revisions_post"),
        {"schema": "blog"},
    )

    post_id: Mapped[uuid.UUID] = mapped_column(sa.Uuid)
    number: Mapped[int] = mapped_column(sa.SmallInteger)
    body: Mapped[str] = mapped_column(sa.Text)
    saved_at: Mapped[datetime] = mapped_column(server_default=sa.text("CURRENT_TIMESTAMP"))
    tags: Mapped[list[str]] = mapped_column(sa.ARRAY(String(40)), server_default="{}")


Index("ix_revisions_saved", Revision.saved_at.desc())
