"""The readers of ORM code, and the choice of one for the files given: each reader says how sure it is that the
files are its ORM's, and the surest one reads them. A reader never fails on code it does not understand: it keeps
what it can and leaves notes; only code with no table at all is refused. Mirrors
web/src/core/importers/orm/registry.ts.

A result is {"ok": True, "schema", "reader"} or {"ok": False, "error": "unknownOrm" | "noTables"}."""

from .django import DJANGO_READER
from .doctrine import DOCTRINE_READER
from .drizzle import DRIZZLE_READER
from .efcore import EFCORE_READER
from .eloquent import ELOQUENT_READER
from .jpa import JPA_READER
from .prisma import PRISMA_READER
from .sequelize import SEQUELIZE_READER
from .sqlalchemy import SQLALCHEMY_READER
from .sqlmodel import SQLMODEL_READER
from .tortoise import TORTOISE_READER
from .typeorm import TYPEORM_READER
from .types import OrmReader

ORM_READERS: list[OrmReader] = [
    SQLALCHEMY_READER,
    SQLMODEL_READER,
    DJANGO_READER,
    TORTOISE_READER,
    PRISMA_READER,
    TYPEORM_READER,
    SEQUELIZE_READER,
    DRIZZLE_READER,
    JPA_READER,
    EFCORE_READER,
    DOCTRINE_READER,
    ELOQUENT_READER,
]


def detect_orm(files: list[dict]) -> OrmReader | None:
    """The reader for these files, or None when none recognises them."""
    best = None
    score = 0
    for reader in ORM_READERS:
        found = reader.detect(files)
        if found > score:
            best = reader
            score = found
    return best


def read_orm_code(files: list[dict]) -> dict:
    """The schema the ORM code of these files declares."""
    reader = detect_orm(files)
    if not reader:
        return {"ok": False, "error": "unknownOrm"}
    schema = reader.read(files)
    if not schema["tables"]:
        return {"ok": False, "error": "noTables"}
    return {"ok": True, "schema": schema, "reader": reader}
