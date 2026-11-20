"""The DDL in shared/test-cases/ddl/: the desktop reader must read from every folder the schema the web version reads
(web/src/core/importers/ddl/ddl.test.ts checks it and writes it in expected.json)."""

import json

import pytest

from db2crud.core.importers.ddl.ddl import ddl_dialect, detect_ddl, read_ddl
from db2crud.core.schema.validate import validate_db_schema

from .conftest import SHARED_CASES

EXPECTED = "expected.json"
FOLDERS = sorted(path.parent for path in (SHARED_CASES / "ddl").glob(f"**/{EXPECTED}"))


@pytest.mark.parametrize("folder", FOLDERS, ids=lambda folder: folder.relative_to(SHARED_CASES / "ddl").as_posix())
def test_reads_the_same_schema(folder):
    text = (folder / "schema.sql").read_text(encoding="utf-8")
    # model2db/<example>/<engine>/ is read for its engine, hand/<case>/ for the one it shows
    dialect = folder.name if folder.parent.parent.name == "model2db" else None
    assert detect_ddl(text) == 1
    schema = read_ddl(text, dialect)
    assert validate_db_schema(schema) == []
    assert schema == json.loads((folder / EXPECTED).read_text(encoding="utf-8"))


def test_tells_the_engine_from_what_only_it_writes():
    assert ddl_dialect("CREATE TABLE t (id SERIAL PRIMARY KEY);") == "postgresql"
    assert ddl_dialect("CREATE TABLE `t` (id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;") == "mysql"
    assert ddl_dialect("-- MariaDB dump 10.19\nCREATE TABLE `t` (id INT);") == "mariadb"
    assert ddl_dialect("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);") == "sqlite"
    assert ddl_dialect("CREATE TABLE t (id INT);") is None


def test_reads_only_text_that_creates_a_table():
    assert detect_ddl("SELECT 1;") == 0
    assert detect_ddl("create temporary table t (id int);") == 1
