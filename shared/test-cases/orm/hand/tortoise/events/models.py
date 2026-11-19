"""Events and tickets written by hand, in the forms of Tortoise's documentation: tables named after the model, the
implicit id, an abstract base, enum fields and many-to-many tables Tortoise creates."""

from enum import Enum, IntEnum

from tortoise import fields
from tortoise.indexes import Index
from tortoise.models import Model


class Status(str, Enum):
    DRAFT = "draft"
    OPEN = "open"
    CLOSED = "closed"


class Priority(IntEnum):
    LOW = 1
    HIGH = 2


class TimestampMixin(Model):
    created_at = fields.DatetimeField(auto_now_add=True)
    modified_at = fields.DatetimeField(auto_now=True)

    class Meta:
        abstract = True


class Tournament(TimestampMixin):
    name = fields.CharField(max_length=255, unique=True)
    description = fields.TextField(null=True, description="What it is about")

    class Meta:
        table_description = "Tournaments people take part in"


class Event(TimestampMixin):
    event_id = fields.BigIntField(pk=True)
    name = fields.CharField(max_length=120, index=True)
    tournament = fields.ForeignKeyField("models.Tournament", related_name="events")
    status = fields.CharEnumField(Status, default=Status.DRAFT)
    priority = fields.IntEnumField(Priority, default=Priority.LOW)
    prize = fields.DecimalField(max_digits=10, decimal_places=2, null=True)
    participants = fields.ManyToManyField("models.Team", related_name="events", through="event_team")

    class Meta:
        table = "event"
        unique_together = (("name", "tournament"),)
        indexes = (Index(fields=("status", "created_at"), name="ix_event_status"),)


class Team(Model):
    code = fields.CharField(max_length=8, pk=True)
    name = fields.TextField()
    captain = fields.OneToOneField("models.Player", related_name="captain_of", on_delete=fields.SET_NULL, null=True)
    members = fields.ManyToManyField("models.Player", related_name="teams")


class Player(Model):
    number = fields.IntField(pk=True, generated=False)
    nick = fields.CharField(max_length=40, source_field="nickname")
    mentor = fields.ForeignKeyField("models.Player", null=True, on_delete=fields.NO_ACTION, db_index=True, related_name=False)
