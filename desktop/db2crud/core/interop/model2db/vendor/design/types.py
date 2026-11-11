"""Lookups over a design. Designs are dictionaries with the keys of web/src/core/design/types.ts."""

import json

# Where the models are stored: every SQL dialect; MongoDB and Couchbase; Redis; Cassandra and ScyllaDB
STORAGE_TARGETS = ("relational", "document", "keyvalue", "widecolumn")


def per_target(value) -> dict:
    """A value for each kind of database."""
    return {target: value(target) for target in STORAGE_TARGETS}


# The field decisions, in the order the interface shows them
FIELD_DECISIONS = ("relation", "foreignKey", "unique", "wholeNumber")


def find_model_design(design: dict, model: str) -> dict | None:
    return next((item for item in design["models"] if item["model"] == model), None)


def find_field_design(design: dict, model: str, field: str) -> dict | None:
    item = find_model_design(design, model)
    return next((candidate for candidate in item["fields"] if candidate["field"] == field), None) if item else None


def same_value(a, b) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
