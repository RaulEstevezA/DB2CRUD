"""A Python generator for an ORM (Strategy of common/orm.py): every file of the project, composed from the modules
of common/ and the ORM's own database layer. Mirrors web/src/core/generators/python/common/generator.ts."""

from ....conversions.plan import plan_conversions
from .context import create_context
from .conversions import conversion_files, conversion_test_file, service_plans, tests_package
from .dtos import dtos_file
from .project import contract_file, env_example_file, gitignore_file, pyproject_file, readme_file, requirements_files
from .repositories import repository_file
from .services import service_file
from .support import errors_file, paging_file
from .tests import test_files
from .unit_of_work import unit_of_work_file


def _packages(files: list[dict], roots: list[str]) -> list[dict]:
    """Empty __init__.py files that make every folder of app/ (and of the models' module) a package."""
    folders = set()
    for file in files:
        if not any(file["path"].startswith(f"{root}/") for root in roots):
            continue
        parts = file["path"].split("/")[:-1]
        for index in range(1, len(parts) + 1):
            folders.add("/".join(parts[:index]))
    return [{"path": f"{folder}/__init__.py", "content": ""} for folder in sorted(folders)]


def _unique_roots(roots: list[str]) -> list[str]:
    return list(dict.fromkeys(roots))


def _code(context: dict) -> list[dict]:
    files = [*context["orm"]["databaseFiles"](context), errors_file(), paging_file(context), unit_of_work_file(context)]
    for info in context["tables"]:
        files.append(repository_file(context, info))
        if context["settings"]["services"] and info["service"]:
            if context["settings"]["serviceTypes"] == "dtos":
                files.append(dtos_file(context, info))
            files.append(service_file(context, info))
    return [file for file in files if file is not None]


def python_generator(orm: dict) -> dict:
    def generate(schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
        context = create_context(orm, schema, design, settings)
        app = _code(context)
        plans = service_plans(context, plan_conversions(schema, design, models)) if models else []
        if models:
            app.extend(conversion_files(context, models["schema"], plans))
        roots = _unique_roots(["app", settings["modelsModule"].split(".")[0]])
        # With imported models, the tests package takes the copy in place of the user's module when it is missing
        imports_models = bool(plans) and settings["modelsSource"] == "import"
        tests = [
            tests_package(context) if imports_models and file["path"] == "tests/__init__.py" else file
            for file in test_files(context)
        ]
        wants = settings["tests"] in ("all", "services")
        conversion_tests = conversion_test_file(context, plans) if tests and wants else None
        return [
            readme_file(context),
            pyproject_file(context),
            *requirements_files(context),
            env_example_file(context),
            gitignore_file(),
            contract_file(context),
            *app,
            *_packages(app, roots),
            *tests,
            *([conversion_tests] if conversion_tests else []),
        ]

    return {"language": "python", "orm": orm["id"], "generate": generate}
