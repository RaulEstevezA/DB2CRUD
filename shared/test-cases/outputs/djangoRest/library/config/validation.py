"""Base serializer and validators shared by every serializer."""

from typing import Any

from rest_framework import serializers


class StrictSerializer(serializers.Serializer):
    """Rejects fields the client may not send, as openapi.yaml does."""

    def to_internal_value(self, data: Any) -> Any:
        if isinstance(data, dict):
            accepted = {name for name, field in self.fields.items() if not field.read_only}
            unknown = sorted(set(data) - accepted)
            if unknown:
                raise serializers.ValidationError({name: ["This field is not accepted."] for name in unknown})
        return super().to_internal_value(data)


def greater_than(limit: float):  # type: ignore[no-untyped-def]
    """A value must be greater than `limit`."""

    def check(value: float) -> None:
        if value <= limit:
            raise serializers.ValidationError(f"Ensure this value is greater than {limit}.")

    return check


def less_than(limit: float):  # type: ignore[no-untyped-def]
    """A value must be less than `limit`."""

    def check(value: float) -> None:
        if value >= limit:
            raise serializers.ValidationError(f"Ensure this value is less than {limit}.")

    return check
