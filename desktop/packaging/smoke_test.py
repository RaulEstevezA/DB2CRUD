"""Checks that the packaged app works: run as `DB2CRUD --smoke-test`.

PyInstaller only bundles what it sees imported, so a module loaded in an unusual way can be missing from the
executable even though every test passes. This opens the window, loads every example and reads a YAML document,
then exits with 0.
"""

import sys

from PySide6.QtCore import QEvent, QTimer


def check(window) -> None:
    from db2crud.examples import EXAMPLES

    session = window.session
    for example in EXAMPLES:
        session.load_example(example["id"])
        assert session.schema is not None, example["id"]
    # PyYAML is imported by the parsers only when a document is read
    session.set_input({"text": "id: 1\nname: Ana\n", "format": None})
    assert session.read["format"] == "yaml"


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
