"""FastAPI generator: writes a Python project with FastAPI, Pydantic 2 and, when chosen, SQLAlchemy 2. It composes
the modules of this folder; each writes one kind of file. Mirrors web/src/core/generators/frameworks/fastapi/index.ts.
"""

from .app import config_file, database_file, dependencies_file, errors_file, main_file, security_file
from .context import create_context
from .persistence import model_file, repository_file
from .project import env_example_file, gitignore_file, pyproject_file, readme_file, requirements_files
from .routes import router_file, service_file
from .schemas import resource_schemas_file, shared_schemas_file, validators_file
from .tests import test_files


def _packages(files: list[dict]) -> list[dict]:
    """Empty __init__.py files that make every folder of app/ a package."""
    folders: dict[str, None] = {}
    for file in files:
        if not file["path"].startswith("app/"):
            continue
        parts = file["path"].split("/")[:-1]
        for index in range(1, len(parts) + 1):
            folders["/".join(parts[:index])] = None
    return [{"path": f"{folder}/__init__.py", "content": ""} for folder in folders]


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    app = [
        main_file(context),
        config_file(context),
        errors_file(context),
        validators_file(),
        security_file(context),
        database_file(context),
        dependencies_file(context),
        shared_schemas_file(context),
    ]
    for resource in spec["resources"]:
        app.extend(
            [
                resource_schemas_file(context, resource),
                model_file(context, resource),
                repository_file(context, resource),
                service_file(context, resource),
                router_file(context, resource),
            ]
        )
    code = [file for file in app if file is not None]
    return [
        readme_file(context),
        *requirements_files(context),
        pyproject_file(context),
        env_example_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        *code,
        *_packages(code),
        *test_files(context),
    ]


FASTAPI_GENERATOR = {"framework": "fastapi", "serverUrl": "http://localhost:8000", "generate": _generate}
