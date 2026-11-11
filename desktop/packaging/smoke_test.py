"""Checks that the packaged app works: run as `DB2CRUD --smoke-test`.

PyInstaller only bundles what it sees imported, so a module loaded in an unusual way can be missing from the
executable even though every test passes. This opens the window, loads every example, reads a Model2DB project
written in YAML and saves a project as a .zip, then exits with 0.
"""

import sys

from PySide6.QtCore import QEvent, QTimer


def check(window) -> None:
    import json
    import tempfile
    import zipfile
    from pathlib import Path

    from db2crud.examples import EXAMPLES

    session = window.session
    for example in EXAMPLES:
        session.load_example(example["id"])
        assert session.design is not None and session.files, example["id"]
    # A Model2DB project whose models are YAML: PyYAML is imported by the parsers only when one is read
    project = json.loads(EXAMPLES[0]["text"])
    project["input"] = {"format": "yaml", "text": "id: 1\nname: Ana\n"}
    session.set_input({"text": json.dumps(project)})
    assert session.read["ok"], session.read
    with tempfile.TemporaryDirectory() as folder:
        archive = Path(folder) / "project.zip"
        window.project_pane.save_zip(str(archive))
        with zipfile.ZipFile(archive) as opened:
            assert len(opened.namelist()) == len(session.files)


def main() -> None:
    from db2crud.ui.app import create_app

    app, window = create_app([])
    window.show()

    def run() -> None:
        try:
            check(window)
        except Exception as error:
            print(f"Smoke test failed: {error!r}", file=sys.stderr, flush=True)
            app.exit(1)
        else:
            print("Smoke test passed", flush=True)
            app.exit(0)

    QTimer.singleShot(0, run)
    code = app.exec()
    # Deleted now, not when the process ends, so pending deletions never meet a window already gone
    # (on Linux that crashes the process after the test has passed)
    window.close()
    window.deleteLater()
    app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    app.processEvents()
    sys.exit(code)
