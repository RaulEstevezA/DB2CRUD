"""Heroes and teams, in the forms the SQLModel tutorial uses: base models shared with the API, tables that inherit
their fields, a link table, and Field options instead of columns."""

import uuid
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import ClassVar, Optional

from sqlalchemy import CheckConstraint, Column, DateTime, UniqueConstraint, func
from sqlmodel import JSON, Field, Relationship, SQLModel


class Power(str, Enum):
    FLIGHT = "flight"
    STRENGTH = "strength"
    SPEED = "speed"


class TimestampMixin(SQLModel):
    created_at: datetime = Field(sa_column_kwargs={"server_default": func.now()})
    updated_at: Optional[datetime] = Field(default=None, sa_column_kwargs={"onupdate": func.now()})


class HeroTeamLink(SQLModel, table=True):
    team_id: int | None = Field(default=None, foreign_key="team.id", primary_key=True, ondelete="CASCADE")
    hero_id: int | None = Field(default=None, foreign_key="hero.id", primary_key=True, ondelete="CASCADE")


class TeamBase(SQLModel):
    name: str = Field(max_length=60, index=True)
    headquarters: str


class Team(TeamBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    budget: Decimal = Field(default=0, max_digits=12, decimal_places=2)

    heroes: list["Hero"] = Relationship(back_populates="teams", link_model=HeroTeamLink)


class HeroBase(SQLModel):
    name: str = Field(index=True)
    secret_name: str
    age: int | None = Field(default=None, index=True)


class Hero(HeroBase, TimestampMixin, table=True):
    __tablename__ = "hero"
    __table_args__ = (
        UniqueConstraint("name", "secret_name"),
        CheckConstraint("age >= 0", name="ck_hero_age"),
    )

    registry: ClassVar[dict] = {}

    id: int | None = Field(default=None, primary_key=True)
    code: uuid.UUID = Field(default_factory=uuid.uuid4, unique=True)
    power: Power = Power.STRENGTH
    rating: float = 0.5
    profile: dict = Field(default_factory=dict, sa_type=JSON)
    mentor_id: int | None = Field(default=None, foreign_key="hero.id", ondelete="SET NULL")
    retired_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True), nullable=True))

    teams: list["Team"] = Relationship(back_populates="heroes", link_model=HeroTeamLink)
    mentor: Optional["Hero"] = Relationship(sa_relationship_kwargs={"remote_side": "Hero.id"})


class HeroPublic(HeroBase):
    id: int
