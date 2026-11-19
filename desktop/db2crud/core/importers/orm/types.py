"""What a reader of ORM code is: it says how likely some files are code of its ORM, and reads them into the
physical schema (`db-schema`). Each ORM has its own reader (Strategy pattern); the registry chooses one. Mirrors
web/src/core/importers/orm/types.ts.

A source file is {"name", "text"}: several when the ORM writes a class per file (JPA, Doctrine, Eloquent)."""

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class OrmReader:
    # The ORM, as the settings name it: `sqlalchemy`
    id: str
    label: str
    # The language of the code, for the editor's highlighting: `python`
    language: str
    # How likely these files are code of this ORM, from 0 to 1
    detect: Callable[[list[dict]], float]
    # The tables the code declares; what it does not understand goes to the notes
    read: Callable[[list[dict]], dict]
