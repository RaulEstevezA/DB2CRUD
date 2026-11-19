"""Reads SQLModel models: SQLAlchemy underneath, so it is the SQLAlchemy reader with SQLModel's way of declaring. A
class is a table when it says `table=True` (named by `__tablename__`, or by the class in lower case), every annotated
attribute is a column, and `Field(...)` says what `mapped_column(...)` says with other names (`foreign_key`,
`max_length`, `sa_type`, `sa_column_kwargs`), or hands over a whole `Column` in `sa_column`. Mirrors
web/src/core/importers/orm/sqlmodel.ts."""

import re

from ...js import trim
from .expressions import boolean_of, name_of, number_of, string_of
from .sqlalchemy import Flavour, read_declarative
from .types import OrmReader


def _call(name: str, args: list | None = None, named: dict | None = None) -> dict:
    return {"kind": "call", "callee": {"kind": "name", "path": [name]}, "args": args or [], "named": named or {}}


def _type_of_field(named: dict, annotation: str) -> dict | None:
    """What `Field(...)` says about the type when the annotation alone does not: a length, digits."""
    if "sa_type" in named:
        return named["sa_type"]
    python = trim(
        re.sub(r"\|\s*None|None\s*\|", "", re.sub(r"Optional\[(.*)\]", r"\1", annotation, count=1, flags=re.S))
    )
    if python == "str" and number_of(named.get("max_length")) is not None:
        return _call("String", [named["max_length"]])
    if re.fullmatch(r"(decimal\.)?Decimal", python) and number_of(named.get("max_digits")) is not None:
        return _call(
            "Numeric", [named["max_digits"], *([named["decimal_places"]] if "decimal_places" in named else [])]
        )
    return None


def _default_of(field: dict) -> dict | None:
    """The value the application gives an attribute left out: `default` or `default_factory`. `default=None` only
    says the attribute may be left out."""
    named = field["named"]
    value = named["default"] if "default" in named else named.get("default_factory")
    return None if value is None or (value["kind"] == "name" and ".".join(value["path"]) == "None") else value


def _field_as_column(field: dict, annotation: str) -> dict:
    """`Field(...)` as the `mapped_column(...)` that says the same."""
    named = field["named"]
    args: list = []
    field_type = _type_of_field(named, annotation)
    if field_type is not None:
        args.append(field_type)
    reference = string_of(named.get("foreign_key"))
    if reference is not None:
        options = {"ondelete": named["ondelete"]} if "ondelete" in named else {}
        args.append(_call("ForeignKey", [{"kind": "string", "value": reference}], options))
    column: dict = {key: named[key] for key in ("primary_key", "nullable", "unique", "index") if key in named}
    value = _default_of(field)
    if value is not None:
        column["default"] = value
    extra = named.get("sa_column_kwargs")
    if extra is not None and extra["kind"] == "dict":
        for entry in extra["entries"]:
            key = string_of(entry["key"])
            if key:
                column[key] = entry["value"]
    return _call("mapped_column", args, column)


def _is_class_var(annotation: str) -> bool:
    return re.match(r"\s*(typing\.)?ClassVar\b", annotation) is not None


def _table_of(definition: dict, tablename: str | None) -> str | None:
    if boolean_of(definition["keywords"].get("table")) is not True:
        return None
    return tablename if tablename is not None else definition["name"].lower()


def _column_of(value: dict | None, annotation: str) -> dict | None:
    # Every annotated attribute is a column, except relationships and class variables
    if not annotation or _is_class_var(annotation) or name_of(value) == "Relationship":
        return None
    if value is not None and value["kind"] == "call" and name_of(value) == "Field":
        column = value["named"].get("sa_column")
        # A whole Column: SQLModel uses it as it is, with the default of the Field when it has none
        if column is not None and column["kind"] == "call" and name_of(column) == "Column":
            field_default = _default_of(value)
            if field_default is not None and "default" not in column["named"]:
                column = {**column, "named": {**column["named"], "default": field_default}}
            return {"call": column, "classic": True, "annotation": ""}
        return {"call": _field_as_column(value, annotation), "classic": False, "annotation": annotation}
    field = _call("Field") if value is None else _call("Field", [], {"default": value})
    return {"call": _field_as_column(field, annotation), "classic": False, "annotation": annotation}


def _relationship_of(value: dict | None) -> dict | None:
    if value is None or value["kind"] != "call" or name_of(value) != "Relationship" or "link_model" in value["named"]:
        return None
    options = value["named"].get("sa_relationship_kwargs")
    foreign_keys = None
    if options is not None and options["kind"] == "dict":
        foreign_keys = next(
            (entry["value"] for entry in options["entries"] if string_of(entry["key"]) == "foreign_keys"), None
        )
    return {"call": value, **({"foreignKeys": foreign_keys} if foreign_keys is not None else {})}


_SQLMODEL = Flavour(format="sqlmodel", table_of=_table_of, column_of=_column_of, relationship_of=_relationship_of)


def _detect(files: list[dict]) -> float:
    text = "\n".join(file["text"] for file in files)
    return 1 if re.search(r"\b(from|import)\s+sqlmodel\b", text) else 0


SQLMODEL_READER = OrmReader(
    id="sqlmodel",
    label="SQLModel",
    language="python",
    detect=_detect,
    read=lambda files: read_declarative(files, _SQLMODEL),
)
