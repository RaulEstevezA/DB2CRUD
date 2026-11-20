"""The ORM code in shared/test-cases/orm/: the desktop readers must read from every folder the schema the web version
reads (web/src/core/importers/orm/orm.test.ts checks it and writes it in expected.json)."""

import json

import pytest

from db2crud.core.importers.orm.registry import ORM_READERS, detect_orm, read_orm_code
from db2crud.core.schema.validate import validate_db_schema

from .conftest import SHARED_CASES

EXPECTED = "expected.json"
FOLDERS = sorted(path.parent for path in (SHARED_CASES / "orm").glob(f"**/{EXPECTED}"))


def _files(folder) -> list[dict]:
    paths = sorted(path for path in folder.rglob("*") if path.is_file() and path.name != EXPECTED)
    return [{"name": path.relative_to(folder).as_posix(), "text": path.read_text(encoding="utf-8")} for path in paths]


@pytest.mark.parametrize("folder", FOLDERS, ids=lambda folder: folder.relative_to(SHARED_CASES / "orm").as_posix())
def test_reads_the_same_schema(folder):
    files = _files(folder)
    # model2db/<example>/<orm>/ (or <orm>.<variant>/, read by the same reader) and hand/<orm>/<case>/
    orm = folder.parent.name if folder.parent.parent.name == "hand" else folder.name.split(".")[0]
    if orm not in {reader.id for reader in ORM_READERS}:
        pytest.skip(f"the {orm} reader is not ported to the desktop version yet")
    assert detect_orm(files).id == orm
    read = read_orm_code(files)
    assert read["ok"], read
    assert validate_db_schema(read["schema"]) == []
    assert read["schema"] == json.loads((folder / EXPECTED).read_text(encoding="utf-8"))


def test_refuses_code_it_does_not_know_and_code_with_no_table():
    assert read_orm_code([{"name": "a.py", "text": "print(1)\n"}]) == {"ok": False, "error": "unknownOrm"}
    assert read_orm_code([{"name": "a.py", "text": "from sqlalchemy import Column\n"}]) == {
        "ok": False,
        "error": "noTables",
    }
