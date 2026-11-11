# DB2CRUD · Desktop

Desktop version of DB2CRUD: Python + PySide6.

It does the same as the web version, on your computer and without a browser: it passes the same test cases from [`shared/test-cases/`](../shared/README.md) and reads models exactly the same way.

What the tool does and its philosophy are in the [main README](../README_en.md).

## Download

| System | File |
|---|---|
| macOS (Apple Silicon) | [DB2CRUD-macOS.dmg](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-macOS.dmg) |
| Windows (x64) | [DB2CRUD-Windows.zip](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-Windows.zip) |
| Windows (ARM64) | [DB2CRUD-Windows-ARM64.zip](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-Windows-ARM64.zip) |
| Linux (x64) | [DB2CRUD-Linux.tar.gz](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-Linux.tar.gz) |
| Linux (ARM64, Ubuntu 24.04 or newer) | [DB2CRUD-Linux-ARM64.tar.gz](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-Linux-ARM64.tar.gz) |

Every version is in [Releases](https://github.com/RaulEstevezA/DB2CRUD/releases). The links work once the first version is released.

> [!NOTE]
> The packaged app has been built and checked on **macOS** (Apple Silicon). The Windows and Linux builds are compiled by GitHub Actions and pass the tests and an automatic start-up check, but nobody has used them on a real computer yet. If you find a problem, write to [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

- **macOS:** open the `.dmg` and drag DB2CRUD to Applications.
- **Windows:** unzip the `.zip` and run `DB2CRUD.exe` inside the `DB2CRUD` folder.
- **Linux:** extract with `tar -xzf DB2CRUD-Linux.tar.gz` (or `DB2CRUD-Linux-ARM64.tar.gz`) and run `DB2CRUD/DB2CRUD`. Some distributions need `libxcb-cursor0`. The ARM64 version needs a 2024 or newer distribution (glibc 2.39, like Ubuntu 24.04).

### Opening it the first time

The app is not signed (signing requires paid Apple and Microsoft accounts), so the system shows a warning the first time it is opened:

- **macOS** says it could not verify that the app is free of malware. Click **Done**, go to **System Settings → Privacy & Security**, scroll down to **Security** and click **Open Anyway**. This is only needed once.
- **Windows** shows "Windows protected your PC". Click **More info** and then **Run anyway**.

The code is the one in this repository, and the files are built by GitHub Actions ([workflow](../.github/workflows/release-desktop.yml)).

## Differences with the web version

- It works without going online: there are no links to the other tools.

## Run locally

Requirements: Python 3.11 or newer.

```bash
cd desktop
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python -m pytest                   # tests (shared cases from shared/test-cases/)
ruff check .                       # static analysis
python -m db2crud                 # run the application
```

## Build the executable

```bash
pip install -e ".[build]"
pyinstaller packaging/db2crud.spec
dist/DB2CRUD.app/Contents/MacOS/DB2CRUD --smoke-test   # macOS; dist/DB2CRUD/DB2CRUD elsewhere
```

The result is in `dist/`: `DB2CRUD.app` on macOS and a `DB2CRUD` folder with the executable on Windows and Linux. PyInstaller does not cross-compile: each system is built on its own operating system. `--smoke-test` opens the window, loads every example and reads a YAML document, to check that nothing was left out of the package.

## Structure

```
db2crud/
  core/          The same logic as web/src/core/, module by module: model, importers, analysis, decisions and export
  ui/            The window (PySide6): models pane, texts and theme
  workspace.py   Reading the input, as web/src/app/workspace.ts
  examples.py    The built-in examples, the same as web/src/examples/
packaging/       PyInstaller spec, launcher, smoke test and icons
tests/           Shared cases (calls), export and the window
```

## Developer

**Raul Estevez**

- [Personal Website](https://raulesteveza.github.io/)
- [LinkedIn Profile](https://www.linkedin.com/in/raulesteveza/)

## License

[MIT](../LICENSE)
