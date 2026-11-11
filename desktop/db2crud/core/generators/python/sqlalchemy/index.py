"""Python + SQLAlchemy 2 generator. Mirrors web/src/core/generators/python/sqlalchemy/index.ts."""

from .context import create_context
from .database import db_file, entity_files
from .dtos import dtos_file
from .project import contract_file, env_example_file, gitignore_file, pyproject_file, readme_file, requirements_files
from .repositories import repository_file
from .services import service_file
from .support import errors_file, paging_file
from .tests import test_files
from .unit_of_work import unit_of_work_file


def _packages(files: list[dict]) -> list[dict]:
    """Empty __init__.py files that make every folder of app/ a package."""
    folders = set()
    for file in files:
        if not file["path"].startswith("app/"):
            continue
        parts = file["path"].split("/")[:-1]
        for index in range(1, len(parts) + 1):
            folders.add("/".join(parts[:index]))
    return [{"path": f"{folder}/__init__.py", "content": ""} for folder in sorted(folders)]


def _code(context: dict) -> list[dict]:
    files = [db_file(context), errors_file(), paging_file(context), unit_of_work_file(context), *entity_files(context)]
    for info in context["tables"]:
        files.append(repository_file(context, info))
        if context["settings"]["services"] and info["service"]:
            if context["settings"]["serviceTypes"] == "dtos":
                files.append(dtos_file(context, info))
            files.append(service_file(context, info))
    return [file for file in files if file is not None]


def generate(schema: dict, design: dict, settings: dict) -> list[dict]:
    context = create_context(schema, design, settings)
    app = _code(context)
    return [
        readme_file(context),
        pyproject_file(context),
        *requirements_files(context),
        env_example_file(context),
        gitignore_file(),
        contract_file(context),
        *app,
        *_packages(app),
        *test_files(context),
    ]


SQLALCHEMY_GENERATOR = {"language": "python", "orm": "sqlalchemy", "generate": generate}
