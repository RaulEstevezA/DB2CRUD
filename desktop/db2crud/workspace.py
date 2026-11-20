"""Workspace logic the window uses, kept out of the widgets so it can be tested: reading the database input and
counting what was read. Mirrors web/src/app/workspace.ts, and adds what only the desktop version does: an input of
several files, opened together or gathered from a folder (the web version reads one text; see docs/decisions.md).

An input is {"text", "fileName"?} or, with several files, {"text", "files": [{"name", "text"}], "selected"}: then
"text" is the text of the file selected, the one the editor shows. A read is {"ok": True, "schema"} or {"ok": False,
"error", "path"?}.
"""

import os
from pathlib import Path

from .core.importers.ddl.ddl import detect_ddl, read_ddl
from .core.importers.orm.registry import ORM_READERS, detect_orm, read_orm_code
from .core.importers.registry import accepted_extensions, detect_format, find_parser, parse_input
from .core.interop.mapper.read import is_mapper_project, mapper_models, read_mapper_project
from .core.interop.model2db.read import read_model2db_project
from .core.js import coalesce, trim, trim_start

EMPTY_INPUT = {"text": ""}


def _read_text(text: str, name: str) -> dict | None:
    """One text: a Model2DB project when it is JSON; else ORM code, or else SQL DDL."""
    if trim(text) == "":
        return None
    if trim(text).startswith("{"):
        return read_model2db_project(text)
    return _read_files([{"name": name, "text": text}])


def _read_files(files: list[dict]) -> dict:
    """Several files: the code of one ORM (with the SQL of its migrations), or else SQL DDL."""
    read = read_orm_code(files)
    if read["ok"]:
        return {"ok": True, "schema": read["schema"]}
    # The DDL: every SQL file once one of them creates a table, and any other text that does
    creates = [file for file in files if detect_ddl(file["text"])]
    sql = [file for file in files if file in creates or file["name"].lower().endswith(".sql")]
    if read["error"] == "unknownOrm" and creates:
        ordered = sorted(sql, key=lambda file: file["name"])
        schema = read_ddl(";\n".join(file["text"] for file in ordered))
        return {"ok": True, "schema": schema} if schema["tables"] else {"ok": False, "error": "noTables"}
    return {"ok": False, "error": "unknownInput" if read["error"] == "unknownOrm" else read["error"]}


def read_database(state: dict) -> dict | None:
    """The physical schema of the input, or why it cannot be read; None while the input is empty. A JSON text is a
    Model2DB project; anything else is ORM code, or else SQL DDL. Several files are read together."""
    files = state.get("files")
    if files:
        written = [file for file in files if trim(file["text"]) != ""]
        if not written:
            return None
        if len(written) == 1:
            return _read_text(written[0]["text"], written[0]["name"])
        return _read_files(written)
    return _read_text(state["text"], coalesce(state.get("fileName"), "input"))


# The language of each extension, for the highlighting of the file shown
_EXTENSIONS = {
    ".py": "python",
    ".ts": "typescript",
    ".js": "typescript",
    ".mjs": "typescript",
    ".java": "java",
    ".cs": "csharp",
    ".php": "php",
    ".prisma": "prisma",
    ".sql": "sql",
    ".json": "json",
}


def input_language(state: dict) -> str:
    """The language of the input, for the editor's highlighting: JSON for a project, the ORM's for its code, SQL for
    DDL; with several files, the language of the file shown."""
    files = state.get("files")
    if files:
        selected = files[state.get("selected", 0)] if state.get("selected", 0) < len(files) else files[0]
        language = _EXTENSIONS.get(Path(selected["name"]).suffix.lower())
        if language:
            return language
    text = trim_start(state["text"])
    if text == "" or text.startswith("{"):
        return "json"
    reader = detect_orm([{"name": coalesce(state.get("fileName"), "input"), "text": state["text"]}])
    if reader:
        return reader.language
    return "sql" if detect_ddl(state["text"]) else "text"


