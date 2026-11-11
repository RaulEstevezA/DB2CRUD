"""The zip of a project: readable by any zip tool, and the same bytes for the same files."""

import io
import zipfile

from db2crud.core.export.zip import create_zip


def test_zip_holds_the_files():
    files = [
        {"name": "shop-api/README.md", "content": "# Shop\n"},
        {"name": "shop-api/app/ñandú.py", "content": "x = 1\n"},
    ]
    archive = zipfile.ZipFile(io.BytesIO(create_zip(files)))
    assert archive.namelist() == ["shop-api/README.md", "shop-api/app/ñandú.py"]
    assert archive.read("shop-api/app/ñandú.py").decode() == "x = 1\n"
    assert archive.testzip() is None


def test_zip_does_not_depend_on_when_it_is_made():
    files = [{"name": "a.txt", "content": "a"}]
    assert create_zip(files) == create_zip(files)
