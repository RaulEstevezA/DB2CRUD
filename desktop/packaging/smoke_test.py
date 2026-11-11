"""Checks that the packaged app works: run as `Model2API --smoke-test`.

PyInstaller only bundles what it sees imported, so a module loaded in an unusual way can be missing from the
executable even though every test passes. This opens the window, loads every example, reads a YAML document,
writes the project of every framework, saves the zip and a project, then exits with 0.
"""

import json
import sys
import tempfile
import zipfile
from pathlib import Path

from PySide6.QtCore import QEvent, QTimer


def check(window) -> None:
    from model2api.core.compatibility.stack import FRAMEWORKS
    from model2api.examples import EXAMPLES

    session = window.session
    for example in EXAMPLES:
        session.load_example(example["id"])
        assert session.design is not None, example["id"]
    for framework in FRAMEWORKS:
        session.set_settings(framework=framework["id"])
        assert session.files, framework["id"]
        assert window.project_pane.code.toPlainText().strip(), framework["id"]
    # PyYAML is imported by the parsers only when a document is read
    session.set_input({"text": "id: 1\nname: Ana\n", "format": None})
    assert session.read["format"] == "yaml"
    session.load_example("store")
    with tempfile.TemporaryDirectory() as folder:
        archive = Path(folder) / "shop-api.zip"
        window.project_pane.save_zip(str(archive))
        with zipfile.ZipFile(archive) as opened:
            assert len(opened.namelist()) == len(session.files)
        target = Path(folder) / "shop-api.model2api.json"
        window.project_bar.save_project(str(target))
        assert json.loads(target.read_text(encoding="utf-8"))["format"] == "model2api-project"


def main() -> None:
    from model2api.ui.app import create_app

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