def source_label(schema: dict) -> str:
    """What the schema was read from, for the summary: `Model2DB (prisma)`, `SQLAlchemy`, `SQL DDL`."""
    kind, form = schema["source"]["kind"], schema["source"]["format"]
    if kind == "model2db":
        return f"Model2DB ({form})"
    if kind == "ddl":
        return "SQL DDL"
    return next((reader.label for reader in ORM_READERS if reader.id == form), form)


def column_count(schema: dict) -> int:
    """Count of columns in every table."""
    return sum(len(table["columns"]) for table in schema["tables"])


# Application models


def read_models(state: dict) -> dict | None:
    """The application models of their input (classes, DTOs, JSON, schemas…), or why they cannot be read: {"ok": True,
    "schema", "format", "project"?} or {"ok": False, "error"}; None while it is empty. They are optional: without them
    the services work with the entities. A Mapper project brings the models of both its sides and its relations
    (`project`), which the matching follows."""
    if trim(state["text"]) == "":
        return None
    if is_mapper_project(state["text"]):
        project = read_mapper_project(state["text"])
        if not project["ok"]:
            error = f"{project['error']} {project['path']}" if project.get("path") else project["error"]
            return {"ok": False, "error": error}
        return {
            "ok": True,
            "schema": mapper_models(project["project"]),
            "format": "Mapper",
            "project": project["project"],
        }
    format_id = detect_format(state["text"], state.get("fileName"))
    if not format_id:
        return {"ok": False, "error": "unknownFormat"}
    read = parse_input(state["text"], format_id, {"rootName": "Root"})
    if not read["ok"]:
        return {"ok": False, "error": read["error"]["code"]}
    if not read["schema"]["models"]:
        return {"ok": False, "error": "noModels"}
    parser = find_parser(format_id)
    return {"ok": True, "schema": read["schema"], "format": parser.label if parser else format_id}


def models_language(state: dict) -> str:
    """The highlighting of the models input: the language of their format."""
    if is_mapper_project(state["text"]):
        return "json"
    format_id = detect_format(state["text"], state.get("fileName")) if trim(state["text"]) != "" else None
    parser = find_parser(format_id) if format_id else None
    return parser.editor_language if parser else "text"


def model_extensions() -> list[str]:
    """The extensions the models input opens."""
    return accepted_extensions()


# Gathering the files of a project

# What the readers read: code of the ORMs, SQL, and the configuration that names the engine
READABLE = {
    ".py",
    ".ts",
    ".js",
    ".mjs",
    ".java",
    ".cs",
    ".php",
    ".prisma",
    ".sql",
    ".json",
    ".properties",
    ".yml",
    ".yaml",
}
READABLE_NAMES = {".env"}
# Folders of dependencies, builds and tools: never the project's own code
SKIPPED = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    ".gradle",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "out",
    "target",
    "bin",
    "obj",
    "coverage",
    "storage",
    "generated",
}
MAX_FILES = 2000
MAX_SIZE = 20 * 1024 * 1024


class TooManyFiles(Exception):
    """The folder holds more than MAX_FILES files to read, or more than MAX_SIZE bytes of them."""


def gather_files(paths: list[str]) -> list[dict]:
    """The files to read among these paths: files as they are, and the readable files of each folder (its
    dependencies and builds left out), named by their path inside the folder. Raises TooManyFiles past the limits;
    files that cannot be read as text are left out."""
    found: list[tuple[str, Path]] = []
    for given in paths:
        path = Path(given)
        if path.is_dir():
            for root, folders, names in os.walk(path):
                folders[:] = sorted(folder for folder in folders if folder not in SKIPPED)
                for name in sorted(names):
                    file = Path(root) / name
                    if file.suffix.lower() in READABLE or name in READABLE_NAMES:
                        found.append((file.relative_to(path).as_posix(), file))
        elif path.is_file():
            found.append((path.name, path))
        if len(found) > MAX_FILES:
            raise TooManyFiles
    files: list[dict] = []
    total = 0
    for name, file in found:
        try:
            total += file.stat().st_size
            if total > MAX_SIZE:
                raise TooManyFiles
            files.append({"name": name, "text": file.read_text(encoding="utf-8-sig")})
        except (OSError, UnicodeDecodeError):
            continue
    return files
