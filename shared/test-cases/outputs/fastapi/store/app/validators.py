"""Base schema and validators shared by every request and response schema."""

from datetime import UTC, date, datetime, time
from decimal import Decimal
from typing import Annotated, Any, ClassVar
from uuid import UUID

from pydantic import AfterValidator, AnyUrl, BaseModel, ConfigDict, PlainSerializer, field_validator, model_validator


class ApiModel(BaseModel):
    """Base of every schema: fields are read by their JSON name or their Python name, unknown fields
    are rejected, bytes travel as base64, and fields listed in `non_nullable` may be left out but never
    sent as null."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid", ser_json_bytes="base64", val_json_bytes="base64")

    non_nullable: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="after")
    def reject_null(self) -> "ApiModel":
        for name in self.non_nullable & self.model_fields_set:
            if getattr(self, name) is None:
                alias = type(self).model_fields[name].alias or name
                raise ValueError(f"{alias} cannot be null")
        return self


class ResponseModel(BaseModel):
    """Base of response schemas: built from stored values, which may hold more fields than the API shows."""

    model_config = ConfigDict(populate_by_name=True, from_attributes=True, ser_json_bytes="base64", val_json_bytes="base64")

    @field_validator("*", mode="after")
    @classmethod
    def utc(cls, value: Any) -> Any:
        """Dates stored without a time zone (SQLite keeps none) were stored in UTC: every database answers alike."""
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


def _check_url(value: str) -> str:
    AnyUrl(value)
    return value


def _check_uuid(value: str) -> str:
    return str(UUID(value))


def _check_date(value: str) -> str:
    date.fromisoformat(value)
    return value


def _check_datetime(value: str) -> str:
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


def _check_time(value: str) -> str:
    time.fromisoformat(value)
    return value


# Texts with a format, kept as text after the check
UrlText = Annotated[str, AfterValidator(_check_url)]
UuidText = Annotated[str, AfterValidator(_check_uuid)]
DateText = Annotated[str, AfterValidator(_check_date)]
DateTimeText = Annotated[str, AfterValidator(_check_datetime)]
TimeText = Annotated[str, AfterValidator(_check_time)]

# Exact numbers travel as JSON numbers, as the OpenAPI contract describes them
DecimalNumber = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]

# Free JSON values
JsonValue = Any
